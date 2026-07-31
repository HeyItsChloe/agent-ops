// Gmail integration — creates DRAFTS ONLY. This module deliberately has no
// code path that reaches users.messages.send / users.drafts.send. That is a
// hard, enforced guarantee (issue #11), not a convention: the only Gmail
// write endpoint referenced anywhere in this file is
// `users/me/drafts` (create). A unit test (gmail.test.ts) asserts that the
// fetch layer is only ever called with that endpoint and never a send path.
//
// Auth reuses the OAuth2 refresh-token grant (no new SDK — same fetch-based
// approach as every other integration here). Credentials come from env /
// GitHub Secrets (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
// / GMAIL_SENDER). They are never logged.

import { withRetry, RetryAfterError, type RetryOptions } from "../jobs/outreach/retry.js";
import type { OutreachEmail } from "../jobs/outreach/types.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// The ONLY Gmail write endpoint this module is allowed to touch. Exported so
// the test can assert nothing else is ever requested.
export const GMAIL_DRAFTS_ENDPOINT = `${GMAIL_API}/users/me/drafts`;

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sender: string; // the "From" address / the account drafts are created under
}

// Seam so tests inject a fake transport and assert on the exact URL called —
// no real network in unit tests. Defaults to global fetch in production.
export type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  headers: { get(name: string): string | null };
}>;

export interface GmailDeps {
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
}

function buildConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GmailConfig | undefined {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN || !env.GMAIL_SENDER) {
    return undefined;
  }
  return {
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
    sender: env.GMAIL_SENDER,
  };
}

export function gmailConfigFromEnv(env?: NodeJS.ProcessEnv): GmailConfig | undefined {
  return buildConfigFromEnv(env);
}

async function throwIfRateLimited(res: Awaited<ReturnType<FetchLike>>, context: string): Promise<never | void> {
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "0");
    throw new RetryAfterError(`Gmail ${context} rate-limited (429)`, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
  }
}

// Exchanges the long-lived refresh token for a short-lived access token.
// Never logs the token or the client secret.
async function getAccessToken(config: GmailConfig, fetchImpl: FetchLike, retry?: RetryOptions): Promise<string> {
  return withRetry(async () => {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    await throwIfRateLimited(res, "token");
    if (!res.ok) {
      // Do NOT include the request body (holds the secret) in the error.
      throw new Error(`Gmail OAuth token exchange failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Gmail OAuth token exchange returned no access_token");
    return json.access_token;
  }, retry);
}

// RFC 2822 message, base64url-encoded, as Gmail's drafts.create expects.
export function encodeRawMessage(email: OutreachEmail, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].join("\r\n");
  const raw = `${headers}\r\n\r\n${email.body}`;
  return Buffer.from(raw, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface DraftResult {
  id: string;
  company: string;
  to: string;
}

// Creates a single Gmail DRAFT. This is the only exported write operation in
// this module. It calls exactly ONE Gmail endpoint: drafts.create. There is
// intentionally no send() function anywhere in this file.
export async function createDraft(
  config: GmailConfig,
  email: OutreachEmail,
  deps: GmailDeps = {},
): Promise<DraftResult> {
  const fetchImpl = (deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const accessToken = await getAccessToken(config, fetchImpl, deps.retry);

  return withRetry(async () => {
    const res = await fetchImpl(GMAIL_DRAFTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw: encodeRawMessage(email, config.sender) } }),
    });
    await throwIfRateLimited(res, "drafts.create");
    if (!res.ok) {
      throw new Error(`Gmail drafts.create failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { id?: string };
    return { id: json.id ?? "", company: email.company, to: email.to };
  }, deps.retry);
}

// Batch helper: creates a draft per email, isolating failures so one bad
// recipient doesn't lose the whole batch (same partial-batch philosophy as
// the job-search pipeline). Returns drafts created + per-email failures.
export async function createDrafts(
  config: GmailConfig,
  emails: OutreachEmail[],
  deps: GmailDeps = {},
): Promise<{ drafts: DraftResult[]; failures: Array<{ company: string; error: string }> }> {
  const drafts: DraftResult[] = [];
  const failures: Array<{ company: string; error: string }> = [];
  for (const email of emails) {
    try {
      drafts.push(await createDraft(config, email, deps));
    } catch (error) {
      failures.push({ company: email.company, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { drafts, failures };
}
