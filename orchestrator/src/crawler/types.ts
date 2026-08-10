// Payment-processor crawler types (Epic 7). Mirrors the job-search
// pipeline's split (src/types.ts): this file defines only the crawler's own
// data shapes and its config — the generic engine (pipeline-orchestrator)
// still treats the registry `params` bag as opaque, and the handler
// (handlers/payment_processor_crawler.ts) validates it against CrawlerConfigSchema
// before this code trusts it.
//
// Everything here is a zod schema with an inferred TS type, same convention
// as JobSearchParamsSchema — one source of truth, no hand-maintained
// interface drifting from its validator.
import { z } from "zod";

// Which extraction signal produced a given field. Ordered loosely from most
// to least structured/trustworthy — provenance.ts scores confidence from
// which of these matched, so the ordering here is meaningful, not cosmetic.
// See extract/generic.ts for what each one actually reads.
export const ExtractionMethodSchema = z.enum([
  "mailto_tel", // href="mailto:"/"tel:" links — an explicit, machine-intended contact
  "json_ld", // schema.org Organization/ContactPoint JSON-LD block
  "meta_opengraph", // <meta>/OpenGraph tags
  "visible_text_regex", // email/phone regex over the page's visible text
  "rendered_dom_text", // regex over tag-stripped rendered DOM text (last resort)
  "site_adapter", // an opt-in per-site adapter (extract/adapters.ts) supplemented/overrode a field
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

// The contact facts we try to pull off a processor's site. Every field is
// optional on purpose: sites are not uniform, and a field we could not find
// stays empty rather than being fabricated (Ticket 28). domain is the one
// field we can always derive (from the URL) even when the page yields
// nothing else.
export const ProcessorContactSchema = z.object({
  company_name: z.string().optional(),
  domain: z.string().optional(),
  contact_name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  contact_url: z.string().optional(),
  sales_url: z.string().optional(),
  support_url: z.string().optional(),
  source_url: z.string().optional(),
});
export type ProcessorContact = z.infer<typeof ProcessorContactSchema>;

// Per-record provenance (Ticket 32). observation_date is passed in by the
// caller (never Date.now() inside these helpers) so runs are reproducible
// and unit-testable. confidence is a 0..1 score derived from which/how many
// signals matched — a mailto link + JSON-LD scores higher than a single
// regex hit off visible text.
export const ProvenanceSchema = z.object({
  source_url: z.string(),
  extraction_method: z.array(ExtractionMethodSchema),
  observation_date: z.string(), // ISO date/timestamp, supplied by the caller
  confidence: z.number().min(0).max(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// A fully-identified, stamped record: the contact facts + a stable
// processor_id (normalize.ts) + provenance. This is what the pipeline
// returns; persisting it is Epic 8 (the-store), out of scope here.
export const ProcessorRecordSchema = ProcessorContactSchema.extend({
  processor_id: z.string(),
  provenance: ProvenanceSchema,
});
export type ProcessorRecord = z.infer<typeof ProcessorRecordSchema>;

// Pipeline config (Ticket 27/33). Validated by the handler, same posture as
// JobSearchParamsSchema. Discovery seeds + keywords drive candidate finding;
// the caps bound crawl cost; perHostDelayMs is the politeness knob; dryRun
// short-circuits before any network fetch so the pipeline can be exercised
// (and its wiring proven) without live provider keys or hitting real sites.
export const CrawlerConfigSchema = z.object({
  // Seed URLs and/or search queries to start discovery from (Ticket 27).
  seeds: z.array(z.string()).default([]),
  // Relevance keywords — a candidate must look payment-processor-adjacent to
  // survive classification (see discovery.ts).
  keywords: z.array(z.string()).default([]),
  // Crawl-scope caps. maxPages bounds total pages fetched; maxDomains bounds
  // how many distinct processor domains we chase.
  maxPages: z.number().int().positive().default(50),
  maxDomains: z.number().int().positive().default(25),
  // Per-host politeness delay between requests to the same hostname (fetch.ts).
  perHostDelayMs: z.number().int().nonnegative().default(1000),
  // When true, discover candidates but do not fetch/extract — return an empty
  // record set plus a logged summary. Lets the pipeline compile-and-run-clean
  // here without live keys or real network access.
  dryRun: z.boolean().default(false),
  // Optional discovery search provider (reuses scrapeAny's providers). Omit
  // to rely on seeds alone — a live key is required for the provider path.
  searchProvider: z.enum(["serpapi", "claude_web_search", "jsearch"]).optional(),
});
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;
