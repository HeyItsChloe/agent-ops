// Orchestrates the outreach pipeline end to end:
//   scrape → dedup → store → generate → draft → notify
// with per-stage retry (each integration already wraps its own network work
// in withRetry), structured logging (reuse ../../logging.ts), and basic
// monitoring: any stage failure is recorded and surfaced in the Discord
// summary, and a run that fails outright still attempts a failure
// notification. Fail-open on optional dependencies (the-store / Discord
// unset) matches the_store.ts's posture.

import { logger } from "../../logging.js";
import { chatCompletion, type LiteLLMConfig } from "../../integrations/litellm.js";
import { getFileContents, getInstallationToken, type GitHubAppConfig } from "../../integrations/github.js";
import * as serpapi from "../discovery/providers/serpapi.js";
import * as claudeWebSearch from "../discovery/providers/claudeWebSearch.js";
import { createDrafts, gmailConfigFromEnv, type GmailConfig, type GmailDeps } from "../../integrations/gmail.js";
import { postSummary, discordConfigFromEnv, type DiscordConfig, type DiscordDeps } from "../../integrations/discord.js";
import { DedupSet, selectNewCompanies, type DedupStore } from "./dedup.js";
import { makeDedupStore, persistCompanies, type OutreachStoreConfig, type StoreAuth } from "./store.js";
import { scrapeCompanies, modelEnrich, type DiscoveryHit, type ScrapeDeps } from "./scrape.js";
import { generateEmail, type GenerateDeps } from "./generate.js";
import type { Company, OutreachEmail, OutreachFailure, OutreachRunSummary, OutreachSkillConfig, OutreachVertical } from "./types.js";
import { DEFAULT_VERTICAL } from "./types.js";
import type { RetryOptions } from "./retry.js";

export interface OutreachPipelineDeps {
  githubApp: GitHubAppConfig;
  installationId: string; // personal installation (the-store + skill fetch)
  liteLLM: LiteLLMConfig;
  modelAlias: string; // LiteLLM alias for enrichment + email generation

  // control repo where skills/outreach/* live (for live skill fetch)
  controlRepoOwner: string;
  controlRepoName: string;
  controlRepoBranch: string;

  // Discovery providers — at least one required at runtime.
  serpapi?: serpapi.SerpApiConfig;
  claudeWebSearch?: claudeWebSearch.ClaudeWebSearchConfig;

  // Optional (fail-open) — storage repo, Gmail, Discord.
  store?: OutreachStoreConfig;
  gmail?: GmailConfig;
  discord?: DiscordConfig;

  retry?: RetryOptions;

  // Test seams: override the outward-facing effects so run() is unit-testable
  // with zero network. Production leaves these undefined and the wiring above
  // is used.
  overrides?: OutreachRunOverrides;
}

export interface OutreachRunOverrides {
  scrape?: ScrapeDeps;
  dedupStore?: DedupStore;
  generate?: Pick<GenerateDeps, "loadSkill" | "chat">;
  persist?: (companies: Company[]) => Promise<{ csvUrl: string; jsonUrl: string; total: number }>;
  createDrafts?: (emails: OutreachEmail[]) => Promise<{ drafts: Array<{ id: string; company: string; to: string }>; failures: Array<{ company: string; error: string }> }>;
  notify?: (summary: OutreachRunSummary) => Promise<void>;
  gmailDeps?: GmailDeps;
  discordDeps?: DiscordDeps;
}

export interface OutreachRunRequest {
  vertical?: OutreachVertical;
  target?: number; // NEW companies to collect (default 25)
  skillConfig: OutreachSkillConfig;
  correlationId: string;
  requestedBy: string;
}

// Builds the production discovery function from whichever provider is
// configured (serpapi preferred, claude_web_search fallback). Returns loose
// DiscoveryHits from the shared PostingCandidate shape.
function buildDiscover(deps: OutreachPipelineDeps): (query: string, maxResults: number) => Promise<DiscoveryHit[]> {
  return async (query, maxResults) => {
    if (deps.serpapi) {
      const results = await serpapi.search(deps.serpapi, query, maxResults);
      return results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet, company: r.company }));
    }
    if (deps.claudeWebSearch) {
      const results = await claudeWebSearch.search(deps.claudeWebSearch, query, maxResults);
      return results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet, company: r.company }));
    }
    throw new Error("outreach: no discovery provider configured (set SERPAPI_API_KEY or ANTHROPIC_API_KEY)");
  };
}

