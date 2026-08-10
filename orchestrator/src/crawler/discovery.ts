// Candidate discovery for the payment-processor crawler (Ticket 27).
//
// Produces the list of candidate URLs the rest of the pipeline will fetch +
// extract. Design decisions the Ticket 27 audit asked to be explicit about:
//
//  SEED SOURCES: the operator-supplied `seeds` (config.seeds) are the trusted
//    starting set — curated processor directories, "best payment processor"
//    roundups, an association member list, or known processor homepages. Seeds
//    are always included as candidates directly (no discovery key required).
//
//  SEARCH / DISCOVERY STRATEGY: for broader coverage we reuse the job
//    crawler's open-web search seam wholesale — the SAME provider modules
//    under jobs/discovery/providers/ (serpapi / claude_web_search / jsearch),
//    which already implement a uniform (config, query, maxResults) => results
//    shape. We build a payment-processor-flavoured query from `keywords`
//    instead of job criteria. This is deliberately the scrapeAny pattern, not
//    scrapeAll: we're searching the open web for processors, not crawling one
//    given site's listing. (scrapeAll's render-and-ask-the-model approach is
//    the tool to reach for later when expanding WITHIN a discovered processor
//    directory site — noted as a follow-up, not wired here.)
//
//  CRAWL SCOPE CAPS: maxPages caps total candidate URLs; maxDomains caps how
//    many distinct processor domains we chase. Both come from config and are
//    enforced here so discovery can never hand the fetch stage an unbounded
//    work list.
//
//  RELEVANCE CRITERIA + PROCESSOR CLASSIFICATION: a candidate must look
//    payment-processor-adjacent — its URL/snippet must hit the keyword set (or
//    a built-in payment lexicon). classifyCandidate() is the single, cheap
//    text-based gate; a model-assisted classifier (à la scrapeAll) is a
//    documented follow-up for higher precision.
//
//  DUPLICATE DETECTION: candidates are collapsed by canonical domain
//    (normalize.ts) so ten deep links into one processor's site yield one
//    candidate domain, not ten — the same identity logic the final record
//    dedup uses, applied early to save fetches.
import * as serpapi from "../jobs/discovery/providers/serpapi.js";
import * as claudeWebSearch from "../jobs/discovery/providers/claudeWebSearch.js";
import * as jsearch from "../jobs/discovery/providers/jsearch.js";
import { canonicalDomain } from "./normalize.js";
import { logger } from "../logging.js";
import type { CrawlerConfig } from "./types.js";

export interface ProcessorCandidate {
  url: string;
  company_name?: string;
  snippet?: string;
}

// Search-provider credentials, reusing the exact config shapes the job
// crawler's scrapeAny already defines — an operator that has these wired for
// job search gets processor discovery for free.
export interface DiscoveryDeps {
  serpapi?: serpapi.SerpApiConfig;
  claudeWebSearch?: claudeWebSearch.ClaudeWebSearchConfig;
  jsearch?: jsearch.JSearchConfig;
}

// Built-in payment lexicon — the baseline relevance signal even when the
// operator passes no keywords. Intentionally small and generic.
const PAYMENT_LEXICON = [
  "payment",
  "payments",
  "processor",
  "processing",
  "merchant",
  "acquirer",
  "acquiring",
  "gateway",
  "checkout",
  "card",
  "pos",
  "psp",
];

function buildQuery(config: CrawlerConfig): string {
  const parts = ["payment processor"];
  if (config.keywords.length) parts.push(...config.keywords);
  return parts.join(" ");
}

/**
 * Relevance gate (Ticket 27). Cheap, text-only classification: does the
 * candidate's URL + snippet look like a payment processor? Uses the operator
 * keywords first, then the built-in lexicon. Returns true = keep as a
 * processor candidate. A higher-precision model classifier is a follow-up.
 */
export function classifyCandidate(candidate: ProcessorCandidate, keywords: string[]): boolean {
  const hay = `${candidate.url} ${candidate.company_name ?? ""} ${candidate.snippet ?? ""}`.toLowerCase();
  const terms = [...keywords.map((k) => k.toLowerCase()), ...PAYMENT_LEXICON];
  return terms.some((t) => t && hay.includes(t));
}

