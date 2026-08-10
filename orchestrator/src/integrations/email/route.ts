// REST surface for the email pipeline (Epic 6, ticket #19): POST /email,
// mounted on the same Express app the engine's createServer() returns and
// guarded by the SAME shared-secret middleware every other first-party
// endpoint uses (sharedSecretAuth checks the x-orchestrator-secret header —
// see the engine's auth.ts and how /mcp is guarded). No new auth scheme.
//
// Guardrails (ticket #21): on top of the shared-secret gate this route adds
//   - a recipient cap (blast-radius limit on to+cc+bcc combined),
//   - a simple in-memory fixed-window rate limiter keyed by the X-Repo header
//     (falling back to a single global bucket when the header is absent),
//   - an optional per-repo allowlist (EMAIL_ALLOWED_REPOS), and
//   - a structured audit log line per attempt.
// None of these ever let a secret value reach the response body or the logs:
// validation errors report field paths only, provider errors are pre-scrubbed
// in the provider modules, and the audit line records a recipient COUNT — never
// the addresses themselves — and no credential material.
import type { Express, Request, Response } from "express";
import { sharedSecretAuth } from "@heyitschloe/pipeline-orchestrator";
import { logger } from "../../logging.js";
import { sendEmail } from "./index.js";
import { emailRequestSchema, toAddressList } from "./types.js";

// Guardrail cap on to+cc+bcc combined. A blast radius limit, not a business
// rule — kept small on purpose for this foundation.
export const MAX_TOTAL_RECIPIENTS = 50;

// Rate limit default (requests per minute per repo bucket). Overridable via
// EMAIL_RATE_LIMIT_PER_MIN; a non-positive or unparseable value falls back to
// this default rather than disabling the limiter.
const DEFAULT_RATE_LIMIT_PER_MIN = 60;

function rateLimitPerMin(): number {
  const raw = process.env.EMAIL_RATE_LIMIT_PER_MIN;
  if (!raw) return DEFAULT_RATE_LIMIT_PER_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RATE_LIMIT_PER_MIN;
}

// Optional per-repo allowlist. When EMAIL_ALLOWED_REPOS is set (comma-separated),
// the X-Repo header must name one of the listed repos; when unset, the route
// behaves as before (shared-secret only, any repo).
function allowedRepos(): Set<string> | null {
  const raw = process.env.EMAIL_ALLOWED_REPOS;
  if (!raw) return null;
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

// Fixed-window limiter state. Keyed by the caller's X-Repo (or a single shared
// "__global__" bucket when the header is absent), each entry tracks the count
// so far in the current one-minute window and when that window opened. In-memory
// and per-instance on purpose — a lightweight abuse guard, not a distributed
// quota. Resets on redeploy, which is acceptable for this foundation.
const WINDOW_MS = 60_000;
interface WindowState {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, WindowState>();

const GLOBAL_BUCKET_KEY = "__global__";

/**
 * Records one hit against the given bucket and reports whether it is within the
 * per-minute limit. Rolls the window forward when the current one has elapsed.
 */
function checkRateLimit(bucketKey: string, limit: number): boolean {
  const now = Date.now();
  const existing = rateBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    rateBuckets.set(bucketKey, { count: 1, windowStart: now });
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

/** Reads a trimmed X-Repo header, or undefined when absent/blank. */
function repoHeader(req: Request): string | undefined {
  const raw = req.header("x-repo");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

interface AuditFields {
  repo: string;
  provider?: string;
  recipientCount: number;
  hasSubject: boolean;
  result: "ok" | "err";
  status: number;
  reason?: string;
}

/**
 * Emits exactly one structured audit line per attempt. Never includes recipient
 * addresses (only their count) or any secret material — logger already stamps a
 * timestamp on every line.
 */
function audit(fields: AuditFields): void {
  logger.info("email send attempt", { ...fields });
}

export function mountEmailRoutes(app: Express, sharedSecret: string): void {
  app.post("/email", sharedSecretAuth(sharedSecret), async (req: Request, res: Response) => {
    const repo = repoHeader(req);
    const repoLabel = repo ?? "unknown";

    // Per-repo authorization: when an allowlist is configured, the X-Repo header
    // must name a listed repo. Unset allowlist => shared-secret-only, as before.
    const allow = allowedRepos();
    if (allow && (!repo || !allow.has(repo))) {
      audit({ repo: repoLabel, recipientCount: 0, hasSubject: false, result: "err", status: 403, reason: "repo not allowed" });
      res.status(403).json({ ok: false, error: "repo not authorized for the email pipeline" });
      return;
    }

    // Rate limit, keyed by repo (or a single global bucket when X-Repo absent).
    const limit = rateLimitPerMin();
    const bucketKey = repo ?? GLOBAL_BUCKET_KEY;
    if (!checkRateLimit(bucketKey, limit)) {
      audit({ repo: repoLabel, recipientCount: 0, hasSubject: false, result: "err", status: 429, reason: "rate limit exceeded" });
      res.status(429).json({ ok: false, error: "rate limit exceeded: too many email requests, try again shortly" });
      return;
    }

    const parsed = emailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // flatten() surfaces only field paths + messages from the request
      // itself — never any server-side secret.
      audit({ repo: repoLabel, recipientCount: 0, hasSubject: false, result: "err", status: 400, reason: "invalid request" });
      res.status(400).json({ ok: false, error: "invalid email request", details: parsed.error.flatten() });
      return;
    }

    const req0 = parsed.data;
    const totalRecipients = toAddressList(req0.to).length + toAddressList(req0.cc).length + toAddressList(req0.bcc).length;
    const hasSubject = Boolean(req0.subject);
    if (totalRecipients > MAX_TOTAL_RECIPIENTS) {
      audit({ repo: repoLabel, provider: req0.provider, recipientCount: totalRecipients, hasSubject, result: "err", status: 400, reason: "too many recipients" });
      res.status(400).json({ ok: false, error: `too many recipients: ${totalRecipients} exceeds the limit of ${MAX_TOTAL_RECIPIENTS}` });
      return;
    }

    try {
      const result = await sendEmail(req0);
      if (!result.ok) {
        audit({ repo: repoLabel, provider: req0.provider, recipientCount: totalRecipients, hasSubject, result: "err", status: 502, reason: "provider not ok" });
        res.status(502).json(result);
        return;
      }
      audit({ repo: repoLabel, provider: req0.provider, recipientCount: totalRecipients, hasSubject, result: "ok", status: 200 });
      res.status(200).json(result);
    } catch (err) {
      // Unexpected fault (not a normal provider not-ok result). Log the
      // detail server-side; return a generic, secret-free 502 to the caller.
      audit({ repo: repoLabel, provider: req0.provider, recipientCount: totalRecipients, hasSubject, result: "err", status: 502, reason: "send threw" });
      logger.error("email send threw", { provider: req0.provider, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ ok: false, provider: req0.provider, error: "email send failed" });
    }
  });
}
