// Page fetch for the crawler (Ticket 33 — the audit's "missing pieces").
//
// Reuses the same Playwright + per-hostname saved-session pattern as the job
// crawler's discovery/scrapeAll.ts + integrations/site_sessions.ts (a
// processor site behind a soft login/geo wall resolves a saved storageState
// the same way, degrading to unauthenticated when none exists). What the
// Ticket 33 audit flagged as MISSING from that pattern and is added here:
//
//   1. Retry with exponential backoff — scrapeAll.ts fetched exactly once and
//      let any transient failure (timeout, 5xx, flaky nav) abort. Here each
//      page is retried with growing backoff before giving up.
//   2. Per-host rate limiting / politeness delay — scrapeAll.ts hit a site as
//      fast as the loop ran. Here requests to the same hostname are spaced by
//      a configurable minimum delay so we don't hammer one processor's site.
//
// Politeness note: this crawler is expected to honour robots.txt and sensible
// crawl-delay in a live deployment. That check is NOT implemented here (it
// needs a live robots.txt fetch + parser, out of scope for this greenfield
// compile-only pass) — see the FOLLOW-UPS in docs/payment-processor-crawler.md.
// The per-host delay below is the politeness floor we ship with today; treat
// perHostDelayMs as the crawl-delay knob until robots parsing lands.
import { chromium } from "playwright";
import { resolveStorageState, type SiteSessionsConfig } from "../integrations/site_sessions.js";
import { logger } from "../logging.js";

export interface FetchConfig {
  // Per-hostname Playwright storage-state directory, exactly as scrapeAll
  // uses it — optional, degrades to unauthenticated when absent.
  siteSessions?: SiteSessionsConfig;
  // Minimum ms between two requests to the SAME hostname (politeness).
  perHostDelayMs: number;
  // How many times to attempt a page before giving up (>=1).
  maxAttempts?: number;
  // Base backoff in ms; attempt N waits ~baseBackoffMs * 2^(N-1) (+jitter).
  baseBackoffMs?: number;
  // Per-navigation timeout in ms.
  navTimeoutMs?: number;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  html: string;
  status: number | null;
}

const DEFAULTS = { maxAttempts: 3, baseBackoffMs: 500, navTimeoutMs: 20_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tracks the last request time per hostname so the politeness delay is
// enforced ACROSS calls, not just within one. A single crawl run shares one
// PageFetcher instance, so this map is the run's rate-limit state.
export class PageFetcher {
  private readonly config: Required<Omit<FetchConfig, "siteSessions">> & Pick<FetchConfig, "siteSessions">;
  private readonly lastRequestAt = new Map<string, number>();

  constructor(config: FetchConfig) {
    this.config = {
      siteSessions: config.siteSessions,
      perHostDelayMs: config.perHostDelayMs,
      maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
      baseBackoffMs: config.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      navTimeoutMs: config.navTimeoutMs ?? DEFAULTS.navTimeoutMs,
    };
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  // Block until this hostname's politeness window has elapsed, then reserve
  // the slot. Serializes same-host requests behind the delay without
  // throttling requests to other hosts.
  private async awaitHostSlot(host: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + this.config.perHostDelayMs - now;
      if (wait > 0) await sleep(wait);
    }
    this.lastRequestAt.set(host, Date.now());
  }

  /**
   * Fetch one page's rendered HTML with per-host politeness + retry/backoff.
   * Throws only after exhausting maxAttempts. Reuses the saved-session
   * pattern (per-hostname storageState) from scrapeAll.ts.
   */
  async fetch(url: string): Promise<FetchResult> {
    const host = this.hostOf(url);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      await this.awaitHostSlot(host);
      const browser = await chromium.launch();
      try {
        const storageState = resolveStorageState(this.config.siteSessions, url);
        const context = await browser.newContext(storageState ? { storageState } : {});
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navTimeoutMs });
        const html = await page.content();
        return { url, finalUrl: page.url(), html, status: response?.status() ?? null };
      } catch (err) {
        lastErr = err;
        const backoff = this.config.baseBackoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn("page fetch attempt failed — backing off", { url, attempt, maxAttempts: this.config.maxAttempts, backoffMs: backoff, error: String(err) });
        if (attempt < this.config.maxAttempts) await sleep(backoff);
      } finally {
        await browser.close();
      }
    }
    throw new Error(`page fetch failed after ${this.config.maxAttempts} attempts: ${url} — ${String(lastErr)}`);
  }
}
