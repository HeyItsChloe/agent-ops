// Per-URL contact extraction (Ticket 28).
//
// Orchestrates one URL end to end: fetch -> generic extract -> (adapter
// supplement/override, if one resolves) -> a Partial<ProcessorContact> plus
// the set of extraction methods that contributed. Two invariants from the
// Ticket 28 audit:
//   - Never assume uniform HTML. Generic extraction (Ticket 29) runs FIRST
//     and always; adapters (Ticket 30) only supplement/override afterward.
//   - Missing fields stay empty — we never fabricate a value we didn't find.
import { extractContacts } from "./extract/generic.js";
import { resolve as resolveAdapter } from "./extract/adapters.js";
import type { ExtractionMethod, ProcessorContact } from "./types.js";
import type { PageFetcher } from "./fetch.js";

export interface ContactExtraction {
  contact: Partial<ProcessorContact>;
  methods: ExtractionMethod[];
}

/**
 * Extract a processor's contact facts from one URL. `fetcher` is injected so
 * this is testable and so all pages in a run share one rate-limiter (fetch.ts).
 * Generic-first, adapter-as-override — the core resolves generic extraction
 * before consulting any adapter (Ticket 30).
 */
export async function extractProcessorContact(fetcher: PageFetcher, url: string): Promise<ContactExtraction> {
  const page = await fetcher.fetch(url);

  // 1) Generic, site-agnostic extraction always runs first.
  const generic = extractContacts(page.html, page.finalUrl || url);
  const contact: Partial<ProcessorContact> = { ...generic.contact };
  const methods: ExtractionMethod[] = [...generic.methods];

  // 2) An adapter, if one matches, may supplement fields generic extraction
  // missed and override fields it is authoritative about for that site. It is
  // never the primary path — only a resolved-second override/supplement.
  const adapter = resolveAdapter(page.finalUrl || url);
  if (adapter) {
    const adapted = adapter.extract(page.html, page.finalUrl || url);
    let contributed = false;
    for (const [k, v] of Object.entries(adapted) as Array<[keyof ProcessorContact, string | undefined]>) {
      if (v) {
        contact[k] = v; // adapter is authoritative for the fields it returns
        contributed = true;
      }
    }
    if (contributed) methods.push("site_adapter");
  }

  // Missing fields simply stay absent — no fabrication (Ticket 28).
  return { contact, methods: [...new Set(methods)] };
}
