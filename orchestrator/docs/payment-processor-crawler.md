# Payment-Processor Crawler (Epic 7)

A new agent-ops orchestrator pipeline that discovers payment processors on the
open web, fetches their sites politely, extracts contact facts in a
site-agnostic way, and returns deduped, provenance-stamped `ProcessorRecord[]`.

It is registered exactly like the existing `resume-job-applier` job-search
pipeline (a `PipelineHandler` behind the generic
`@heyitschloe/pipeline-orchestrator` engine), so it is triggerable over the
same `POST /trigger` surface with no new engine code.

Everything here **compiles** and is wired end to end. It is not run live in
this pass — the live paths (search-provider keys, real HTTP fetches) are
key-gated and documented as follow-ups below.

## Architecture

```
discover ──▶ fetch (retry + per-host politeness) ──▶ extract ──▶ stamp ──▶ normalize/dedup ──▶ ProcessorRecord[]
(Ticket 27)         (Ticket 33)                    (28/29/30)   (32)         (31)
```

| File | Ticket | Responsibility |
| --- | --- | --- |
| `crawler/types.ts` | — | `ProcessorContact`, `ProcessorRecord`, `Provenance`, `CrawlerConfig` — all zod schemas with inferred types. |
| `crawler/discovery.ts` | 27 | Seeds + optional provider search → classified, domain-deduped candidate URLs, capped by scope. |
| `crawler/fetch.ts` | 33 | Playwright page fetch with **retry+exponential backoff** and **per-host politeness delay**. |
| `crawler/extract/generic.ts` | 29 | Site-agnostic contact extraction — **no CSS-class dependency**. |
| `crawler/extract/adapters.ts` | 30 | Opt-in per-site adapters, used only to supplement/override generic extraction. |
| `crawler/contact.ts` | 28 | Per-URL orchestration: fetch → generic → adapter → `Partial<ProcessorContact>`. |
| `crawler/normalize.ts` | 31 | `processorIdFor()` + `dedupe()` — pure, unit-testable identity/collapse. |
| `crawler/provenance.ts` | 32 | `stampRecord()` / `confidenceFor()` — provenance + confidence from matched signals. |
| `crawler/pipeline.ts` | — | `runCrawler()` end-to-end orchestration. |
| `handlers/payment_processor_crawler.ts` | — | `PipelineHandler` wrapper + config validation. |

## Reuse decisions (job crawler vs. new)

Per the Ticket 7 audit's "reuse, don't reinvent" directive:

**Reused from the job crawler / existing integrations:**

- **Handler registration pattern** — `handlers/payment_processor_crawler.ts`
  mirrors `handlers/job_search_pipeline.ts` (a `paramsSchema` the engine
  validates the registry `params` bag against, an `InputSchema` for per-call
  overrides, a `run()` returning a `PipelineResult`).
- **Open-web search providers** — discovery calls the SAME modules under
  `jobs/discovery/providers/` (`serpapi`, `claudeWebSearch`, `jsearch`) via
  their uniform `(config, query, maxResults)` shape. This is the `scrapeAny`
  seam, reused wholesale; we only swap the job-criteria query for a
  payment-processor query.
- **Playwright + per-hostname saved sessions** — `fetch.ts` reuses
  `integrations/site_sessions.ts` (`resolveStorageState`) exactly as
  `jobs/discovery/scrapeAll.ts` does, degrading to unauthenticated when no
  session file exists.
- **Config/DI wiring in `index.ts`** — the crawler's deps are built from the
  already-present `scrapeAnySourcing` and `siteSessions` objects; an operator
  wired for job search gets processor discovery/fetch for free.
- **Structured logging** — `logging.ts` `logger.withContext({ correlationId })`.
- **Fail-open per-candidate posture** — one bad page is logged and skipped, the
  run continues, same as `run_personal_pipeline.ts`'s `processCandidate`.

**New for this crawler:**

- The whole `crawler/` extraction stack — generic contact extraction, the
  adapter registry, provenance/confidence scoring, and identity/dedup — has no
  counterpart in the job crawler (which drafts application documents, it does
  not extract structured contact records).
- **Retry + backoff and per-host rate limiting** in `fetch.ts` — the audit's
  explicitly-missing pieces; `scrapeAll.ts` fetched once with no politeness.
- `ProcessorContact` / `ProcessorRecord` schemas and the `CrawlerConfig`.

## Generic-first / adapter-fallback extraction model

**Generic extraction (Ticket 29) is the primary path and runs first, always.**
It reads only signals that carry meaning across sites, in descending trust:

1. `mailto:` / `tel:` links
2. schema.org **JSON-LD** (`Organization` / `ContactPoint`, walked recursively)
3. `<meta>` / **OpenGraph** tags + keyword-classified contact/sales/support links
4. **visible-text** email/phone regex
5. **rendered-DOM text** (tag-stripped) as the last resort

