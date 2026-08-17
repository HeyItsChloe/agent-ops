// Persistent dedup index for the outreach pipeline. The dedup key is a
// normalized domain + normalized company name (issue #11's spec). The index
// itself lives in the storage repo (the-store) as a small JSON file, loaded
// once per run and written back after a successful store — same GitHub App
// token / createOrUpdateFile pattern as the_store.ts, and the same fail-open
// posture (a missing index file means "nothing seen yet", not an error).
//
// This module holds the *pure* normalization + set logic (unit-tested with
// no network). Loading/saving the index is done via the injected
// DedupStore interface so the handler can wire it to the-store and tests can
// wire it to an in-memory fake.

import type { Company } from "./types.js";

// Strips scheme, www., trailing slash, path, and lowercases — so
// "https://www.Stripe.com/gb", "stripe.com", and "http://stripe.com/" all
// collapse to "stripe.com". Falls back to a plain lowercase/trim for
// anything that isn't a parseable URL (a bare domain string, mostly), rather
// than throwing on one malformed value — same forgiving contract as
// the_store.ts's normalizeUrl.
export function normalizeDomain(websiteOrDomain: string | undefined): string {
  if (!websiteOrDomain) return "";
  const raw = websiteOrDomain.trim();
  if (!raw) return "";
  let host: string;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    host = new URL(withScheme).hostname;
  } catch {
    host = raw;
  }
  return host.toLowerCase().replace(/^www\./, "").replace(/\/$/, "").trim();
}

// Normalizes a company name for dedup: lowercased, common corporate suffixes
// and punctuation removed, whitespace collapsed. "Stripe, Inc." and
// "stripe inc" and "Stripe" all collapse to "stripe". Deliberately
// aggressive — a false-positive dedup (skipping a company that's arguably
// distinct) is cheaper here than mailing the same company twice.
export function normalizeName(name: string | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|sas|bv|holdings|group|technologies|technology|labs|solutions|systems|payments|pay)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The two composite keys a company can match on. A company matches the index
// if EITHER its domain key OR its name key is already present — domain is the
// stronger signal, but a company scraped without a website still dedups on
// name, and vice versa.
export function dedupKeys(company: Pick<Company, "name" | "website">): { domainKey: string; nameKey: string } {
  return {
    domainKey: normalizeDomain(company.website),
    nameKey: normalizeName(company.name),
  };
}

// The on-disk shape of the dedup index in the-store.
export interface DedupIndex {
  domains: string[];
  names: string[];
  updatedAt: string;
}

export function emptyIndex(): DedupIndex {
  return { domains: [], names: [], updatedAt: new Date(0).toISOString() };
}

// A fast lookup wrapper over a DedupIndex. Built once per run from the loaded
// index; `isDuplicate` is the hot path the scraper calls per candidate.
export class DedupSet {
  private domains: Set<string>;
  private names: Set<string>;

  constructor(index: DedupIndex) {
    this.domains = new Set(index.domains.filter(Boolean));
    this.names = new Set(index.names.filter(Boolean));
  }

  isDuplicate(company: Pick<Company, "name" | "website">): boolean {
    const { domainKey, nameKey } = dedupKeys(company);
    if (domainKey && this.domains.has(domainKey)) return true;
    if (nameKey && this.names.has(nameKey)) return true;
    return false;
  }

  // Records a company as seen, so later candidates in the SAME run also dedup
  // against it (two discovery passes can surface the same company twice).
  add(company: Pick<Company, "name" | "website">): void {
    const { domainKey, nameKey } = dedupKeys(company);
    if (domainKey) this.domains.add(domainKey);
    if (nameKey) this.names.add(nameKey);
  }

  toIndex(): DedupIndex {
    return {
      domains: [...this.domains].sort(),
      names: [...this.names].sort(),
      updatedAt: new Date().toISOString(),
    };
  }
}

// Filters a batch of freshly-scraped candidates down to genuinely NEW,
// non-duplicate companies, deduping both against the persistent index AND
// within the batch itself. Mutates the passed DedupSet so subsequent calls
// (across discovery retries) keep excluding what's already been accepted.
// Returns at most `limit` new companies.
export function selectNewCompanies(candidates: Company[], seen: DedupSet, limit: number): Company[] {
  const accepted: Company[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= limit) break;
    if (!candidate.name && !candidate.website) continue; // nothing to dedup on
    if (seen.isDuplicate(candidate)) continue;
    seen.add(candidate);
    accepted.push(candidate);
  }
  return accepted;
}

// Injected persistence seam — the handler binds this to the-store; tests
// bind it to an in-memory fake so dedup logic is tested with no network.
export interface DedupStore {
  load(): Promise<DedupIndex>;
  save(index: DedupIndex): Promise<void>;
}
