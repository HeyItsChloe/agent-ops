// Persist payment-processor crawler records as dated rows in "the-store"
// (Epic 8, tickets 36/37/38). Mirrors integrations/the_store.ts's job-
// application append: mint an installation token, read the existing CSV,
// append, and write it back via the GitHub App's contents API. It reuses the
// exact same get -> merge -> createOrUpdateFile primitives (integrations/
// github.js) and the same fail-open posture — when the-store isn't
// configured, callers skip the write with a warning rather than hard-failing
// the crawl.
//
// Unlike the job CSV (one row per application, deduped by URL), this file is
// an ACCUMULATED, append-only log: every run stamps its deduped records with
// the run's observation_date and appends them as new rows. That append-only
// shape is exactly why the data-loss guards below matter — a bad merge here
// would clobber the whole history, not just one row.
import {
  createOrUpdateFile,
  getFileContents,
  getInstallationToken,
  type GitHubAppConfig,
} from "../integrations/github.js";
import type { ProcessorRecord } from "./types.js";
import { logger } from "../logging.js";

// Canonical column order — MUST match the-store's header exactly. Anything
// that doesn't parse back to this header (a legacy/renamed file, a truncated
// write) fails validation and aborts the write rather than clobbering.
export const PROCESSOR_CSV_HEADER = [
  "observation_date",
  "processor_id",
  "company_name",
  "domain",
  "contact_name",
  "email",
  "phone",
  "contact_url",
  "sales_url",
  "support_url",
  "source_url",
  "extraction_method",
  "confidence",
] as const;

// The outcome the pipeline computed for this run. Drives the Ticket 37 data-
// loss guard: only outcomes that strictly ADD rows are ever written.
export type CrawlOutcome = "success_new" | "success_no_new" | "partial" | "failed";

// Where + how to reach the-store. Bundles the App-token inputs (githubApp +
// installationId) with the file coordinates so callers thread a single config
// object, same as TheStoreConfig does for the job CSV.
export interface ProcessorStoreConfig {
  githubApp: GitHubAppConfig;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  path: string; // e.g. "payment-processors.csv"
}

// --- small CSV helpers (the_store.ts's csvEscape/parseCsv aren't exported;
// these are byte-for-byte the same behaviour, kept local per the brief). ---

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Reduce an ISO date/timestamp (what the pipeline threads in) to YYYY-MM-DD —
// the canonical dated-row granularity, and what validation enforces.
function toObservationDay(observationDate: string): string {
  return observationDate.slice(0, 10);
}

function recordToCells(record: ProcessorRecord, observationDay: string): string[] {
  const prov = record.provenance;
  return [
    observationDay,
    record.processor_id ?? "",
    record.company_name ?? "",
    record.domain ?? "",
    record.contact_name ?? "",
    record.email ?? "",
    record.phone ?? "",
    record.contact_url ?? "",
    record.sales_url ?? "",
    record.support_url ?? "",
    record.source_url ?? prov.source_url ?? "",
    // Multiple extraction signals collapse into one cell, delimited with "|"
    // (never a comma, so the cell never needs quoting for the delimiter).
    (prov.extraction_method ?? []).join("|"),
    String(prov.confidence),
  ];
}

/**
 * Serialize records into CSV DATA rows (no header) in the canonical column
 * order, each field CSV-escaped. Pure: observationDate is passed in, never
 * read from the clock here. Returns one string per row.
 */
export function serializeRows(records: ProcessorRecord[], observationDate: string): string[] {
  const day = toObservationDay(observationDate);
  return records.map((record) => recordToCells(record, day).map(csvEscape).join(","));
}

// --- Ticket 38 pre-write validation ---

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a fully-merged CSV string against the canonical schema BEFORE it is
 * written. Header must match exactly; every data row must have the right
 * column count, non-empty required fields (observation_date/processor_id/
 * company_name/domain), a YYYY-MM-DD observation_date, and a confidence in
 * [0,1]. Any failure means abort-the-write, so this is deliberately strict.
 */
export function validateProcessorCsv(content: string): ValidationResult {
  const rows = parseCsv(content);
  if (rows.length === 0) return { ok: false, error: "empty content" };

  const header = rows[0];
  if (header.length !== PROCESSOR_CSV_HEADER.length) {
    return { ok: false, error: `header column count ${header.length} != ${PROCESSOR_CSV_HEADER.length}` };
  }
  for (let c = 0; c < PROCESSOR_CSV_HEADER.length; c++) {
    if (header[c] !== PROCESSOR_CSV_HEADER[c]) {
      return { ok: false, error: `header mismatch at col ${c}: "${header[c]}" != "${PROCESSOR_CSV_HEADER[c]}"` };
    }
  }

  const cols = PROCESSOR_CSV_HEADER.length;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length !== cols) {
      return { ok: false, error: `row ${r} has ${row.length} columns, expected ${cols}` };
    }
    const [observationDate, processorId, companyName, domain] = row;
    if (!observationDate || !processorId || !companyName || !domain) {
      return { ok: false, error: `row ${r} missing required field(s)` };
    }
    if (!dateRe.test(observationDate)) {
      return { ok: false, error: `row ${r} observation_date "${observationDate}" not YYYY-MM-DD` };
    }
    const confidence = Number(row[12]);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: `row ${r} confidence "${row[12]}" not in [0,1]` };
    }
  }
  return { ok: true };
}

// --- Ticket 37 data-loss guard (pure, so it's unit-testable offline) ---

