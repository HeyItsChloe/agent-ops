// Skill -> email rendering tests with a MOCKED LLM (no network). Verifies:
//   - the skill body is used as the system prompt (skill owns content)
//   - the company + config are passed as the user prompt
//   - fenced JSON from the model is tolerated (parseModelJson)
//   - recipient selection prefers a contact email, then a general email
//   - missing recipient / bad model output are surfaced as errors
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEmail, buildGeneratePrompt, pickRecipient, OUTPUT_CONTRACT, type GenerateDeps } from "./generate.js";
import type { Company, OutreachSkillConfig } from "./types.js";

const skillConfig: OutreachSkillConfig = {
  skill: "outreach-email",
  tone: "warm, concise, professional",
  cta: "a brief 15-minute intro call",
  sender: { name: "Chloe", company: "Agent-Ops", role: "Partnerships", email: "outreach@example.com" },
  variables: { offer: "instant payouts" },
};

function company(overrides: Partial<Company> = {}): Company {
  return {
    name: "Stripe",
    website: "https://stripe.com",
    emails: ["info@stripe.com"],
    contacts: [{ name: "Pat", title: "BD", email: "pat@stripe.com" }],
    phones: [],
    businessInfo: "Payments infrastructure",
    companyContext: "Large PSP, good integration fit",
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

test("pickRecipient prefers a contact email, then a general email", () => {
  assert.equal(pickRecipient(company()), "pat@stripe.com");
  assert.equal(pickRecipient(company({ contacts: [] })), "info@stripe.com");
  assert.equal(pickRecipient(company({ contacts: [], emails: [] })), undefined);
});

test("buildGeneratePrompt includes skill, tone, cta, sender, variables and company", () => {
  const prompt = buildGeneratePrompt(company(), skillConfig);
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.skill, "outreach-email");
  assert.equal(parsed.cta, "a brief 15-minute intro call");
  assert.equal(parsed.sender.name, "Chloe");
  assert.equal(parsed.variables.offer, "instant payouts");
  assert.equal(parsed.company.name, "Stripe");
});

test("generateEmail renders from the skill body (system prompt) + config, mocked LLM", async () => {
  let capturedSystem = "";
  let capturedUser = "";
  const deps: GenerateDeps = {
    loadSkill: async (skill) => `SKILL BODY for ${skill}`,
    chat: async (system, user) => {
      capturedSystem = system;
      capturedUser = user;
      // Model wraps in a fence (parseModelJson must tolerate it).
      return '```json\n{"subject":"Quick idea for Stripe","body":"Hi Pat,\\nLet\'s talk.\\n— Chloe"}\n```';
    },
  };

  const email = await generateEmail(company(), skillConfig, deps);

  // Skill body IS the system prompt (skill owns content), with the output contract appended.
  assert.ok(capturedSystem.startsWith("SKILL BODY for outreach-email"));
  assert.ok(capturedSystem.includes(OUTPUT_CONTRACT.trim().slice(0, 20)));
  // Company + config went in the user prompt.
  assert.ok(capturedUser.includes("Stripe"));

  assert.equal(email.to, "pat@stripe.com");
  assert.equal(email.subject, "Quick idea for Stripe");
  assert.ok(email.body.includes("Hi Pat,"));
  assert.equal(email.company, "Stripe");
});

test("generateEmail throws when no recipient email exists", async () => {
  const deps: GenerateDeps = { loadSkill: async () => "SKILL", chat: async () => "{}" };
  await assert.rejects(() => generateEmail(company({ contacts: [], emails: [] }), skillConfig, deps), /no recipient email/);
});

test("generateEmail throws on unparseable model output", async () => {
  const deps: GenerateDeps = { loadSkill: async () => "SKILL", chat: async () => "not json at all", retry: { retries: 0 } };
  await assert.rejects(() => generateEmail(company(), skillConfig, deps), /not valid JSON/);
});

test("generateEmail throws when subject/body missing", async () => {
  const deps: GenerateDeps = { loadSkill: async () => "SKILL", chat: async () => '{"subject":"only subject"}', retry: { retries: 0 } };
  await assert.rejects(() => generateEmail(company(), skillConfig, deps), /missing subject or body/);
});
