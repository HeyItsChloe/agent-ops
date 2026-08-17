// CLI entrypoint for the outreach pipeline, invoked by the daily GitHub
// Action (.github/workflows/outreach-daily.yml). Loads the registry entry
// (payment-processor-outreach), assembles deps from env (same
// outreachDepsFromEnv the server uses), and dispatches the outreach handler
// once — no long-running server. All secrets come from env / GitHub Secrets
// (GMAIL_*, DISCORD_*, GH_APP_ID/GH_APP_PRIVATE_KEY, LITELLM_*, SERPAPI_API_KEY
// / ANTHROPIC_API_KEY, THE_STORE_*). They are never logged.
//
// Run: tsx scripts/run_outreach.ts [pipeline-name]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import type { GitHubAppConfig } from "@heyitschloe/pipeline-orchestrator";
import { createOutreachPipelineHandler } from "../src/handlers/outreach_pipeline.js";
import { outreachDepsFromEnv } from "../src/jobs/outreach/run.js";
import { newCorrelationId } from "../src/logging.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

interface RawPipelineEntry {
  name: string;
  handler: string;
  skill_path: string;
  execution: { kind: string; workflow?: string; owner?: string; repo?: string };
  triggers: Record<string, unknown>;
  params: Record<string, unknown>;
}

async function main() {
  const pipelineName = process.argv[2] ?? process.env.OUTREACH_PIPELINE_NAME ?? "payment-processor-outreach";

  const registryPath =
    process.env.REGISTRY_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "registry", "pipelines.yaml");
  const raw = readFileSync(registryPath, "utf-8");
  const entries = (YAML.parse(raw) as RawPipelineEntry[]) ?? [];
  const entry = entries.find((e) => e.name === pipelineName && e.handler === "outreach-pipeline");
  if (!entry) throw new Error(`no outreach-pipeline registry entry named "${pipelineName}"`);

  const githubApp: GitHubAppConfig = {
    appId: requireEnv("GH_APP_ID"),
    privateKey: requireEnv("GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  };
  const installationId = requireEnv("GH_APP_INSTALLATION_ID_PERSONAL");
  const liteLLM = { proxyUrl: requireEnv("LITELLM_PROXY_URL"), virtualKey: requireEnv("LITELLM_VIRTUAL_KEY") };

  const deps = outreachDepsFromEnv(githubApp, installationId, liteLLM);
  const handler = createOutreachPipelineHandler(deps);

  const correlationId = newCorrelationId();
  const result = await handler.run({
    pipeline: {
      name: entry.name,
      handler: entry.handler,
      skill_path: entry.skill_path,
      execution: { kind: "in-process" },
      triggers: {},
      params: entry.params,
    },
    action: "run",
    job: {
      pipeline: entry.name,
      action: "run",
      requestedBy: process.env.OUTREACH_REQUESTED_BY ?? "scheduled-cron",
      source: "dispatch",
      correlationId,
      input: {},
    },
  });

  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", message: "outreach run complete", result }));
  if (result.status === "error") process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "outreach run crashed", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