async function searchProviders(config: CrawlerConfig, deps: DiscoveryDeps, limit: number): Promise<ProcessorCandidate[]> {
  const provider = config.searchProvider;
  if (!provider) {
    // No provider selected — seeds-only discovery. This is a valid mode, not
    // an error: operators can run purely off a curated seed list.
    logger.info("crawler discovery: no searchProvider set — using seeds only");
    return [];
  }
  const query = buildQuery(config);
  try {
    switch (provider) {
      case "serpapi":
        // TODO(live-key): requires SERPAPI_API_KEY. Skipped (not failed) when
        // absent so the pipeline still runs off seeds in this greenfield pass.
        if (!deps.serpapi) {
          logger.warn("crawler discovery: serpapi selected but no key configured — skipping provider search");
          return [];
        }
        return (await serpapi.search(deps.serpapi, query, limit)).map((c) => ({ url: c.url, company_name: c.title, snippet: c.snippet }));
      case "claude_web_search":
        // TODO(live-key): requires ANTHROPIC_API_KEY.
        if (!deps.claudeWebSearch) {
          logger.warn("crawler discovery: claude_web_search selected but no key configured — skipping provider search");
          return [];
        }
        return (await claudeWebSearch.search(deps.claudeWebSearch, query, limit)).map((c) => ({ url: c.url, company_name: c.company ?? c.title, snippet: c.snippet }));
      case "jsearch":
        // TODO(live-key): requires JSEARCH_API_KEY. jsearch is job-oriented;
        // kept wired for parity but seeds/serpapi are the sensible processor
        // discovery paths — see docs follow-ups.
        if (!deps.jsearch) {
          logger.warn("crawler discovery: jsearch selected but no key configured — skipping provider search");
          return [];
        }
        return (await jsearch.search(deps.jsearch, query, limit)).map((c) => ({ url: c.url, company_name: c.company ?? c.title, snippet: c.snippet }));
    }
  } catch (err) {
    // Discovery is best-effort: a provider outage falls back to seeds rather
    // than aborting the whole crawl.
    logger.warn("crawler discovery: provider search failed — falling back to seeds", { provider, error: String(err) });
    return [];
  }
}

/**
 * Discover candidate processor URLs (Ticket 27). Combines seeds + optional
 * provider search, classifies for relevance, dedups by canonical domain, and
 * enforces the crawl-scope caps. Returns one candidate per distinct
 * processor domain, capped at min(maxPages, maxDomains).
 */
export async function discoverProcessors(config: CrawlerConfig, deps: DiscoveryDeps = {}): Promise<ProcessorCandidate[]> {
  const seedCandidates: ProcessorCandidate[] = config.seeds.map((url) => ({ url }));
  // Ask the provider for a little extra headroom since classification + dedup
  // will drop some, but never more than the caps allow.
  const searchLimit = Math.min(config.maxPages, config.maxDomains) * 2;
  const searched = await searchProviders(config, deps, searchLimit);

  const combined = [...seedCandidates, ...searched];

  // Relevance gate. Seeds are operator-trusted, so they bypass classification;
  // searched candidates must clear it.
  const relevant = combined.filter((c, i) => i < seedCandidates.length || classifyCandidate(c, config.keywords));

  // Duplicate detection by canonical domain — keep the first (seeds first, so
  // an operator seed wins over a searched dup of the same domain).
  const seenDomains = new Set<string>();
  const deduped: ProcessorCandidate[] = [];
  for (const c of relevant) {
    const domain = canonicalDomain(c.url);
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    deduped.push(c);
    if (seenDomains.size >= config.maxDomains || deduped.length >= config.maxPages) break;
  }

  logger.info("crawler discovery complete", {
    seeds: seedCandidates.length,
    searched: searched.length,
    afterClassify: relevant.length,
    afterDedup: deduped.length,
    maxPages: config.maxPages,
    maxDomains: config.maxDomains,
  });
  return deduped;
}
