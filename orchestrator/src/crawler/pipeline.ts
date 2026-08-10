// Payment-processor crawler pipeline (Epic 7).
//
// Orchestrates the whole run: discover candidate processor URLs -> fetch each
// (with retry + per-host politeness) -> extract contacts (generic-first,
// adapter-as-override) -> stamp provenance -> normalize identity + dedup ->
// ProcessorRecord[]. Structurally the crawler's counterpart to
// run_personal_pipeline.ts's dispatchPersonalPipeline: one entry function the
// handler wraps behind the generic engine.
//
// Scope boundary: this returns the records and logs a summary. It does NOT
// persist them — the-store persistence is Epic 8, and dry-run/reporting is
// Epic 9 (see docs/payment-processor-crawler.md follow-ups). dryRun here is
// just the "prove the wiring without touching the network" switch, not the
// Epic 9 reporting feature.
import { discoverProcessors, type DiscoveryDeps } from "./discovery.js";
import { extractProcessorContact } from "./contact.js";
import { PageFetcher } from "./fetch.js";
import { stampRecord } from "./provenance.js";
import { dedupe } from "./normalize.js";
import type { CrawlerConfig, ProcessorRecord } from "./types.js";
import type { SiteSessionsConfig } from "../integrations/site_sessions.js";
import { logger } from "../logging.js";

export interface CrawlerDeps {
  // Search-provider creds (reused from the job crawler's scrapeAny). All
  // optional — seeds-only discovery needs none.
  discovery?: DiscoveryDeps;
  // Per-hostname Playwright saved sessions, exactly as scrapeAll uses.
  siteSessions?: SiteSessionsConfig;
}

export interface CrawlerRunContext {
  correlationId: string;
  requestedBy: string;
  // The single run timestamp threaded into every record's provenance — the
  // pipeline captures it ONCE here and passes it down, so provenance.ts never
  // calls Date.now() itself (Ticket 32).
  observationDate: string;
}

export interface CrawlerRunResult {
  records: ProcessorRecord[];
  summary: {
    discovered: number;
    fetched: number;
    failed: number;
    records: number;
    dryRun: boolean;
  };
}

/**
 * Run the crawler end to end. Never throws for a single bad page — one
 * candidate failing (fetch timeout, unreachable host) is logged and the run
 * continues, same fail-open posture as the job pipeline's processCandidate.
 */
export async function runCrawler(config: CrawlerConfig, deps: CrawlerDeps, ctx: CrawlerRunContext): Promise<CrawlerRunResult> {
  const log = logger.withContext({ correlationId: ctx.correlationId, pipeline: "payment-processor-crawler" });
  log.info("crawler run starting", { requestedBy: ctx.requestedBy, seeds: config.seeds.length, dryRun: config.dryRun });

  const candidates = await discoverProcessors(config, deps.discovery);

  // dryRun stops before any network fetch — the run proves discovery + wiring
  // and returns an empty record set with a summary. This is what lets the
  // pipeline be exercised here (and in CI) with no live keys and no real HTTP.
  if (config.dryRun) {
    log.info("crawler dry run — skipping fetch/extract", { discovered: candidates.length });
    return {
      records: [],
      summary: { discovered: candidates.length, fetched: 0, failed: 0, records: 0, dryRun: true },
    };
  }

  const fetcher = new PageFetcher({ siteSessions: deps.siteSessions, perHostDelayMs: config.perHostDelayMs });
  const records: ProcessorRecord[] = [];
  let fetched = 0;
  let failed = 0;

  // Sequential on purpose: the per-host rate limiter is most meaningful when
  // we aren't firing a thundering herd. maxPages already caps the work list.
  for (const candidate of candidates.slice(0, config.maxPages)) {
    try {
      const { contact, methods } = await extractProcessorContact(fetcher, candidate.url);
      fetched++;
      // Seed/discovery metadata (company name) supplements extraction without
      // overriding a value the page itself yielded.
      if (!contact.company_name && candidate.company_name) contact.company_name = candidate.company_name;
      const record = stampRecord(contact, {
        sourceUrl: candidate.url,
        methods,
        observationDate: ctx.observationDate,
      });
      records.push(record);
    } catch (err) {
      failed++;
      log.warn("candidate failed — continuing with the rest of the crawl", { url: candidate.url, error: String(err) });
    }
  }

  // Collapse multiple pages/URLs of one processor into a single identity.
  const deduped = dedupe(records);

  log.info("crawler run complete", { discovered: candidates.length, fetched, failed, rawRecords: records.length, dedupedRecords: deduped.length });
  return {
    records: deduped,
    summary: { discovered: candidates.length, fetched, failed, records: deduped.length, dryRun: false },
  };
}
