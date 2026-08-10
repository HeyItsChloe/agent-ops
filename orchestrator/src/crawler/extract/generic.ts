// Generic, site-agnostic contact extraction (Ticket 29).
//
// The hard constraint from the Ticket 29 audit: NO dependency on
// site-specific CSS class names. A processor's "contact us" markup differs
// on every site and rots the moment they reskin — keying off class="..."
// would make this a per-site adapter in disguise. Instead we read only
// signals that carry semantic meaning across sites: mailto:/tel: hrefs,
// schema.org JSON-LD, <meta>/OpenGraph tags, and email/phone patterns in
// visible text. Per-site quirks are handled separately and opt-in by
// extract/adapters.ts (Ticket 30) — never here.
//
// This is intentionally regex/string based rather than DOM-parser based:
// the orchestrator has no HTML-parsing dependency (see package.json), and
// scrapeAll.ts already establishes the "hand HTML/text to logic, don't wire
// a per-site selector tree" convention. fetch.ts renders the page with
// Playwright and hands us the rendered HTML, so "rendered-DOM text" below is
// simply the tag-stripped fallback over that already-rendered markup.
import type { ExtractionMethod, ProcessorContact } from "../types.js";

export interface GenericExtractionResult {
  // Partial on purpose — only fields an actual signal produced. Missing
  // fields stay absent (Ticket 28: never fabricate).
  contact: Partial<ProcessorContact>;
  // Which signals contributed at least one field, in the order attempted.
  // provenance.ts scores confidence from this set.
  methods: ExtractionMethod[];
}

// Deliberately permissive email/phone patterns — precision over a page's
// visible text is impossible, so we accept and let downstream dedup/scoring
// sort noise out rather than dropping a real contact on a strict pattern.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// International-ish phone: optional +, groups of digits with common
// separators, 7+ digits total. Kept loose on purpose.
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const MAILTO_RE = /href\s*=\s*["']mailto:([^"'?]+)/gi;
const TEL_RE = /href\s*=\s*["']tel:([^"']+)/gi;
const JSONLD_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RE = /<meta\s+([^>]+?)\/?>/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;

// A page can contain hundreds of throwaway addresses (privacy@, noreply@,
// abuse@). We keep all we find but rank sales/support/general contact ones
// first so the primary picked email is the useful one.
const PREFERRED_EMAIL_LOCALPARTS = ["sales", "contact", "hello", "info", "support", "help"];

function firstMeaningful(values: string[]): string | undefined {
  return values.map((v) => v.trim()).find((v) => v.length > 0);
}

function pickPrimaryEmail(emails: string[]): string | undefined {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(Boolean);
  if (unique.length === 0) return undefined;
  const preferred = unique.find((e) => PREFERRED_EMAIL_LOCALPARTS.some((p) => e.startsWith(`${p}@`) || e.startsWith(`${p}.`)));
  return preferred ?? unique[0];
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// --- Individual signal extractors -----------------------------------------

// 1) mailto:/tel: links — the most explicit, machine-intended contact signal.
function fromMailtoTel(html: string): Partial<ProcessorContact> {
  const emails: string[] = [];
  const phones: string[] = [];
  for (const m of html.matchAll(MAILTO_RE)) emails.push(decodeURIComponent(m[1]));
  for (const m of html.matchAll(TEL_RE)) phones.push(m[1].trim());
  const out: Partial<ProcessorContact> = {};
  const email = pickPrimaryEmail(emails);
  if (email) out.email = email;
  const phone = firstMeaningful(phones);
  if (phone) out.phone = phone;
  return out;
}

interface JsonLdNode {
  "@type"?: string | string[];
  name?: string;
  url?: string;
  email?: string;
  telephone?: string;
  contactPoint?: JsonLdNode | JsonLdNode[];
  contactType?: string;
  [key: string]: unknown;
}

function typeMatches(node: JsonLdNode, wanted: string): boolean {
  const t = node["@type"];
  if (Array.isArray(t)) return t.some((x) => x?.toLowerCase() === wanted.toLowerCase());
  return typeof t === "string" && t.toLowerCase() === wanted.toLowerCase();
}

// Walk an arbitrarily nested JSON-LD graph looking for Organization and
// ContactPoint nodes. schema.org allows @graph arrays, nested contactPoints,
// and single-or-array everywhere, so we recurse rather than index fixed paths.
function collectJsonLdNodes(value: unknown, acc: JsonLdNode[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectJsonLdNodes(v, acc);
  } else if (value && typeof value === "object") {
    const node = value as JsonLdNode;
    acc.push(node);
    for (const v of Object.values(node)) collectJsonLdNodes(v, acc);
  }
}

// 2) JSON-LD (schema.org Organization / ContactPoint).
function fromJsonLd(html: string): Partial<ProcessorContact> {
  const nodes: JsonLdNode[] = [];
  for (const block of html.matchAll(JSONLD_RE)) {
    const jsonText = block[1].trim();
    if (!jsonText) continue;
    try {
      collectJsonLdNodes(JSON.parse(jsonText), nodes);
    } catch {
      // Malformed JSON-LD is common in the wild — skip this block, don't
      // fail the whole extraction over one bad <script>.
    }
  }
  const out: Partial<ProcessorContact> = {};
  const org = nodes.find((n) => typeMatches(n, "Organization"));
  if (org) {
    if (org.name) out.company_name = String(org.name);
    if (org.email) out.email = String(org.email).replace(/^mailto:/i, "");
    if (org.telephone) out.phone = String(org.telephone);
  }
  const contact = nodes.find((n) => typeMatches(n, "ContactPoint"));
  if (contact) {
    if (!out.email && contact.email) out.email = String(contact.email).replace(/^mailto:/i, "");
    if (!out.phone && contact.telephone) out.phone = String(contact.telephone);
  }
  return out;
}

// 3) <meta> / OpenGraph tags.
function fromMeta(html: string): Partial<ProcessorContact> {
  const out: Partial<ProcessorContact> = {};
  for (const m of html.matchAll(META_RE)) {
    const attrs = m[1];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!key || !content) continue;
    if ((key === "og:site_name" || key === "application-name" || key === "author") && !out.company_name) {
      out.company_name = content.trim();
    }
  }
  return out;
}

// 4) visible-text email/phone regex (over tag-stripped text).
function fromVisibleText(text: string): Partial<ProcessorContact> {
  const out: Partial<ProcessorContact> = {};
  const email = pickPrimaryEmail(text.match(EMAIL_RE) ?? []);
  if (email) out.email = email;
  const phone = firstMeaningful(text.match(PHONE_RE) ?? []);
  if (phone) out.phone = phone;
  return out;
}

// Contact/sales/support page links — classified by the link's own text/href
// keywords, not by any CSS class. These are navigational hints ("where do I
// go to talk to sales"), useful even when this page has no address itself.
function fromContactLinks(html: string, url: string): Partial<ProcessorContact> {
  const out: Partial<ProcessorContact> = {};
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1];
    // mailto:/tel: hrefs are already captured as email/phone — a *_url field
    // should be a navigable page, not a mailto link.
    if (/^\s*(mailto:|tel:)/i.test(href)) continue;
    const label = `${stripTags(m[2])} ${href}`.toLowerCase();
    const abs = absolute(href, url);
    if (!out.sales_url && /\bsales\b|contact-sales|talk-to-sales/.test(label)) out.sales_url = abs;
    else if (!out.support_url && /\bsupport\b|help\b|customer-service/.test(label)) out.support_url = abs;
    else if (!out.contact_url && /\bcontact\b|contact-us|get-in-touch/.test(label)) out.contact_url = abs;
  }
  return out;
}

