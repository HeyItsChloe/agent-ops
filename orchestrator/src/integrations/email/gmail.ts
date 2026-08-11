// Gmail provider (Epic 6, tickets #43 OAuth / #45 provider). Sends through
// the Gmail REST API using an OAuth refresh-token grant — no password auth,
// and deliberately no `googleapis` dependency: everything here is plain
// `fetch` against the two documented endpoints, matching how the rest of the
// orchestrator talks to third parties (see integrations/litellm.ts,
// integrations/github.ts). Credentials come from env, set as GitHub Secrets:
//   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN — the OAuth
//     app + long-lived refresh token exchanged for a short-lived access token.
//   GMAIL_SENDER — the From: address (the authorized account's mailbox).
import type { EmailRequest, EmailResult } from "./types.js";
import { toAddressList } from "./types.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

// Exchange the long-lived refresh token for a short-lived access token. The
// error text here is Google's, which never contains the client secret or
// refresh token, so it's safe to surface upward.
async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GMAIL_CLIENT_ID"),
      client_secret: requireEnv("GMAIL_CLIENT_SECRET"),
      refresh_token: requireEnv("GMAIL_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`gmail token refresh failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("gmail token refresh returned no access_token");
  return body.access_token;
}

// base64url per RFC 4648 §5 — Gmail's messages.send wants the whole RFC-2822
// message URL-safe-base64-encoded with no padding.
function base64Url(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Encode a header value that may contain non-ASCII as an RFC 2047 encoded-word
// so subjects with accents/emoji survive transit. Pure-ASCII values pass
// through untouched.
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// Build the raw RFC-2822 MIME message. When both text and html are present we
// emit a multipart/alternative body so clients pick their preferred form;
// otherwise a single text/plain or text/html part.
function buildMimeMessage(req: EmailRequest, sender: string): string {
  const headers: string[] = [`From: ${sender}`];
  headers.push(`To: ${toAddressList(req.to).join(", ")}`);
  const cc = toAddressList(req.cc);
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  const bcc = toAddressList(req.bcc);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(req.subject ?? "")}`);
  headers.push("MIME-Version: 1.0");

  if (req.text && req.html) {
    const boundary = `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      req.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      req.html,
      `--${boundary}--`,
      "",
    ];
    return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  }

  const isHtml = Boolean(req.html);
  headers.push(`Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: 8bit");
  return `${headers.join("\r\n")}\r\n\r\n${isHtml ? req.html : (req.text ?? "")}`;
}

export async function sendViaGmail(req: EmailRequest): Promise<EmailResult> {
  const recipients = [...toAddressList(req.to), ...toAddressList(req.cc), ...toAddressList(req.bcc)];
  try {
    const sender = requireEnv("GMAIL_SENDER");
    const accessToken = await getAccessToken();
    const raw = base64Url(buildMimeMessage(req, sender));

    const res = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      // Gmail's error body describes the request, not our credentials.
      return { ok: false, provider: "gmail", error: `gmail send failed: ${res.status} ${await res.text()}`, rejected: recipients };
    }
    const body = (await res.json()) as { id?: string };
    return { ok: true, provider: "gmail", id: body.id, accepted: recipients };
  } catch (err) {
    return { ok: false, provider: "gmail", error: err instanceof Error ? err.message : String(err), rejected: recipients };
  }
}
