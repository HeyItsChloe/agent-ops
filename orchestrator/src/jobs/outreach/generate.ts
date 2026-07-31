// Email generation: renders an outreach email for a company ENTIRELY from
// the configured skill (skills/outreach/<skill>/SKILL.md) plus the skill
// config (tone, CTA, sender identity, variables) — issue #11's requirement
// that email content is owned by the skill, not hardcoded prompts.
//
// The skill markdown is the system prompt; the company data + config are the
// user prompt. The model returns structured JSON ({subject, body}) which we
// parse with the shared fenced-JSON parser. The skill body is fetched via
// the GitHub integration at request time (same reason run_personal_pipeline
// fetches skills live — the orchestrator container's build context is scoped
// to orchestrator/ and doesn't include skills/).

import { parseModelJson } from "../../integrations/llmJson.js";
import { withRetry, type RetryOptions } from "./retry.js";
import type { Company, OutreachEmail, OutreachSkillConfig } from "./types.js";

// The instruction wrapper appended to the skill body so the model returns
// parseable JSON. The skill owns the *content and voice*; this only fixes the
// *output envelope* so we can turn it into a Gmail draft.
export const OUTPUT_CONTRACT =
  "\n\n---\nOUTPUT CONTRACT (do not include this section's text in the email): " +
  "Respond with ONLY a JSON object (no markdown fences, no text outside it): " +
  '{"subject": string, "body": string}. The body is the full plain-text email including greeting and sign-off. ' +
  "Follow the tone, CTA, sender identity, and variables provided. Do not fabricate facts about the recipient company " +
  "beyond what is provided. If no recipient contact name is known, use a neutral greeting.";

// Picks the best recipient email for a company: first explicit contact email,
// else first general company email. Returns undefined if none — the caller
// records that as a per-company failure rather than drafting to nobody.
export function pickRecipient(company: Company): string | undefined {
  const contactEmail = company.contacts.find((c) => c.email && c.email.includes("@"))?.email;
  if (contactEmail) return contactEmail;
  return company.emails.find((e) => e.includes("@"));
}

// Builds the user prompt: the company data + the skill config, as JSON, so
// the skill (system prompt) has everything it needs to personalize. Exported
// for the unit test that verifies skill→email rendering with a mocked model.
export function buildGeneratePrompt(company: Company, config: OutreachSkillConfig): string {
  return JSON.stringify(
    {
      skill: config.skill,
      tone: config.tone,
      cta: config.cta,
      sender: config.sender,
      variables: config.variables ?? {},
      company: {
        name: company.name,
        website: company.website,
        businessInfo: company.businessInfo,
        companyContext: company.companyContext,
        contacts: company.contacts,
        linkedin: company.linkedin,
      },
    },
    null,
    2,
  );
}

export interface GenerateDeps {
  // Returns the skill markdown for a given skill name (fetched from the
  // control repo in production; a fake in tests).
  loadSkill: (skill: OutreachSkillConfig["skill"]) => Promise<string>;
  // The model call (system, user) => raw string. Wraps LiteLLM in production.
  chat: (system: string, user: string) => Promise<string>;
  retry?: RetryOptions;
}

// Renders one email. The system prompt is the skill body + output contract;
// the user prompt is the company/config JSON. Throws on unparseable model
// output (caller isolates per-company).
export async function generateEmail(company: Company, config: OutreachSkillConfig, deps: GenerateDeps): Promise<OutreachEmail> {
  const to = pickRecipient(company);
  if (!to) throw new Error(`no recipient email found for ${company.name}`);

  const skillBody = await deps.loadSkill(config.skill);
  const system = skillBody + OUTPUT_CONTRACT;
  const user = buildGeneratePrompt(company, config);

  const raw = await withRetry(() => deps.chat(system, user), deps.retry);
  let parsed: { subject?: string; body?: string };
  try {
    parsed = parseModelJson<{ subject?: string; body?: string }>(raw);
  } catch {
    throw new Error(`email generation for ${company.name}: model output was not valid JSON`);
  }
  if (!parsed.subject || !parsed.body) {
    throw new Error(`email generation for ${company.name}: missing subject or body`);
  }
  return { company: company.name, to, subject: parsed.subject, body: parsed.body };
}
