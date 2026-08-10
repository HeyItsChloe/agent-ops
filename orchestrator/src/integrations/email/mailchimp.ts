// Mailchimp provider (Epic 6, ticket #46) built on Mailchimp Transactional
// (Mandrill), reached with plain `fetch` like every other integration here.
// Direct content posts to messages/send.json; a named template posts to
// messages/send-template.json with the template name and its variables. The
// API key is MAILCHIMP_TRANSACTIONAL_API_KEY (a GitHub Secret). The From:
// address is MAILCHIMP_FROM_EMAIL — optional here because a Mandrill template
// can carry its own default sender, but required for a direct (non-template)
// send, which has no other source for it.
import type { EmailRequest, EmailResult } from "./types.js";
import { toAddressList } from "./types.js";

const SEND_ENDPOINT = "https://mandrillapp.com/api/1.0/messages/send.json";
const SEND_TEMPLATE_ENDPOINT = "https://mandrillapp.com/api/1.0/messages/send-template.json";

interface MandrillRecipient {
  email: string;
  type: "to" | "cc" | "bcc";
}

interface MandrillSendResult {
  email: string;
  status: "sent" | "queued" | "scheduled" | "rejected" | "invalid";
  _id?: string;
  reject_reason?: string | null;
}

interface MandrillError {
  status: "error";
  code?: number;
  name?: string;
  message?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function buildRecipients(req: EmailRequest): MandrillRecipient[] {
  return [
    ...toAddressList(req.to).map((email): MandrillRecipient => ({ email, type: "to" })),
    ...toAddressList(req.cc).map((email): MandrillRecipient => ({ email, type: "cc" })),
    ...toAddressList(req.bcc).map((email): MandrillRecipient => ({ email, type: "bcc" })),
  ];
}

// Mandrill takes merge/template variables as an array of {name, content}
// pairs, not a plain object — convert the caller's templateVars map into that
// shape once, for use as global_merge_vars.
function toVarPairs(vars: Record<string, unknown> | undefined): Array<{ name: string; content: unknown }> {
  if (!vars) return [];
  return Object.entries(vars).map(([name, content]) => ({ name, content }));
}

// Fold Mandrill's per-recipient result array into our uniform EmailResult.
// sent/queued/scheduled count as accepted; rejected/invalid as rejected.
function summarize(results: MandrillSendResult[]): { id?: string; accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  let id: string | undefined;
  for (const r of results) {
    if (r.status === "sent" || r.status === "queued" || r.status === "scheduled") accepted.push(r.email);
    else rejected.push(r.email);
    if (!id && r._id) id = r._id;
  }
  return { id, accepted, rejected };
}

export async function sendViaMailchimp(req: EmailRequest): Promise<EmailResult> {
  const allRecipients = [...toAddressList(req.to), ...toAddressList(req.cc), ...toAddressList(req.bcc)];
  try {
    const key = requireEnv("MAILCHIMP_TRANSACTIONAL_API_KEY");
    const fromEmail = process.env.MAILCHIMP_FROM_EMAIL;

    // The shared message envelope for both direct and template sends.
    const message: Record<string, unknown> = {
      to: buildRecipients(req),
      ...(fromEmail ? { from_email: fromEmail } : {}),
      ...(req.subject ? { subject: req.subject } : {}),
      ...(req.text ? { text: req.text } : {}),
      ...(req.html ? { html: req.html } : {}),
    };

    let endpoint = SEND_ENDPOINT;
    let payload: Record<string, unknown> = { key, message };

    if (req.template) {
      // Direct (non-template) sends require a from_email; a template can fall
      // back to its own configured sender, so we don't hard-require it here.
      endpoint = SEND_TEMPLATE_ENDPOINT;
      const varPairs = toVarPairs(req.templateVars);
      payload = {
        key,
        template_name: req.template,
        // Editable content regions (mc:edit blocks) — none derived from
        // templateVars here; merge variables go through global_merge_vars.
        template_content: [],
        message: { ...message, global_merge_vars: varPairs },
      };
    } else if (!fromEmail) {
      throw new Error("provider 'mailchimp' direct send requires MAILCHIMP_FROM_EMAIL to be set");
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = (await res.json()) as MandrillSendResult[] | MandrillError;

    // Mandrill signals API-level failures (bad key, unknown template, etc.)
    // with a single error object rather than the per-recipient array. Its
    // message describes the fault, not the key value.
    if (!Array.isArray(body)) {
      const err = body as MandrillError;
      return { ok: false, provider: "mailchimp", error: `mailchimp send failed: ${err.name ?? "error"}: ${err.message ?? res.status}`, rejected: allRecipients };
    }

    const { id, accepted, rejected } = summarize(body);
    return { ok: rejected.length === 0 && accepted.length > 0, provider: "mailchimp", id, accepted, rejected };
  } catch (err) {
    return { ok: false, provider: "mailchimp", error: err instanceof Error ? err.message : String(err), rejected: allRecipients };
  }
}
