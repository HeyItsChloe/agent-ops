---
name: outreach-email
description: Cold outreach email skill for the automated outreach pipeline. Owns the full content and voice of a first-touch outreach email to a scraped company; the pipeline creates a Gmail draft from it and NEVER sends.
config_schema: ./config.schema.json
---

# Outreach Email (first touch)

This skill fully owns the **content** of a first-touch cold outreach email. The
outreach pipeline (`orchestrator/src/jobs/outreach/run.ts`) uses this file as
the model **system prompt**, passes the enriched company record + the skill
config (tone, CTA, sender identity, variables) as the user prompt, and turns
the returned `{subject, body}` into a **Gmail draft**. It never sends — drafts
only, enforced in `integrations/gmail.ts` and its test.

## Hard rule: draft only, never send

Nothing in this skill, and nothing the pipeline does with its output, sends
email. The output of this skill becomes a reviewable Gmail draft a human sends
themselves. Do not add "send" language, urgency pressure, or anything that
assumes automatic delivery.

## Voice & structure

Write a short, human, first-touch email:

1. **Subject** — specific and non-spammy; reference the company or their space,
   not a generic "Quick question". Under ~60 characters.
2. **Greeting** — use a known contact's first name if one is provided; otherwise
   a neutral, non-robotic greeting ("Hi there," is fine; never "Dear Sir/Madam").
3. **Opening (1 sentence)** — a genuine, specific reason for reaching out, drawn
   from the company's `businessInfo` / `companyContext`. No flattery filler.
4. **Value (1–2 sentences)** — what the sender offers and why it's relevant to
   *this* company specifically. Ground it in the provided company data.
5. **CTA (1 sentence)** — exactly the configured `cta`. One clear, low-friction ask.
6. **Sign-off** — the configured sender identity (name, company, role); use the
   configured `signature` verbatim if provided.

Total length: 90–130 words. Plain text, no HTML, no images, no attachments.

## Personalization rules

- Personalize **only** from the provided company data. Never invent facts,
  metrics, mutual connections, prior conversations, or recipient details.
- If `companyContext`/`businessInfo` are empty, keep the opening general but
  honest — do not fabricate a hook.
- Respect the configured `tone`. Substitute any `variables` where the config
  references them.

## Output contract

Return ONLY a JSON object: `{"subject": string, "body": string}`. The `body` is
the full plain-text email including greeting and sign-off. No markdown fences,
no text outside the object. (The pipeline appends this contract automatically;
it is restated here so the skill is self-describing.)
