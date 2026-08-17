// End-to-end orchestration test with EVERY outward effect mocked via
// deps.overrides — no network. Verifies the scrape→dedup→store→generate→
// draft→notify flow wires together, respects the dedup target, produces a
// correct summary, and (critically) that the draft stage is the only place
// email is created (drafts-only carried end to end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOutreachPipeline, type OutreachPipelineDeps, type OutreachRunRequest } from "./run.js";
import { emptyIndex, type DedupIndex, type DedupStore } from "./dedup.js";
import type { Company, OutreachEmail, OutreachRunSummary, OutreachSkillConfig, OutreachVertical } from "./types.js";

const vertical: OutreachVertical = { label: "payment processors", searchTerms: ["psp"] };
const skillConfig: OutreachSkillConfig = {
  skill: "outreach-email",
  tone: "warm",
  cta: "a call",
  sender: { name: "Chloe", company: "Agent-Ops", email: "outreach@example.com" },
};

function company(name: string, website: string, email: string): Company {
  return { name, website, emails: [email], contacts: [], phones: [], discoveredAt: new Date().toISOString() };
}

function baseDeps(overrides: OutreachPipelineDeps["overrides"]): OutreachPipelineDeps {
  return {
    githubApp: { appId: "1", privateKey: "k" },
    installationId: "inst",
    liteLLM: { proxyUrl: "http://unused", virtualKey: "k" },
    modelAlias: "planning",
    controlRepoOwner: "HeyItsChloe",
    controlRepoName: "agent-ops",
    controlRepoBranch: "main",
    overrides,
  };
}

const req: OutreachRunRequest = { vertical, target: 2, skillConfig, correlationId: "test-corr", requestedBy: "test" };

test("full pipeline: scrape→dedup→store→generate→draft→notify produces a correct summary", async () => {
  const persisted: Company[][] = [];
  const drafted: OutreachEmail[][] = [];
  let notified: OutreachRunSummary | undefined;
  const savedIndexes: DedupIndex[] = [];

  const dedupStore: DedupStore = {
    load: async () => emptyIndex(),
    save: async (index) => {
      savedIndexes.push(index);
    },
  };

  const deps = baseDeps({
    scrape: {
      discover: async () => [],
      enrich: async (h) => company(h.company ?? "x", h.url, "x@x.com"),
      // scrape is overridden wholesale below via a fake scrapeCompanies path:
    },
    dedupStore,
    generate: {
      loadSkill: async () => "SKILL",
      chat: async () => '{"subject":"Hi","body":"Hello there"}',
    },
    persist: async (companies) => {
      persisted.push(companies);
      return { csvUrl: "https://csv", jsonUrl: "https://json", total: companies.length };
    },
    createDrafts: async (emails) => {
      drafted.push(emails);
      return { drafts: emails.map((e, i) => ({ id: `d${i}`, company: e.company, to: e.to })), failures: [] };
    },
    notify: async (summary) => {
      notified = summary;
    },
  });

  // Override scrape.discover to actually return candidates (the enrich above
  // turns them into companies). Two unique + one duplicate name.
  deps.overrides!.scrape!.discover = async () => [
    { url: "https://a.com", company: "Alpha" },
    { url: "https://b.com", company: "Beta" },
    { url: "https://a2.com", company: "Alpha" }, // dup name → excluded
  ];

  const summary = await runOutreachPipeline(deps, req);

  assert.equal(summary.companiesCollected, 2); // target=2, dup excluded
  assert.equal(summary.draftsCreated, 2);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.storeCsvUrl, "https://csv");
  assert.equal(persisted[0].length, 2);
  assert.equal(drafted[0].length, 2);
  assert.equal(savedIndexes.length, 1); // dedup index persisted after store
  assert.ok(notified);
  assert.equal(notified!.draftsCreated, 2);
});

test("fail-open: no store/gmail/discord configured → no throw, warnings only", async () => {
  const deps = baseDeps({
    scrape: {
      discover: async () => [{ url: "https://a.com", company: "Alpha" }],
      enrich: async (h) => company(h.company ?? "x", h.url, "x@x.com"),
    },
    generate: { loadSkill: async () => "SKILL", chat: async () => '{"subject":"Hi","body":"Body"}' },
    // no dedupStore, no persist, no createDrafts, no notify → all fail-open
  });

  const summary = await runOutreachPipeline(deps, { ...req, target: 1 });
  // Company collected + email generated, but no store/draft/notify happened.
  assert.equal(summary.companiesCollected, 1);
  assert.equal(summary.draftsCreated, 0);
  assert.equal(summary.failures.length, 0);
});

test("generate failure for one company is isolated and recorded", async () => {
  const deps = baseDeps({
    scrape: {
      discover: async () => [
        { url: "https://a.com", company: "Alpha" },
        { url: "https://b.com", company: "Beta" },
      ],
      enrich: async (h) => company(h.company ?? "x", h.url, h.company === "Beta" ? "" : "x@x.com"),
    },
    generate: { loadSkill: async () => "SKILL", chat: async () => '{"subject":"Hi","body":"Body"}' },
    createDrafts: async (emails) => ({ drafts: emails.map((e, i) => ({ id: `d${i}`, company: e.company, to: e.to })), failures: [] }),
  });

  const summary = await runOutreachPipeline(deps, { ...req, target: 2 });
  // Beta has no email → generate fails for Beta, Alpha drafts fine.
  assert.equal(summary.companiesCollected, 2);
  assert.equal(summary.draftsCreated, 1);
  assert.equal(summary.failures.filter((f) => f.stage === "generate").length, 1);
});