export async function runOutreachPipeline(deps: OutreachPipelineDeps, req: OutreachRunRequest): Promise<OutreachRunSummary> {
  const log = logger.withContext({ correlationId: req.correlationId, pipeline: "outreach-pipeline" });
  const vertical = req.vertical ?? DEFAULT_VERTICAL;
  const target = req.target ?? 25;
  const failures: OutreachFailure[] = [];
  const startedAt = new Date().toISOString();
  log.info("outreach run started", { vertical: vertical.label, target, requestedBy: req.requestedBy });

  const chat = (system: string, user: string) =>
    chatCompletion(deps.liteLLM, deps.modelAlias, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

  const auth: StoreAuth = { githubApp: deps.githubApp, installationId: deps.installationId };

  // ---- scrape ----
  const scrapeDeps: ScrapeDeps =
    deps.overrides?.scrape ??
    ({
      discover: buildDiscover(deps),
      enrich: modelEnrich(chat),
      retry: deps.retry,
      onWarn: (message, fields) => log.warn(message, fields),
    } satisfies ScrapeDeps);

  let scraped: Company[] = [];
  try {
    // Over-collect so dedup still leaves `target` new companies.
    scraped = await scrapeCompanies(vertical, target * 2, scrapeDeps);
    log.info("scrape complete", { candidates: scraped.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push({ stage: "scrape", error: msg });
    log.error("scrape stage failed", { error: msg });
  }

  // ---- dedup ----
  const dedupStore: DedupStore | undefined =
    deps.overrides?.dedupStore ?? (deps.store ? makeDedupStore(auth, deps.store) : undefined);
  let index = dedupStore ? await dedupStore.load() : { domains: [], names: [], updatedAt: new Date(0).toISOString() };
  const seen = new DedupSet(index);
  const newCompanies = selectNewCompanies(scraped, seen, target);
  log.info("dedup complete", { new: newCompanies.length, target });
  if (newCompanies.length < target) {
    log.warn("collected fewer than target new companies", { collected: newCompanies.length, target });
  }

  // ---- store ----
  let storeCsvUrl: string | undefined;
  let storeJsonUrl: string | undefined;
  if (newCompanies.length > 0) {
    try {
      const persist =
        deps.overrides?.persist ?? ((companies: Company[]) => persistCompanies(auth, deps.store!, companies));
      if (deps.overrides?.persist || deps.store) {
        const result = await persist(newCompanies);
        storeCsvUrl = result.csvUrl;
        storeJsonUrl = result.jsonUrl;
        if (dedupStore) await dedupStore.save(seen.toIndex());
        log.info("store complete", { total: result.total });
      } else {
        log.warn("the-store not configured — skipping persistence (fail-open)");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push({ stage: "store", error: msg });
      log.error("store stage failed", { error: msg });
    }
  }

  // ---- generate ----
  const loadSkill =
    deps.overrides?.generate?.loadSkill ??
    (async (skill: OutreachSkillConfig["skill"]) => {
      const token = await getInstallationToken(deps.githubApp, deps.installationId);
      return getFileContents(token, deps.controlRepoOwner, deps.controlRepoName, `skills/outreach/${skill}/SKILL.md`, deps.controlRepoBranch);
    });
  const generateChat = deps.overrides?.generate?.chat ?? chat;
  const generateDeps: GenerateDeps = { loadSkill, chat: generateChat, retry: deps.retry };

  const emails: OutreachEmail[] = [];
  for (const company of newCompanies) {
    try {
      emails.push(await generateEmail(company, req.skillConfig, generateDeps));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push({ stage: "generate", company: company.name, error: msg });
      log.warn("email generation failed", { company: company.name, error: msg });
    }
  }
  log.info("generate complete", { emails: emails.length });

  // ---- draft (Gmail, NEVER send) ----
  let draftsCreated = 0;
  if (emails.length > 0) {
    try {
      const doDrafts =
        deps.overrides?.createDrafts ??
        ((toDraft: OutreachEmail[]) => createDrafts(deps.gmail!, toDraft, deps.overrides?.gmailDeps));
      if (deps.overrides?.createDrafts || deps.gmail) {
        const { drafts, failures: draftFailures } = await doDrafts(emails);
        draftsCreated = drafts.length;
        for (const f of draftFailures) failures.push({ stage: "draft", company: f.company, error: f.error });
        log.info("drafts complete", { drafts: draftsCreated, failed: draftFailures.length });
      } else {
        log.warn("Gmail not configured — skipping draft creation (fail-open)");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push({ stage: "draft", error: msg });
      log.error("draft stage failed", { error: msg });
    }
  }

  const finishedAt = new Date().toISOString();
  const summary: OutreachRunSummary = {
    vertical: vertical.label,
    companiesCollected: newCompanies.length,
    draftsCreated,
    failures,
    storeCsvUrl,
    storeJsonUrl,
    startedAt,
    finishedAt,
  };

  // ---- notify (monitoring: always attempt, fail-open) ----
  try {
    const notify =
      deps.overrides?.notify ?? (deps.discord ? (s: OutreachRunSummary) => postSummary(deps.discord!, s, deps.overrides?.discordDeps) : undefined);
    if (notify) {
      await notify(summary);
      log.info("discord summary posted");
    } else {
      log.warn("Discord not configured — skipping summary (fail-open)");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    summary.failures.push({ stage: "notify", error: msg });
    log.error("notify stage failed", { error: msg });
  }

  log.info("outreach run finished", { companies: summary.companiesCollected, drafts: summary.draftsCreated, failures: summary.failures.length });
  return summary;
}

// Assembles OutreachPipelineDeps from process.env for the CLI/workflow entry
// point. Optional integrations resolve to undefined when unset (fail-open).
export function outreachDepsFromEnv(githubApp: GitHubAppConfig, installationId: string, liteLLM: LiteLLMConfig, env: NodeJS.ProcessEnv = process.env): OutreachPipelineDeps {
  const store: OutreachStoreConfig | undefined =
    env.THE_STORE_OWNER && env.THE_STORE_REPO
      ? {
          owner: env.THE_STORE_OWNER,
          repo: env.THE_STORE_REPO,
          branch: env.THE_STORE_BRANCH ?? "main",
          basePath: env.OUTREACH_STORE_PATH ?? "projects/outreach/payment-processors",
        }
      : undefined;
  return {
    githubApp,
    installationId,
    liteLLM,
    modelAlias: env.OUTREACH_MODEL_ALIAS ?? "planning",
    controlRepoOwner: env.CONTROL_REPO_OWNER ?? "HeyItsChloe",
    controlRepoName: env.CONTROL_REPO_NAME ?? "agent-ops",
    controlRepoBranch: env.CONTROL_REPO_BRANCH ?? "main",
    serpapi: env.SERPAPI_API_KEY ? { apiKey: env.SERPAPI_API_KEY } : undefined,
    claudeWebSearch: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : undefined,
    store,
    gmail: gmailConfigFromEnv(env),
    discord: discordConfigFromEnv(env),
  };
}