function merge(target: Partial<ProcessorContact>, source: Partial<ProcessorContact>, methods: ExtractionMethod[], method: ExtractionMethod): void {
  let contributed = false;
  for (const [k, v] of Object.entries(source) as Array<[keyof ProcessorContact, string | undefined]>) {
    if (v && !target[k]) {
      target[k] = v;
      contributed = true;
    }
  }
  if (contributed) methods.push(method);
}

/**
 * Extract whatever contact facts the given HTML yields, trying signals in
 * descending order of trust and taking the FIRST non-empty value per field.
 * Site-agnostic — no CSS-class dependency (Ticket 29). Returns only fields a
 * signal actually produced plus which methods contributed (Ticket 28: no
 * fabrication; missing stays missing). Adapters (Ticket 30) are applied by
 * the caller AFTER this, only as a supplement/override.
 */
export function extractContacts(html: string, url: string): GenericExtractionResult {
  const contact: Partial<ProcessorContact> = {};
  const methods: ExtractionMethod[] = [];

  // domain is always derivable from the URL itself.
  const domain = domainFromUrl(url);
  if (domain) contact.domain = domain;
  contact.source_url = url;

  // Order matters: earlier = more trusted, and merge() keeps the first hit.
  merge(contact, fromMailtoTel(html), methods, "mailto_tel");
  merge(contact, fromJsonLd(html), methods, "json_ld");
  merge(contact, fromMeta(html), methods, "meta_opengraph");
  merge(contact, fromContactLinks(html, url), methods, "meta_opengraph");
  merge(contact, fromVisibleText(stripTags(html)), methods, "visible_text_regex");

  // "rendered-DOM text" fallback: if visible-text scanning of the raw markup
  // still found no email/phone, do one more pass over the fully tag-stripped
  // text (collapses nested inline markup around an address, entity noise,
  // etc.). Marked as the lowest-trust signal.
  if (!contact.email || !contact.phone) {
    const domText = stripTags(html);
    const fallback = fromVisibleText(domText);
    merge(contact, fallback, methods, "rendered_dom_text");
  }

  return { contact, methods };
}
