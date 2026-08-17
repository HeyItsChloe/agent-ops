// Outreach scraper: discovers payment-processing companies (or any
// configured vertical) and enriches each into a structured Company record
// (name, website, emails, contacts, LinkedIn, phones, business info,
// context).
//
// REUSE: discovery is done through the SAME provider seam the job-search
// pipeline uses (jobs/discovery/providers/*) — serpapi's REST SERP or
// Anthropic's server-side web_search — so no new search SDK. Enrichment is
// done through the SAME model gateway (LiteLLM) and the SAME fenced-JSON
// parser (integrations/llmJson.ts) the rest of the codebase uses for
// model-assisted extraction.
//
// No live network in unit tests: discovery + enrichment are injected via the
// ScrapeDeps interface so tests pass fakes.

import { parseModelJson } from "../../integrations/llmJson.js";
import { withRetry, type RetryOptions } from "./retry.js";
import type { Company, CompanyContact, OutreachVertical } from "./types.js";

// A raw discovery hit before enrichment — deliberately loose, since a search
// result is just a URL + snippet.
export interface DiscoveryHit {
  url: string;
  title?: string;
  snippet?: string;
  company?: string;
}

// Injected seams. `discover` returns candidate hits for a query; `enrich`
// turns one hit into a structured Company via the model. Both are wrapped in
// retry by this module, so the injected impls should be a single attempt.
export interface ScrapeDeps {
  discover: (query: string, maxResults: number) => Promise<DiscoveryHit[]>;
  enrich: (hit: DiscoveryHit) => Promise<Company>;
  retry?: RetryOptions;
  onWarn?: (message: string, fields?: Record<string, unknown>) => void;
}

export const ENRICH_SYSTEM_PROMPT =
  "You are a B2B data-enrichment assistant. Given a company's website URL and any snippet text, " +
  "return ONLY a JSON object (no markdown fences, no text outside the object) with this exact shape: " +
  '{"name": string, "website": string, "emails": string[], ' +
  '"contacts": [{"name"?: string, "title"?: string, "email"?: string, "linkedin"?: string}], ' +
  '"linkedin"?: string, "phones": string[], "businessInfo"?: string, "companyContext"?: string}. ' +
  "businessInfo = a one-line industry/size/HQ/products summary. companyContext = 1-2 sentences on why this " +
  "company would be a good outreach target for a payments/fintech partnership. " +
  "Omit any field you cannot determine rather than inventing it; use empty arrays for emails/contacts/phones if none are found. " +
  "Never fabricate personal contact emails or phone numbers.";

// Builds the enrichment user prompt from a discovery hit. Exported for the
// unit test that asserts the skill/prompt contract without a live model.
export function buildEnrichPrompt(hit: DiscoveryHit): string {
  return [
    `Website/URL: ${hit.url}`,
    hit.company ? `Company (from search): ${hit.company}` : "",
    hit.title ? `Page title: ${hit.title}` : "",
    hit.snippet ? `Snippet: ${hit.snippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Normalizes a model enrichment payload into a Company with all required
// arrays present and a discoveredAt stamp. Tolerant of missing/oddly-typed
// fields — the model is instructed to omit, and we backfill rather than throw.
export function normalizeEnriched(raw: unknown, hit: DiscoveryHit): Company {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const contacts: CompanyContact[] = Array.isArray(obj.contacts)
    ? (obj.contacts as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          name: typeof c.name === "string" ? c.name : undefined,
          title: typeof c.title === "string" ? c.title : undefined,
          email: typeof c.email === "string" ? c.email : undefined,
          linkedin: typeof c.linkedin === "string" ? c.linkedin : undefined,
        }))
    : [];
  return {
    name: (typeof obj.name === "string" && obj.name.trim()) || hit.company || hit.title || hit.url,
    website: typeof obj.website === "string" ? obj.website : hit.url,
    emails: asStringArray(obj.emails),
    contacts,
    linkedin: typeof obj.linkedin === "string" ? obj.linkedin : undefined,
    phones: asStringArray(obj.phones),
    businessInfo: typeof obj.businessInfo === "string" ? obj.businessInfo : undefined,
    companyContext: typeof obj.companyContext === "string" ? obj.companyContext : undefined,
    sourceUrl: hit.url,
    discoveredAt: new Date().toISOString(),
  };
}

// A model-backed enrichment implementation built on the LiteLLM gateway
// (the same chatCompletion used everywhere else). Returned as a ScrapeDeps
// `enrich` — kept out of the pure logic above so tests never call it.
export function modelEnrich(
  chat: (system: string, user: string) => Promise<string>,
): (hit: DiscoveryHit) => Promise<Company> {
  return async (hit) => {
    const raw = await chat(ENRICH_SYSTEM_PROMPT, buildEnrichPrompt(hit));
    let parsed: unknown;
    try {
      parsed = parseModelJson<unknown>(raw);
    } catch {
      // Enrichment failed to parse — degrade to the bare discovery hit rather
      // than dropping the company entirely.
      parsed = {};
    }
    return normalizeEnriched(parsed, hit);
  };
}

// Discovers + enriches up to `target` companies for the vertical. Iterates
// the vertical's seed queries, over-fetching (target * overFetch) so dedup
// downstream still has enough new candidates to hit `target`. Each stage is
// retried with backoff. Enrichment failures are isolated per-candidate.
export async function scrapeCompanies(
  vertical: OutreachVertical,
  target: number,
  deps: ScrapeDeps,
): Promise<Company[]> {
  const overFetchPerQuery = Math.max(5, Math.ceil((target * 2) / Math.max(1, vertical.searchTerms.length)));
  const seenUrls = new Set<string>();
  const hits: DiscoveryHit[] = [];

  for (const term of vertical.searchTerms) {
    try {
      const found = await withRetry(() => deps.discover(term, overFetchPerQuery), deps.retry);
      for (const hit of found) {
        if (!hit.url || seenUrls.has(hit.url)) continue;
        seenUrls.add(hit.url);
        hits.push(hit);
      }
    } catch (error) {
      deps.onWarn?.("outreach discovery query failed", { term, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const companies: Company[] = [];
  for (const hit of hits) {
    try {
      companies.push(await withRetry(() => deps.enrich(hit), deps.retry));
    } catch (error) {
      deps.onWarn?.("outreach enrichment failed", { url: hit.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return companies;
}
