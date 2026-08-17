// Drafts-only guard tests for the Gmail integration (issue #11's hard
// requirement). These assert two things with a fake transport (no network):
//   1. The ONLY Gmail endpoint ever requested is drafts.create — no send
//      path (users.messages.send, users.drafts.send) is ever reached.
//   2. The module's source contains no reference to any send endpoint —
//      belt-and-suspenders against a future edit sneaking one in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDraft, createDrafts, encodeRawMessage, GMAIL_DRAFTS_ENDPOINT, type FetchLike, type GmailConfig } from "./gmail.js";
import type { OutreachEmail } from "../jobs/outreach/types.js";

const config: GmailConfig = {
  clientId: "cid",
  clientSecret: "secret",
  refreshToken: "refresh",
  sender: "outreach@example.com",
};

const email: OutreachEmail = { company: "Stripe", to: "hi@stripe.com", subject: "Hello", body: "Hi there,\nThanks." };

// A fake transport that records every URL it's asked to hit and returns
// canned OAuth + drafts.create responses. Any request to a URL other than
// the token endpoint or the drafts endpoint is a hard test failure.
function makeFakeFetch(recorder: string[]): FetchLike {
  return async (url: string) => {
    recorder.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ access_token: "fake-access-token" }),
        headers: { get: () => null },
      };
    }
    if (url === GMAIL_DRAFTS_ENDPOINT) {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ id: "draft-123" }),
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected URL requested by gmail integration: ${url}`);
  };
}

test("createDraft only ever calls the drafts.create endpoint (never a send path)", async () => {
  const urls: string[] = [];
  const result = await createDraft(config, email, { fetchImpl: makeFakeFetch(urls) });
  assert.equal(result.id, "draft-123");
  assert.equal(result.company, "Stripe");

  // Only the token exchange + drafts.create were requested.
  const nonToken = urls.filter((u) => !u.includes("oauth2.googleapis.com/token"));
  assert.deepEqual(nonToken, [GMAIL_DRAFTS_ENDPOINT]);

  // Explicitly assert NO send endpoint was touched.
  for (const u of urls) {
    assert.ok(!/\/send\b/.test(u), `a send endpoint was requested: ${u}`);
    assert.ok(!/messages\/send/.test(u), `messages.send was requested: ${u}`);
    assert.ok(!/drafts\/send/.test(u), `drafts.send was requested: ${u}`);
  }
});

test("createDrafts isolates failures and never sends", async () => {
  const urls: string[] = [];
  const emails: OutreachEmail[] = [email, { ...email, company: "Adyen", to: "" }];
  // Second email has empty `to` — still just a drafts.create attempt, never a send.
  const { drafts, failures } = await createDrafts(config, emails, { fetchImpl: makeFakeFetch(urls), retry: { retries: 0 } });
  assert.equal(drafts.length + failures.length, 2);
  for (const u of urls) assert.ok(!/send/.test(u), `no request may contain 'send': ${u}`);
});

test("encodeRawMessage produces base64url with no send semantics", () => {
  const raw = encodeRawMessage(email, config.sender);
  assert.ok(!/[+/=]/.test(raw), "raw must be base64url (no +, /, or = padding)");
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.ok(decoded.includes("To: hi@stripe.com"));
  assert.ok(decoded.includes("Subject: Hello"));
  assert.ok(decoded.includes(`From: ${config.sender}`));
});

test("gmail.ts source contains no send endpoint reference (static guard)", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "gmail.ts"), "utf-8");
  // No Gmail send endpoints may appear anywhere in the source.
  assert.ok(!/messages\/send/.test(source), "gmail.ts must not reference messages/send");
  assert.ok(!/drafts\/[^"'`\s]*\/send/.test(source), "gmail.ts must not reference a drafts send path");
  assert.ok(!/\.send\(/.test(source), "gmail.ts must not define/call a .send()");
  // Positive: it DOES reference the drafts create endpoint.
  assert.ok(source.includes("users/me/drafts"), "gmail.ts must use the drafts.create endpoint");
});
