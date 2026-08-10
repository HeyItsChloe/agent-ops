// REST surface for the email pipeline (Epic 6, ticket #19): POST /email,
// mounted on the same Express app the engine's createServer() returns and
// guarded by the SAME shared-secret middleware every other first-party
// endpoint uses (sharedSecretAuth checks the x-orchestrator-secret header —
// see the engine's auth.ts and how /mcp is guarded). No new auth scheme.
//
// Guardrails (ticket #21, partial): cap the total number of recipients per
// request, and never let a secret value reach the response body — validation
// errors report field paths only, and provider errors are pre-scrubbed in the
// provider modules. Full audit/rate-limit hardening is deferred (#21 full).
import type { Express, Request, Response } from "express";
import { sharedSecretAuth } from "@heyitschloe/pipeline-orchestrator";
import { logger } from "../../logging.js";
import { sendEmail } from "./index.js";
import { emailRequestSchema, toAddressList } from "./types.js";

// Guardrail cap on to+cc+bcc combined. A blast radius limit, not a business
// rule — kept small on purpose for this foundation.
export const MAX_TOTAL_RECIPIENTS = 50;

export function mountEmailRoutes(app: Express, sharedSecret: string): void {
  app.post("/email", sharedSecretAuth(sharedSecret), async (req: Request, res: Response) => {
    const parsed = emailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // flatten() surfaces only field paths + messages from the request
      // itself — never any server-side secret.
      res.status(400).json({ ok: false, error: "invalid email request", details: parsed.error.flatten() });
      return;
    }

    const req0 = parsed.data;
    const totalRecipients = toAddressList(req0.to).length + toAddressList(req0.cc).length + toAddressList(req0.bcc).length;
    if (totalRecipients > MAX_TOTAL_RECIPIENTS) {
      res.status(400).json({ ok: false, error: `too many recipients: ${totalRecipients} exceeds the limit of ${MAX_TOTAL_RECIPIENTS}` });
      return;
    }

    try {
      const result = await sendEmail(req0);
      if (!result.ok) {
        res.status(502).json(result);
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      // Unexpected fault (not a normal provider not-ok result). Log the
      // detail server-side; return a generic, secret-free 502 to the caller.
      logger.error("email send threw", { provider: req0.provider, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ ok: false, provider: req0.provider, error: "email send failed" });
    }
  });
}
