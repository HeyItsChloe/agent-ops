// Processor identity + dedup (Ticket 31).
//
// The same processor surfaces under many URLs (marketing site, docs subdomain,
// a /contact page, a third-party listing) and under name variants ("Stripe",
// "Stripe, Inc.", "Stripe Payments"). A stable processor_id collapses those to
// one logical identity so the record set has one row per processor, not one
// per page. These are PURE functions (no I/O, no clock) so they are directly
// unit-testable — the Ticket 31 requirement.
import type { ProcessorContact, ProcessorRecord } from "./types.js";

// Known aliases -> canonical name. Aliases are how we recognise that two
// differently-spelled records are the same processor even when their domains
// differ (e.g. a processor operating a separate docs/checkout domain). This
// is a small, curated map; discovery.ts's classification is the fuzzy tier,
// this is the exact tier.
const KNOWN_ALIASES: Record<string, string> = {
  "stripe inc": "stripe",
  "stripe payments": "stripe",
  "braintree a paypal service": "braintree",
  "square inc": "square",
  "block inc": "square",
  "adyen nv": "adyen",
};

// Corporate suffixes stripped when normalizing a company name — they vary by
// filing/region and are pure noise for identity matching.
const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|nv|n\.v|sa|s\.a|plc|pbc)\b/g;

/** Lowercase, strip punctuation/suffixes/whitespace-runs, apply aliases. */
export function normalizeCompanyName(name: string | undefined): string {
  if (!name) return "";
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return KNOWN_ALIASES[base] ?? base;
}

// Canonical registrable-ish domain: lowercase host, strip leading www. and a
// couple of common non-identity subdomains (docs./support./www.) so a
// processor's marketing and docs hosts fold together. This is a heuristic,
// not a full public-suffix parse (no PSL dependency); documented as such.
const NON_IDENTITY_SUBDOMAINS = /^(www|docs|support|help|developer|developers|api|checkout|dashboard|app|blog)\./;

export function canonicalDomain(input: string | undefined): string {
  if (!input) return "";
  let host = input.trim().toLowerCase();
  // Accept either a bare domain or a full URL.
  try {
    if (host.includes("/") || host.includes(":")) host = new URL(host.includes("//") ? host : `https://${host}`).hostname;
  } catch {
    // fall through with whatever we have
  }
  host = host.replace(/^www\./, "");
  // Peel a single known non-identity subdomain (one level) so docs.x.com and
  // x.com match; deeper/unknown subdomains are left intact to avoid
  // over-collapsing distinct properties.
  host = host.replace(NON_IDENTITY_SUBDOMAINS, "");
  return host;
}

/**
 * Stable identity for a processor, derived from its canonical domain first
 * (most reliable), falling back to its normalized company name when no domain
 * is known. Two records that share either a canonical domain or a normalized
 * name (post-alias) resolve to the same id. Pure + deterministic.
 */
export function processorIdFor(contact: Pick<ProcessorContact, "domain" | "company_name" | "source_url">): string {
  const domain = canonicalDomain(contact.domain ?? contact.source_url);
  if (domain) return `domain:${domain}`;
  const name = normalizeCompanyName(contact.company_name);
  if (name) return `name:${name.replace(/\s+/g, "-")}`;
  return "unknown";
}

// Prefer the more-complete / higher-confidence value when merging two records
// of the same processor. A non-empty field beats empty; between two non-empty,
// the higher-confidence record's value wins, then the longer string (more
// specific) as a final tie-break.
function preferValue(a: string | undefined, aConf: number, b: string | undefined, bConf: number): string | undefined {
  if (a && !b) return a;
  if (b && !a) return b;
  if (!a && !b) return undefined;
  if (aConf !== bConf) return aConf > bConf ? a : b;
  return (a?.length ?? 0) >= (b?.length ?? 0) ? a : b;
}

function mergeRecords(a: ProcessorRecord, b: ProcessorRecord): ProcessorRecord {
  const ac = a.provenance.confidence;
  const bc = b.provenance.confidence;
  const keep = ac >= bc ? a : b;
  return {
    ...keep,
    company_name: preferValue(a.company_name, ac, b.company_name, bc),
    domain: preferValue(a.domain, ac, b.domain, bc),
    contact_name: preferValue(a.contact_name, ac, b.contact_name, bc),
    email: preferValue(a.email, ac, b.email, bc),
    phone: preferValue(a.phone, ac, b.phone, bc),
    contact_url: preferValue(a.contact_url, ac, b.contact_url, bc),
    sales_url: preferValue(a.sales_url, ac, b.sales_url, bc),
    support_url: preferValue(a.support_url, ac, b.support_url, bc),
    processor_id: keep.processor_id,
    provenance: {
      // Keep the winning record's stamp but union the extraction methods and
      // take the max confidence — the merged record is at least as evidenced
      // as its best contributor.
      source_url: keep.provenance.source_url,
      observation_date: keep.provenance.observation_date,
      extraction_method: [...new Set([...a.provenance.extraction_method, ...b.provenance.extraction_method])],
      confidence: Math.max(ac, bc),
    },
  };
}

/**
 * Collapse multiple URLs/pages of the same processor into one logical record
 * per processor_id, merging their fields (Ticket 31). Deterministic and pure:
 * given the same input order, produces the same output. Input order is
 * preserved for first-seen ids.
 */
export function dedupe(records: ProcessorRecord[]): ProcessorRecord[] {
  const byId = new Map<string, ProcessorRecord>();
  const order: string[] = [];
  for (const rec of records) {
    const id = rec.processor_id || processorIdFor(rec);
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, mergeRecords(existing, rec));
    } else {
      byId.set(id, rec);
      order.push(id);
    }
  }
  return order.map((id) => byId.get(id)!);
}
