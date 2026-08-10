// The provider-agnostic entry point (Epic 6, ticket #48 contract). A caller —
// in-process or via the REST route — hands `sendEmail` a raw request; it
// validates against the shared contract and dispatches to the chosen backend.
// The caller only picks provider + fields; it never touches provider-internal
// mechanics (Gmail MIME/OAuth, Mandrill envelopes). A ZodError is thrown for
// an invalid request so callers can distinguish "you sent something malformed"
// (400) from "the provider failed to deliver" (a not-ok EmailResult / 502).
import { emailRequestSchema, type EmailResult } from "./types.js";
import { sendViaGmail } from "./gmail.js";
import { sendViaMailchimp } from "./mailchimp.js";

export async function sendEmail(req: unknown): Promise<EmailResult> {
  const parsed = emailRequestSchema.parse(req);
  switch (parsed.provider) {
    case "gmail":
      return sendViaGmail(parsed);
    case "mailchimp":
      return sendViaMailchimp(parsed);
  }
}

export { emailRequestSchema, toAddressList, type EmailRequest, type EmailResult } from "./types.js";
