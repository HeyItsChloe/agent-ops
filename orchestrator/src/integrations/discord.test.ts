// Discord summary formatting + config resolution tests (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSummary, discordConfigFromEnv, postSummary, type DiscordConfig } from "./discord.js";
import type { FetchLike } from "./gmail.js";
import type { OutreachRunSummary } from "../jobs/outreach/types.js";

const summary: OutreachRunSummary = {
  vertical: "payment processors",
  companiesCollected: 25,
  draftsCreated: 24,
  failures: [{ stage: "draft", company: "Beta", error: "bad recipient" }],
  storeCsvUrl: "https://csv",
  storeJsonUrl: "https://json",
  startedAt: "2026-07-30T13:00:00.000Z",
  finishedAt: "2026-07-30T13:05:00.000Z",
};

test("formatSummary includes counts, urls, and failure detail", () => {
  const text = formatSummary(summary);
  assert.ok(text.includes("Companies collected:** 25"));
  assert.ok(text.includes("Drafts created:** 24"));
  assert.ok(text.includes("Failures:** 1"));
  assert.ok(text.includes("https://csv"));
  assert.ok(text.includes("Beta"));
});

test("discordConfigFromEnv prefers webhook, then bot token", () => {
  assert.deepEqual(discordConfigFromEnv({ DISCORD_WEBHOOK_URL: "https://hook" } as NodeJS.ProcessEnv), { webhookUrl: "https://hook" });
  assert.deepEqual(discordConfigFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_CHANNEL_ID: "c" } as NodeJS.ProcessEnv), { botToken: "t", channelId: "c" });
  assert.equal(discordConfigFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test("postSummary posts to webhook via injected fetch", async () => {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return { ok: true, status: 204, text: async () => "", json: async () => ({}), headers: { get: () => null } };
  };
  const config: DiscordConfig = { webhookUrl: "https://discord.test/hook" };
  await postSummary(config, summary, { fetchImpl });
  assert.deepEqual(urls, ["https://discord.test/hook"]);
});