It has **no dependency on site-specific CSS class names** — keying off
`class="..."` would make it a per-site adapter in disguise and rot on any
reskin. The first non-empty value per field wins; missing fields stay empty
(**never fabricated** — Ticket 28).

**Adapters (Ticket 30) are opt-in and secondary.** The core
(`contact.ts`) resolves generic extraction FIRST, then asks
`adapters.resolve(url)` whether a registered adapter wants to supplement a
field generic extraction missed or override a field it is authoritative about
for that one site. An adapter never replaces the generic pass. This is the
inverse of the job crawler's scraping adapters (there the named adapter is
preferred); here generic is preferred and adapters are the exception, reserved
for sites where generic extraction is provably insufficient.

## Retry + rate limiting (Ticket 33)

`fetch.ts`'s `PageFetcher`:

- **Retry with exponential backoff** — each page is attempted up to
  `maxAttempts` (default 3); attempt _n_ waits `baseBackoffMs · 2^(n-1)` plus
  jitter before the next try. Only a full exhaustion throws.
- **Per-host politeness delay** — requests to the same hostname are spaced by
  at least `perHostDelayMs` (config, default 1000ms), tracked across calls via
  a per-host last-request map, so we never hammer one processor's site.
  Requests to _different_ hosts are not throttled against each other.
- **Politeness note:** a live deployment is expected to honour `robots.txt` and
  any `crawl-delay`. That fetch+parse is **not** implemented here (see
  follow-ups); `perHostDelayMs` is the politeness floor we ship with today.

## Record schema + provenance / confidence

```ts
ProcessorContact = {
  company_name?, domain?, contact_name?, email?, phone?,
  contact_url?, sales_url?, support_url?, source_url?
}

ProcessorRecord = ProcessorContact & {
  processor_id: string,                 // stable identity (normalize.ts)
  provenance: {
    source_url: string,
    extraction_method: ExtractionMethod[],  // which signals matched
    observation_date: string,               // passed in per run, never Date.now() in helpers
    confidence: number                       // 0..1, derived from the signals
  }
}
```

- **`processor_id`** (Ticket 31) is derived from the **canonical domain** first,
  falling back to the **normalized company name** (suffixes stripped, known
  aliases applied). `dedupe()` collapses every URL/page sharing an id into one
  merged record, preferring higher-confidence / more-complete field values.
  Both functions are pure and unit-testable.
- **`confidence`** (Ticket 32) is a weighted sum of the matched signals
  (JSON-LD / mailto weigh most, tag-stripped text least), squashed to `0..1`.
  A single weak signal stays low; multiple independent signals approach 1.
- **`observation_date`** is captured **once per run** in the handler and
  threaded down; the provenance helpers never read the clock themselves.

## How it's triggered

Registered in `registry/pipelines.yaml` as pipeline **`payment-processor-crawler`**
(`http_kind: payment-crawler`), handler name `payment-processor-crawler`.

```bash
curl -X POST "$ORCHESTRATOR_URL/trigger" \
  -H "Authorization: Bearer $ORCHESTRATOR_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "pipeline": "payment-processor-crawler",
        "action": "run",
        "requestedBy": "chloe",
        "input": {
          "seeds": ["https://stripe.com/contact", "https://squareup.com"],
          "keywords": ["payment gateway", "merchant acquirer"],
          "maxPages": 20,
          "perHostDelayMs": 1500,
          "dryRun": true
        }
      }'
```

Registry `params` supply defaults; the trigger `input` overrides per call. The
handler returns `{ status: "complete", message, data: { records, summary } }`.

## Follow-ups (explicitly deferred)

- **the-store persistence + schema (Epic 8):** this pipeline **returns**
  records and logs a summary; it does not write them anywhere. Persisting
  `ProcessorRecord[]` (CSV/table schema, upsert-by-`processor_id`, append vs.
  overwrite) is Epic 8. The existing `integrations/the_store.ts` is the model.
- **Dry-run / reporting (Epic 9):** `dryRun` here only short-circuits before
  fetch to prove wiring without live keys/HTTP. A real dry-run diff/report
  (what would change vs. what's stored, per-field confidence rollups) is Epic 9.
- **`robots.txt` + `crawl-delay` parsing:** honour real robots directives, not
  just the `perHostDelayMs` floor.
- **Model-assisted classification:** `discovery.classifyCandidate()` is a cheap
  keyword gate; a `scrapeAll`-style render-and-ask-the-model classifier would
  raise precision.
- **Intra-site expansion:** follow a discovered processor's own contact/sales
  links (reusing the `scrapeAll` render-and-extract approach) for deeper
  coverage than the single seed/landing page.
- **Live provider validation:** the serpapi / claude_web_search / jsearch
  discovery paths are wired but unverified against live keys here.
