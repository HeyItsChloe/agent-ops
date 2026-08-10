// Provenance + confidence stamping (Ticket 32).
//
// Every record carries where it came from and how much to trust it. Two hard
// rules from the Ticket 32 audit:
//   - observation_date is PASSED IN, never Date.now() here. The pipeline
//     captures one timestamp per run and threads it through, so a run is
//     reproducible and these helpers stay pure/unit-testable.
//   - confidence is derived from WHICH signals matched, not a flat constant.
//     Structured, machine-intended signals (mailto/tel, JSON-LD) are worth
//     more than a regex hit off visible text, which is worth more than the
//     tag-stripped last-resort pass.
import type { ExtractionMethod, ProcessorContact, ProcessorRecord, Provenance } from "./types.js";
import { processorIdFor } from "./normalize.js";

// Per-signal trust weights. Tuned so that a single strong signal (JSON-LD)
// already clears "probably real", while only the weakest signal alone stays
// low. Summed then squashed to 0..1 below.
const METHOD_WEIGHTS: Record<ExtractionMethod, number> = {
  mailto_tel: 0.5,
  json_ld: 0.5,
  meta_opengraph: 0.25,
  visible_text_regex: 0.2,
  rendered_dom_text: 0.1,
  site_adapter: 0.4,
};

/**
 * Score 0..1 from the set of signals that matched. More signals and stronger
 * signals raise it; the weakest-only case stays low. Deterministic.
 */
export function confidenceFor(methods: ExtractionMethod[]): number {
  if (methods.length === 0) return 0;
  const sum = [...new Set(methods)].reduce((acc, m) => acc + (METHOD_WEIGHTS[m] ?? 0), 0);
  // Squash to 0..1 without ever quite reaching 1 for a single signal — 1.0 is
  // reserved for a record corroborated by several independent signals.
  return Math.round(Math.min(1, sum) * 100) / 100;
}

/**
 * Stamp a partial contact into a full ProcessorRecord: attach processor_id
 * and provenance (source_url, the matched extraction methods, the passed-in
 * observation date, and a derived confidence). Never invents field values —
 * it only wraps what extraction produced.
 */
export function stampRecord(
  contact: Partial<ProcessorContact>,
  opts: { sourceUrl: string; methods: ExtractionMethod[]; observationDate: string },
): ProcessorRecord {
  const provenance: Provenance = {
    source_url: opts.sourceUrl,
    extraction_method: [...new Set(opts.methods)],
    observation_date: opts.observationDate,
    confidence: confidenceFor(opts.methods),
  };
  return {
    ...contact,
    source_url: contact.source_url ?? opts.sourceUrl,
    processor_id: processorIdFor({ domain: contact.domain, company_name: contact.company_name, source_url: opts.sourceUrl }),
    provenance,
  };
}
