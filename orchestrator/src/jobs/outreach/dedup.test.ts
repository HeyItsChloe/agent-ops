// Unit tests for dedup normalization + selection. No network — pure logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, normalizeName, dedupKeys, DedupSet, emptyIndex, selectNewCompanies } from "./dedup.js";
import type { Company } from "./types.js";

function company(name: string, website?: string): Company {
  return { name, website, emails: [], contacts: [], phones: [], discoveredAt: new Date().toISOString() };
}

test("normalizeDomain collapses scheme, www, path, case, trailing slash", () => {
  assert.equal(normalizeDomain("https://www.Stripe.com/gb/"), "stripe.com");
  assert.equal(normalizeDomain("http://stripe.com/"), "stripe.com");
  assert.equal(normalizeDomain("stripe.com"), "stripe.com");
  assert.equal(normalizeDomain("WWW.STRIPE.COM"), "stripe.com");
  assert.equal(normalizeDomain(undefined), "");
  assert.equal(normalizeDomain("   "), "");
});

test("normalizeName strips suffixes/punctuation and collapses whitespace", () => {
  assert.equal(normalizeName("Stripe, Inc."), "stripe");
  assert.equal(normalizeName("stripe inc"), "stripe");
  assert.equal(normalizeName("Stripe"), "stripe");
  assert.equal(normalizeName("Adyen N.V."), "adyen n v".replace(/\s+/g, " ").trim()); // suffix list doesn't strip N.V., but punctuation is removed
  assert.equal(normalizeName("Block Payments LLC"), "block");
  assert.equal(normalizeName(undefined), "");
});

test("dedupKeys produces both domain and name keys", () => {
  const keys = dedupKeys({ name: "Stripe, Inc.", website: "https://www.stripe.com" });
  assert.equal(keys.domainKey, "stripe.com");
  assert.equal(keys.nameKey, "stripe");
});

test("DedupSet matches on domain OR name", () => {
  const set = new DedupSet(emptyIndex());
  set.add(company("Stripe", "https://stripe.com"));
  // Same domain, different displayed name → duplicate.
  assert.equal(set.isDuplicate(company("Stripe Payments", "http://www.stripe.com/enterprise")), true);
  // Same normalized name, no website → duplicate.
  assert.equal(set.isDuplicate(company("Stripe, Inc.")), true);
  // Genuinely different company → not a duplicate.
  assert.equal(set.isDuplicate(company("Adyen", "https://adyen.com")), false);
});

test("selectNewCompanies guarantees at most `limit` new, non-duplicate companies", () => {
  const seen = new DedupSet(emptyIndex());
  seen.add(company("Existing Co", "existing.com"));

  const candidates: Company[] = [
    company("Existing Co", "https://existing.com"), // dup against index
    company("Alpha Pay", "https://alpha.com"),
    company("Alpha Payments Inc", "https://alpha.com"), // dup against Alpha (same domain) in-batch
    company("Beta Gateway", "https://beta.com"),
    company("Gamma", "https://gamma.com"),
    company("", ""), // nothing to dedup on → skipped
  ];

  const picked = selectNewCompanies(candidates, seen, 2);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((c) => c.name), ["Alpha Pay", "Beta Gateway"]);

  // A subsequent pass keeps excluding what the same DedupSet already accepted.
  const more = selectNewCompanies([company("Beta Gateway", "https://beta.com"), company("Delta", "https://delta.com")], seen, 5);
  assert.deepEqual(more.map((c) => c.name), ["Delta"]);
});

test("DedupSet.toIndex round-trips into a new DedupSet", () => {
  const set = new DedupSet(emptyIndex());
  set.add(company("Stripe", "stripe.com"));
  const index = set.toIndex();
  const restored = new DedupSet(index);
  assert.equal(restored.isDuplicate(company("Stripe", "https://stripe.com")), true);
});