export interface WritePlan {
  write: boolean;
  reason: string;
  content?: string; // the merged CSV to write, present only when write === true
}

function countDataRows(content: string): number {
  const rows = parseCsv(content);
  return rows.length === 0 ? 0 : rows.length - 1; // minus header
}

/**
 * Decide whether — and what — to write, without any I/O. Encodes every guard:
 *   - failed             -> never write
 *   - empty records      -> never write
 *   - success_no_new     -> do nothing
 *   - merged < existing  -> truncation, never write (append-only, so a smaller
 *                           merge means something went wrong)
 *   - invalid merge      -> abort (do not clobber)
 *   - success_new/partial that strictly ADDS rows and validates -> write
 *
 * existingContent is the current file contents, or null when the file doesn't
 * exist yet (first write bootstraps the header).
 */
export function planProcessorWrite(
  existingContent: string | null,
  records: ProcessorRecord[],
  observationDate: string,
  crawlOutcome: CrawlOutcome,
): WritePlan {
  if (crawlOutcome === "failed") return { write: false, reason: "failed -> skip" };
  if (records.length === 0) return { write: false, reason: "empty -> skip" };
  if (crawlOutcome === "success_no_new") return { write: false, reason: "success_no_new -> skip" };

  const hasExisting = !!existingContent && existingContent.trim().length > 0;
  const base = hasExisting ? existingContent! : PROCESSOR_CSV_HEADER.join(",") + "\n";
  const existingCount = hasExisting ? countDataRows(base) : 0;

  const newLines = serializeRows(records, observationDate);
  const sep = base.endsWith("\n") ? "" : "\n";
  const merged = `${base}${sep}${newLines.join("\n")}\n`;

  const mergedCount = countDataRows(merged);
  // Truncation guard: append can only grow the file. A merge with fewer rows
  // than we started with means data would be lost — refuse.
  if (mergedCount < existingCount) {
    return { write: false, reason: `truncation -> skip (merged ${mergedCount} < existing ${existingCount})` };
  }
  // partial (and success_new) must STRICTLY add rows.
  if (mergedCount <= existingCount) {
    return { write: false, reason: `no rows added -> skip (merged ${mergedCount} <= existing ${existingCount})` };
  }

  const validation = validateProcessorCsv(merged);
  if (!validation.ok) {
    return { write: false, reason: `validation -> abort (${validation.error})` };
  }

  return { write: true, reason: `${crawlOutcome} -> write (+${mergedCount - existingCount} rows)`, content: merged };
}

/**
 * Read + parse the existing the-store CSV into rows (Epic 9 dry-run/reporting).
 * This is the SINGLE read path — it reuses the same getFileContents primitive
 * and the same parseCsv the write path uses, so reporting never introduces a
 * second, drifting CSV reader. Returns the parsed rows INCLUDING the header row
 * (index 0), or an empty array when the-store is unconfigured or the file
 * doesn't exist yet. Fail-open: never throws — a missing/unreadable file just
 * yields no existing rows (so everything looks "new"), matching the append
 * path's own null-on-miss handling.
 */
export async function readExistingProcessorRows(config: ProcessorStoreConfig | undefined): Promise<string[][]> {
  if (!config) return [];
  let content: string | null;
  try {
    const token = await getInstallationToken(config.githubApp, config.installationId);
    content = await getFileContents(token, config.owner, config.repo, config.path, config.branch);
  } catch {
    content = null; // unconfigured token, file absent, or transient read error
  }
  if (!content || content.trim().length === 0) return [];
  return parseCsv(content);
}

/**
 * Retrieve the existing CSV, append the run's dated rows, validate the merged
 * result, and write it back — but only when the guards permit. Fail-open:
 * when config is undefined (the-store unset) the write is skipped with a
 * warning, matching integrations/the_store.ts. Never throws for a guard/
 * validation stop — those log and return; only unexpected GitHub API errors
 * propagate (the caller wraps this).
 */
export async function appendProcessorRecords(
  config: ProcessorStoreConfig | undefined,
  records: ProcessorRecord[],
  observationDate: string,
  crawlOutcome: CrawlOutcome,
): Promise<void> {
  const log = logger.withContext({ integration: "the-store", file: "payment-processors" });

  if (!config) {
    log.warn("the-store not configured — skipping processor-record persistence");
    return;
  }

  // Cheap guards first: no token minting for a run that can't write anyway.
  const preflight = planProcessorWrite("", records, observationDate, crawlOutcome);
  if (!preflight.write && (crawlOutcome === "failed" || records.length === 0 || crawlOutcome === "success_no_new")) {
    log.info("processor persistence skipped", { case: preflight.reason, records: records.length, outcome: crawlOutcome });
    return;
  }

  const token = await getInstallationToken(config.githubApp, config.installationId);

  let existing: string | null;
  try {
    existing = await getFileContents(token, config.owner, config.repo, config.path, config.branch);
  } catch {
    existing = null; // file doesn't exist yet — first write bootstraps the header
  }

  const plan = planProcessorWrite(existing, records, observationDate, crawlOutcome);
  if (!plan.write || !plan.content) {
    log.warn("processor persistence aborted by guard", { case: plan.reason, outcome: crawlOutcome, records: records.length });
    return;
  }

  await createOrUpdateFile(
    token,
    config.owner,
    config.repo,
    config.path,
    plan.content,
    `Add ${records.length} payment-processor record(s) — ${toObservationDay(observationDate)}`,
    config.branch,
  );
  log.info("processor records persisted to the-store", { case: plan.reason, records: records.length, outcome: crawlOutcome });
}
