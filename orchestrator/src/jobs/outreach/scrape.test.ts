// Scrape/enrich tests with fully injected discover + enrich (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrapeCompanies, normalizeEnriched, modelEnrich, buildEnrichPrompt, type DiscoveryHit, type ScrapeDeps } from "./scrape.js";
import type { OutreachVertical } from "./types.js";

const vertical: OutreachVertical = { label: "payment processors", searchTerms: ["psp companies", "payment gateways"] };

test("normalizeEnriched backfills required arrays and falls back to hit data", () => {
  const hit: DiscoveryHit = { url: "https://stripe.com", company: "Stripe", title: "Stripe | Payments" };
  const c = normalizeEnriched({ emails: ["a@stripe.com", 42], contacts: [{ name: "Pat" }, "junk"] }, hit);
  assert.equal(c.name, "Stripe"); // from hit.company since model omitted name
  assert.equal(c.website, "https://stripe.com");
  assert.deepEqual(c.emails, ["a@stripe.com"]); // non-strings filtered
  assert.equal(c.contacts.length, 1);
  assert.equal(c.contacts[0].name, "Pat");
  assert.deepEqual(c.phones, []);
  assert.ok(c.discoveredAt);
});

test("modelEnrich degrades to bare hit on unparseable model output", async () => {
  const enrich = modelEnrich(async () => "not json");
  const c = await enrich({ url: "https://acme.com", company: "Acme" });
  assert.equal(c.name, "Acme");
  assert.equal(c.website, "https://acme.com");
});

test("buildEnrichPrompt includes url and available metadata", () => {
  const p = buildEnrichPrompt({ url: "https://x.com", company: "X", title: "T", snippet: "S" });
  assert.ok(p.includes("https://x.com"));
  assert.ok(p.includes("Company (from search): X"));
  assert.ok(p.includes("Snippet: S"));
});

test("scrapeCompanies discovers across seed terms, dedups URLs, isolates enrich failures", async () => {
  const deps: ScrapeDeps = {
    discover: async (query) =>
      query === "psp companies"
        ? [{ url: "https://a.com", company: "A" }, { url: "https://b.com", company: "B" }]
        : [{ url: "https://b.com", company: "B" }, { url: "https://c.com", company: "C" }], // b duplicated across terms
    enrich: async (hit) => {
      if (hit.url === "https://b.com") throw new Error("enrich boom");
      return normalizeEnriched({ name: hit.company }, hit);
    },
    retry: { retries: 0 },
  };

  const warnings: string[] = [];
  const result = await scrapeCompanies(vertical, 25, { ...deps, onWarn: (m) => warnings.push(m) });
  // a, b, c discovered (b deduped to one); b's enrichment fails → a, c succeed.
  assert.deepEqual(result.map((c) => c.name).sort(), ["A", "C"]);
  assert.ok(warnings.some((w) => w.includes("enrichment failed")));
});

test("scrapeCompanies isolates a failing discovery query", async () => {
  const deps: ScrapeDeps = {
    discover: async (query) => {
      if (query === "psp companies") throw new Error("discovery down");
      return [{ url: "https://c.com", company: "C" }];
    },
    enrich: async (hit) => normalizeEnriched({ name: hit.company }, hit),
    retry: { retries: 0 },
  };
  const warnings: string[] = [];
  const result = await scrapeCompanies(vertical, 25, { ...deps, onWarn: (m) => warnings.push(m) });
  assert.deepEqual(result.map((c) => c.name), ["C"]);
  assert.ok(warnings.some((w) => w.includes("discovery query failed")));
});
