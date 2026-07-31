// Outreach-pipeline-specific types. Kept separate from src/types.ts (which
// is the job-search pipeline's own param/domain shapes) so the two private
// pipelines don't share a type surface they don't actually share behavior
// with — same split rationale as the handlers themselves.

// One scraped + enriched company. Every enrichment field is optional: a
// scrape/discovery pass routinely returns incomplete data, and the pipeline
// records whatever it found rather than dropping a company for a missing
// phone number or LinkedIn URL. `name` and `website` are the only fields the
// dedup key needs, and even those degrade to best-effort (see dedup.ts).
export interface Company {
  name: string;
  website?: string;
  emails: string[];
  contacts: CompanyContact[];
  linkedin?: string;
  phones: string[];
  businessInfo?: string; // industry, size, HQ, products — free text
  companyContext?: string; // model-summarized "why they'd care" grounding for the email
  sourceUrl?: string; // where this candidate was discovered
  discoveredAt: string; // ISO timestamp
}

export interface CompanyContact {
  name?: string;
  title?: string;
  email?: string;
  linkedin?: string;
}

// The configurable "vertical" the whole pipeline targets. Default is
// "payment processors" (issue #11) but this is the single knob that makes
// the pipeline reusable for any other outreach vertical without code changes.
export interface OutreachVertical {
  label: string; // human label, e.g. "payment processors"
  searchTerms: string[]; // seed queries for discovery
}

export const DEFAULT_VERTICAL: OutreachVertical = {
  label: "payment processors",
  searchTerms: [
    "payment processing companies",
    "payment gateway providers",
    "merchant services companies",
    "payment service providers (PSP)",
    "card acquiring / payment facilitator companies",
  ],
};

// Which email skill to render. Maps to skills/outreach/<skill>/SKILL.md.
export type OutreachSkillName = "outreach-email" | "follow-up-email" | "partnership-email";

// Sender identity + tone/CTA knobs the skill renders against. All of this is
// config, never hardcoded into a prompt — the skill owns the *structure*,
// this owns the *substitutable* values.
export interface OutreachSkillConfig {
  skill: OutreachSkillName;
  tone: string; // e.g. "warm, concise, professional"
  cta: string; // the call to action, e.g. "a 15-minute intro call next week"
  sender: SenderIdentity;
  variables?: Record<string, string>; // arbitrary extra template variables
}

export interface SenderIdentity {
  name: string;
  company: string;
  role?: string;
  email: string; // the Gmail account drafts are created under
  signature?: string;
}

// A rendered email, ready to become a Gmail draft. Never sent — see gmail.ts.
export interface OutreachEmail {
  company: string;
  to: string; // recipient email
  subject: string;
  body: string;
}

// Per-run outcome, surfaced in the Discord summary and the handler result.
export interface OutreachRunSummary {
  vertical: string;
  companiesCollected: number;
  draftsCreated: number;
  failures: OutreachFailure[];
  storeCsvUrl?: string;
  storeJsonUrl?: string;
  startedAt: string;
  finishedAt: string;
}

export interface OutreachFailure {
  stage: "scrape" | "enrich" | "store" | "generate" | "draft" | "notify";
  company?: string;
  error: string;
}
