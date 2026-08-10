// Crawler dry-run comparison + change reporting (Epic 9, tickets 39/40).
//
// Turns a run's normalized/deduped ProcessorRecord[] plus the existing
// the-store CSV rows into a CrawlReport: how much was crawled, how many
// processors are genuinely new vs already-known, which known processors have a
// changed email/phone since their LATEST recorded observation, and how many
// records fell below the confidence bar. buildReport is PURE (no I/O, no clock)
// so it is directly unit-testable offline — the existing rows are read via
// store.ts's single read path and handed in, never fetched here.
//
// This is the read/compare side of Epic 9. It never writes: dry runs report
// only; real runs report AND persist (the write stays in store.ts, guarded).
import type { ProcessorRecord } from "./types.js";
import { PROCESSOR_CSV_HEADER } from "./store.js";

// Column indices into a the-store CSV data row, derived from the canonical
// header so this never drifts from store.ts's column order.
const COL = {
  observation_date: PROCESSOR_CSV_HEADER.indexOf("observation_date"),
  processor_id: PROCESSOR_CSV_HEADER.indexOf("processor_id"),
  email: PROCESSOR_CSV_HEADER.indexOf("email"),
  phone: PROCESSOR_CSV_HEADER.indexOf("phone"),
} as const;

// Default confidence bar below which a record is flagged low-confidence.
// Configurable via config/env at the call site (pipeline.ts); this is the
// fallback when neither supplies one.
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

// Crawl-side counters threaded out of the fetch/discovery step. Kept minimal on
// purpose — the pipeline already tracks fetched/failed, this just names them for
// the report.
export interface CrawlStats {
  pages_crawled: number;
  failed_pages: number;
}

// A single human-readable proposed change for dry-run visibility. "add" = a
// processor not yet in the-store; "change" = a known processor whose contact
// facts differ from its latest observation. Kept small (see PROPOSED_CHANGES_CAP).
export interface ProposedChange {
  type: "add" | "change";
  processor_id: string;
  company_name?: string;
  detail: string;
}

export interface CrawlReport {
  pages_crawled: number;
  processors_found: number;
  unique_processors: number;
  new_processors: number;
  existing_processors: number;
  new_contacts: number;
  changed_contacts: number;
  failed_pages: number;
  low_confidence_records: number;
  proposed_changes: ProposedChange[];
  low_confidence_threshold: number;
}

// Cap on how many proposed_changes we enumerate — the report is a summary, not
// a full diff dump. Counts (new_processors/changed_contacts) are always exact;
// only this itemized list is truncated.
const PROPOSED_CHANGES_CAP = 25;

interface LatestObservation {
  email: string;
  phone: string;
}

// Index the existing CSV rows to the LATEST observation per processor_id.
// The store is append-only with a YYYY-MM-DD observation_date, which sorts
// lexicographically, so "latest" is a simple string-max compare. A leading
// header row (if present) is skipped by matching it against the canonical
// header's processor_id column label.
function latestByProcessorId(existingRows: string[][]): Map<string, LatestObservation> {
  const latest = new Map<string, { date: string; obs: LatestObservation }>();
  for (const row of existingRows) {
    const id = row[COL.processor_id];
    // Skip the header row and any malformed/short rows.
    if (!id || id === PROCESSOR_CSV_HEADER[COL.processor_id]) continue;
    const date = row[COL.observation_date] ?? "";
    const prev = latest.get(id);
    if (!prev || date >= prev.date) {
      latest.set(id, {
        date,
        obs: { email: row[COL.email] ?? "", phone: row[COL.phone] ?? "" },
      });
    }
  }
  const out = new Map<string, LatestObservation>();
  for (const [id, v] of latest) out.set(id, v.obs);
  return out;
}

/**
 * Build the crawl report by comparing this run's normalized/deduped records
 * against the existing the-store rows. Pure + deterministic.
 *
 *  - new vs existing: keyed by processor_id (present in the existing rows or not)
 *  - new_contacts: NEW processors that actually carry a contact (email or phone)
 *  - changed_contacts: EXISTING processors whose email or phone differs from
 *    that processor's latest existing observation
 *  - low_confidence_records: records with provenance.confidence < threshold
 *
 * existingRows is what store.ts's readExistingProcessorRows returns — parsed
 * CSV rows including the header (index 0), or an empty array when the-store is
 * empty/unconfigured (then every record is "new").
 */
export function buildReport(
  records: ProcessorRecord[],
  existingRows: string[][],
  stats: CrawlStats,
  threshold: number = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
): CrawlReport {
  const latest = latestByProcessorId(existingRows);

  let newProcessors = 0;
  let existingProcessors = 0;
  let newContacts = 0;
  let changedContacts = 0;
  let lowConfidence = 0;
  const proposedChanges: ProposedChange[] = [];

  for (const rec of records) {
    const id = rec.processor_id;
    const email = rec.email ?? "";
    const phone = rec.phone ?? "";

    if (rec.provenance.confidence < threshold) lowConfidence++;

    const prior = latest.get(id);
    if (!prior) {
      newProcessors++;
      if (email || phone) newContacts++;
      if (proposedChanges.length < PROPOSED_CHANGES_CAP) {
        proposedChanges.push({
          type: "add",
          processor_id: id,
          company_name: rec.company_name,
          detail: `new processor${email ? ` email=${email}` : ""}${phone ? ` phone=${phone}` : ""}`.trim(),
        });
      }
    } else {
      existingProcessors++;
      const emailChanged = email !== "" && email !== prior.email;
      const phoneChanged = phone !== "" && phone !== prior.phone;
      if (emailChanged || phoneChanged) {
        changedContacts++;
        if (proposedChanges.length < PROPOSED_CHANGES_CAP) {
          const parts: string[] = [];
          if (emailChanged) parts.push(`email ${prior.email || "∅"} -> ${email}`);
          if (phoneChanged) parts.push(`phone ${prior.phone || "∅"} -> ${phone}`);
          proposedChanges.push({
            type: "change",
            processor_id: id,
            company_name: rec.company_name,
            detail: parts.join("; "),
          });
        }
      }
    }
  }

  return {
    pages_crawled: stats.pages_crawled,
    processors_found: records.length,
    unique_processors: new Set(records.map((r) => r.processor_id)).size,
    new_processors: newProcessors,
    existing_processors: existingProcessors,
    new_contacts: newContacts,
    changed_contacts: changedContacts,
    failed_pages: stats.failed_pages,
    low_confidence_records: lowConfidence,
    proposed_changes: proposedChanges,
    low_confidence_threshold: threshold,
  };
}

/** One-line human summary of a report for logging (Ticket 40). */
export function summarizeReport(report: CrawlReport): string {
  return (
    `pages=${report.pages_crawled} failed=${report.failed_pages} ` +
    `found=${report.processors_found} unique=${report.unique_processors} ` +
    `new=${report.new_processors} existing=${report.existing_processors} ` +
    `newContacts=${report.new_contacts} changed=${report.changed_contacts} ` +
    `lowConf=${report.low_confidence_records} (<${report.low_confidence_threshold})`
  );
}
