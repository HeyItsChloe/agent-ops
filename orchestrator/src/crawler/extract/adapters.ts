// Opt-in per-site adapters (Ticket 30).
//
// Generic extraction (extract/generic.ts, Ticket 29) is the default and the
// primary path — it is tried FIRST and handles the long tail of processor
// sites with no bespoke code. Adapters exist only for the handful of sites
// where generic extraction is provably insufficient (heavy client-side
// rendering that buries the contact behind app state, a deliberately
// obfuscated address, a known non-standard contact layout). They are:
//
//   - OPT-IN: nothing is adapted unless a matching adapter is registered.
//   - SUPPLEMENTAL/OVERRIDE ONLY: the core (contact.ts) runs generic
//     extraction first and only then asks resolve(url) whether an adapter
//     wants to supplement or override specific fields. An adapter never
//     replaces the generic pass.
//   - NARROW: an adapter fills gaps or corrects a field for one site; it is
//     not a licence to reintroduce CSS-class coupling as the main strategy.
//
// This mirrors the job-search pipeline's own two-tier scraping model
// (src/types.ts ScrapingAdapterName: named per-site adapters + a generic
// fallback), inverted appropriately: there the named adapter is preferred;
// here generic is preferred and the named adapter is the exception.
import type { ProcessorContact } from "../types.js";

export interface SiteAdapter {
  // Stable identifier for logging/provenance (e.g. "example-processor").
  id: string;
  // Whether this adapter applies to the given URL. Keyed off hostname/path,
  // never off page markup — resolution must be decidable before fetching.
  matches(url: string): boolean;
  // Extract site-specific fields from already-fetched HTML. Returns only the
  // fields this adapter is confident about; everything else is left to the
  // generic pass. Must not fabricate (Ticket 28).
  extract(html: string, url: string): Partial<ProcessorContact>;
}

const registry: SiteAdapter[] = [];

/** Register an adapter. Later registrations take precedence in resolve(). */
export function register(adapter: SiteAdapter): void {
  // Replace an existing adapter with the same id rather than stacking dupes,
  // so re-registration (tests, hot reload) is idempotent.
  const existing = registry.findIndex((a) => a.id === adapter.id);
  if (existing >= 0) registry.splice(existing, 1);
  registry.push(adapter);
}

/**
 * Resolve the adapter for a URL, if any. Returns the most-recently-registered
 * matching adapter (so a caller can override a built-in). undefined means
 * "no adapter — generic extraction stands on its own", which is the common
 * case by design.
 */
export function resolve(url: string): SiteAdapter | undefined {
  for (let i = registry.length - 1; i >= 0; i--) {
    try {
      if (registry[i].matches(url)) return registry[i];
    } catch {
      // A broken matches() must not take out resolution for every other site.
    }
  }
  return undefined;
}

/** Test/utility hook — clear the registry (used by unit tests). */
export function _resetForTests(): void {
  registry.length = 0;
}

// --- Example adapter -------------------------------------------------------
//
// Illustrative only. It demonstrates the shape and the "supplement a field
// generic extraction is likely to miss" intent — here, pulling a company
// name out of a hypothetical site's non-standard data attribute. It is
// registered below so the registry is non-empty for wiring/tests, but real
// deployments would register their own. Note it returns ONLY the field it is
// confident about and leaves everything else to the generic pass.
export const exampleProcessorAdapter: SiteAdapter = {
  id: "example-processor",
  matches(url: string): boolean {
    try {
      return new URL(url).hostname.replace(/^www\./, "") === "example-processor.com";
    } catch {
      return false;
    }
  },
  extract(html: string, _url: string): Partial<ProcessorContact> {
    const out: Partial<ProcessorContact> = {};
    // Example of a site-specific hint generic extraction wouldn't key off:
    // a bespoke data attribute this one site emits. Real adapters live here.
    const m = /data-company-legal-name\s*=\s*["']([^"']+)["']/i.exec(html);
    if (m) out.company_name = m[1].trim();
    return out;
  },
};

register(exampleProcessorAdapter);
