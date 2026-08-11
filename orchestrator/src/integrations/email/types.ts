// The shared, provider-agnostic email contract (Epic 6, ticket #48 / design
// #42) — the single request shape any repo in the fleet uses to send mail
// through the orchestrator, regardless of which backend actually delivers it.
// A caller only picks `provider` and the fields it wants; it never needs to
// know Gmail's MIME/OAuth details or Mandrill's message envelope. Both the
// in-process helper (index.ts) and the REST surface (route.ts) validate
// against `emailRequestSchema` so the same rules hold on every path in.
import { z } from "zod";

const emailAddress = z.string().email();

// One recipient or many — a bare string or a non-empty array. The non-empty
// bound is how "at least one recipient" is enforced for the array case; a
// single string is inherently one address.
const recipientField = z.union([emailAddress, z.array(emailAddress).min(1)]);

export const emailRequestSchema = z
  .object({
    provider: z.enum(["gmail", "mailchimp"]),
    to: recipientField,
    cc: recipientField.optional(),
    bcc: recipientField.optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    // Mailchimp-only: a stored Mandrill template name plus its merge/edit
    // variables. Rejected for gmail below, since Gmail has no template concept.
    template: z.string().optional(),
    templateVars: z.record(z.unknown()).optional(),
  })
  .superRefine((req, ctx) => {
    // template/templateVars are meaningful only for the mailchimp backend.
    if (req.provider !== "mailchimp") {
      if (req.template !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["template"], message: "template is only valid for provider 'mailchimp'" });
      }
      if (req.templateVars !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["templateVars"], message: "templateVars is only valid for provider 'mailchimp'" });
      }
    }

    if (req.provider === "gmail") {
      if (!req.subject) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: "subject is required for provider 'gmail'" });
      }
      if (!req.text && !req.html) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "provider 'gmail' requires at least one of text or html" });
      }
    }

    if (req.provider === "mailchimp") {
      // A Mandrill send needs *something* to deliver: either a stored
      // template or inline content. This isn't in the three headline rules
      // but a send with neither is always an error, never a valid request.
      if (!req.template && !req.text && !req.html) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["template"], message: "provider 'mailchimp' requires a template or at least one of text or html" });
      }
    }
  });

// The caller-facing request type, inferred from the schema above so the two
// can never drift.
export type EmailRequest = z.infer<typeof emailRequestSchema>;

// The uniform result every provider returns. `accepted`/`rejected` are the
// recipient addresses each backend confirmed or refused; `id` is the
// provider's own message identifier (Gmail message id, Mandrill _id) for
// later correlation. `error` is a human-readable, secret-free message on
// failure.
export interface EmailResult {
  ok: boolean;
  provider: EmailRequest["provider"];
  id?: string;
  accepted?: string[];
  rejected?: string[];
  error?: string;
}

/** Normalizes a one-or-many recipient field to a flat address array. */
export function toAddressList(field: string | string[] | undefined): string[] {
  if (field === undefined) return [];
  return Array.isArray(field) ? field : [field];
}
