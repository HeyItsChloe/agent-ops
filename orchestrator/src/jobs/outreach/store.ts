// Storage for the outreach pipeline. Writes structured CSV + JSON to the
// storage repo (the-store) using the SAME GitHub App token →
// createOrUpdateFile pattern as integrations/the_store.ts, and the SAME
// fail-open posture: if the-store config is unset, writes are skipped with a
// warning rather than failing the run.
//
// Layout (issue #11):
//   projects/outreach/<vertical>/companies.csv    (cumulative, appended)
//   projects/outreach/<vertical>/companies.json   (cumulative, rewritten)
//   projects/outreach/<vertical>/snapshots/<date>.json  (per-day run snapshot)
//   projects/outreach/<vertical>/dedup-index.json (dedup persistence)
//
// The CSV escaping / parsing helpers mirror the_store.ts exactly (a company
// context or business-info cell routinely holds commas and newlines).

import { createOrUpdateFile, getFileContents, getInstallationToken, type GitHubAppConfig } from "../../integrations/github.js";
import type { DedupIndex, DedupStore } from "./dedup.js";
import { emptyIndex } from "./dedup.js";
import type { Company } from "./types.js";

export interface OutreachStoreConfig {
  owner: string; // default HeyItsChloe
  repo: string; // default the-store
  branch: string; // default main
  basePath: string; // default projects/outreach/payment-processors
}

export function defaultBasePath(verticalLabel: string): string {
  const slug = verticalLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "vertical";
  return `projects/outreach/${slug}`;
}

const CSV_HEADER = [
  "discovered_at",
  "name",
  "website",
  "emails",
  "contacts",
  "linkedin",
  "phones",
  "business_info",
  "company_context",
  "source_url",
];

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function companyToCsvLine(c: Company): string {
  return [
    c.discoveredAt,
    c.name,
    c.website ?? "",
    c.emails.join("; "),
    JSON.stringify(c.contacts),
    c.linkedin ?? "",
    c.phones.join("; "),
    c.businessInfo ?? "",
    c.companyContext ?? "",
    c.sourceUrl ?? "",
  ]
    .map((v) => csvEscape(String(v)))
    .join(",");
}

export function companiesToCsv(companies: Company[]): string {
  return [CSV_HEADER.join(","), ...companies.map(companyToCsvLine)].join("\n") + "\n";
}

export function fileUrl(config: OutreachStoreConfig, relativePath: string): string {
  return `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${config.basePath}/${relativePath}`;
}

// The GitHub App auth this store needs — same shape the_store.ts threads.
export interface StoreAuth {
  githubApp: GitHubAppConfig;
  installationId: string;
}

async function readFile(auth: StoreAuth, config: OutreachStoreConfig, relativePath: string): Promise<string | undefined> {
  const token = await getInstallationToken(auth.githubApp, auth.installationId);
  try {
    return await getFileContents(token, config.owner, config.repo, `${config.basePath}/${relativePath}`, config.branch);
  } catch {
    return undefined;
  }
}

async function writeFile(auth: StoreAuth, config: OutreachStoreConfig, relativePath: string, content: string, message: string): Promise<void> {
  const token = await getInstallationToken(auth.githubApp, auth.installationId);
  await createOrUpdateFile(token, config.owner, config.repo, `${config.basePath}/${relativePath}`, content, message, config.branch);
}

// Persists a batch of NEW companies: appends to the cumulative CSV, rewrites
// the cumulative JSON, and drops a per-day snapshot. Returns viewable URLs
// for the Discord summary. Not atomic under concurrent writes (read-modify-
// write) — acceptable at daily-run scale, same limitation the_store.ts notes.
export async function persistCompanies(
  auth: StoreAuth,
  config: OutreachStoreConfig,
  newCompanies: Company[],
  dateStamp = new Date().toISOString().slice(0, 10),
): Promise<{ csvUrl: string; jsonUrl: string; total: number }> {
  // JSON (cumulative): read existing, concat, rewrite.
  const existingJsonRaw = await readFile(auth, config, "companies.json");
  let existing: Company[] = [];
  if (existingJsonRaw) {
    try {
      existing = JSON.parse(existingJsonRaw) as Company[];
    } catch {
      existing = [];
    }
  }
  const combined = [...existing, ...newCompanies];
  await writeFile(auth, config, "companies.json", JSON.stringify(combined, null, 2) + "\n", `outreach: +${newCompanies.length} companies (JSON)`);

  // CSV (cumulative): append new lines to existing, or write header + lines.
  const existingCsv = await readFile(auth, config, "companies.csv");
  let csv: string;
  if (existingCsv && existingCsv.trim()) {
    const sep = existingCsv.endsWith("\n") ? "" : "\n";
    csv = existingCsv + sep + newCompanies.map(companyToCsvLine).join("\n") + "\n";
  } else {
    csv = companiesToCsv(newCompanies);
  }
  await writeFile(auth, config, "companies.csv", csv, `outreach: +${newCompanies.length} companies (CSV)`);

  // Per-day snapshot: only this run's new companies.
  await writeFile(
    auth,
    config,
    `snapshots/${dateStamp}.json`,
    JSON.stringify({ date: dateStamp, count: newCompanies.length, companies: newCompanies }, null, 2) + "\n",
    `outreach: snapshot ${dateStamp} (${newCompanies.length})`,
  );

  return { csvUrl: fileUrl(config, "companies.csv"), jsonUrl: fileUrl(config, "companies.json"), total: combined.length };
}

// Binds the persistent dedup index (dedup-index.json in the-store) to the
// DedupStore seam dedup.ts expects. Fail-open on load (missing file → empty).
export function makeDedupStore(auth: StoreAuth, config: OutreachStoreConfig): DedupStore {
  return {
    async load(): Promise<DedupIndex> {
      const raw = await readFile(auth, config, "dedup-index.json");
      if (!raw) return emptyIndex();
      try {
        const parsed = JSON.parse(raw) as Partial<DedupIndex>;
        return {
          domains: Array.isArray(parsed.domains) ? parsed.domains : [],
          names: Array.isArray(parsed.names) ? parsed.names : [],
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        };
      } catch {
        return emptyIndex();
      }
    },
    async save(index: DedupIndex): Promise<void> {
      await writeFile(auth, config, "dedup-index.json", JSON.stringify(index, null, 2) + "\n", "outreach: update dedup index");
    },
  };
}
