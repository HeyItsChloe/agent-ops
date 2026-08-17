// Discord integration — posts a completion (or failure) summary for an
// outreach run. Two transports, both credential-from-env (never logged):
//   - DISCORD_WEBHOOK_URL  → a plain webhook POST (simplest, preferred)
//   - DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID → bot-token channel message
// Webhook wins if both are set. No new SDK — a fetch POST, same as every
// other integration here. Fail-open: a Discord post failure is logged by the
// caller and recorded as a failure, but never aborts the pipeline (the
// drafts are already created by the time we notify).

import { withRetry, RetryAfterError, type RetryOptions } from "../jobs/outreach/retry.js";
import type { OutreachRunSummary } from "../jobs/outreach/types.js";
import type { FetchLike } from "./gmail.js";

export interface DiscordConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
}

export interface DiscordDeps {
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
}

export function discordConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordConfig | undefined {
  if (env.DISCORD_WEBHOOK_URL) return { webhookUrl: env.DISCORD_WEBHOOK_URL };
  if (env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID) {
    return { botToken: env.DISCORD_BOT_TOKEN, channelId: env.DISCORD_CHANNEL_ID };
  }
  return undefined;
}

// Renders the run summary into a Discord message body. Plain text with bold
// labels (no markdown tables — Discord doesn't render them), matching the
// workspace formatting convention.
export function formatSummary(summary: OutreachRunSummary): string {
  const lines = [
    `**Outreach pipeline run — ${summary.vertical}**`,
    `**Companies collected:** ${summary.companiesCollected}`,
    `**Drafts created:** ${summary.draftsCreated}`,
    `**Failures:** ${summary.failures.length}`,
  ];
  if (summary.storeCsvUrl) lines.push(`**CSV:** ${summary.storeCsvUrl}`);
  if (summary.storeJsonUrl) lines.push(`**JSON:** ${summary.storeJsonUrl}`);
  if (summary.failures.length) {
    lines.push("**Failure detail:**");
    for (const f of summary.failures.slice(0, 10)) {
      lines.push(`• [${f.stage}]${f.company ? ` ${f.company}:` : ""} ${f.error}`);
    }
    if (summary.failures.length > 10) lines.push(`• …and ${summary.failures.length - 10} more`);
  }
  lines.push(`_Ran ${summary.startedAt} → ${summary.finishedAt}_`);
  return lines.join("\n");
}

async function postJson(url: string, headers: Record<string, string>, payload: unknown, deps: DiscordDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  await withRetry(async () => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      throw new RetryAfterError("Discord rate-limited (429)", (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
    }
    if (!res.ok) throw new Error(`Discord post failed: ${res.status} ${await res.text()}`);
  }, deps.retry);
}

export async function postSummary(config: DiscordConfig, summary: OutreachRunSummary, deps: DiscordDeps = {}): Promise<void> {
  const content = formatSummary(summary);
  if (config.webhookUrl) {
    await postJson(config.webhookUrl, {}, { content }, deps);
    return;
  }
  if (config.botToken && config.channelId) {
    await postJson(
      `https://discord.com/api/v10/channels/${config.channelId}/messages`,
      { Authorization: `Bot ${config.botToken}` },
      { content },
      deps,
    );
    return;
  }
  throw new Error("Discord not configured: set DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID");
}
