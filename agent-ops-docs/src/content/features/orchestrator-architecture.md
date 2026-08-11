---
title: Orchestrator Architecture
order: 9
summary: How the orchestrator is assembled — a generic pipeline-orchestrator engine registered with two handlers, a YAML registry, GitHub App auth, and two execution paths (repository_dispatch to app-repo workflows vs in-process handlers).
status: stable
implements:
  workflows: [deploy-orchestrator]
  skills: []
  dependencies: ["@heyitschloe/pipeline-orchestrator", "express", "zod", "jsonwebtoken"]
  integrations: [github-app, cloud-run, github-actions, model-providers]
runWith:
  - "Runs as one Express service (orchestrator/src/index.ts) built from the generic engine plus this repo's handlers, deployed to Cloud Run via deploy-orchestrator.yml; locally via npm run dev."
tradeoffs:
  - "The engine is a published npm package (@heyitschloe/pipeline-orchestrator) and this deployment is a thin bootstrap, so generic trigger/registry/auth logic is shared code while only the private job-search handler and extension routes live in this repo."
notes:
  - kind: tip
    body: "An entry's execution.kind decides the path: github-actions fires a repository_dispatch at the target repo's own reusable workflow; in-process runs the handler inside the orchestrator, which then calls models directly through LiteLLM."
  - kind: note
    body: "Two installations of the same GitHub App are used — the 11thandOrange org install for dev-ticket dispatch, the heyitschloe personal install for the job-search pipeline's skill fetch and the-store append. Using the wrong installation id 404s at token minting."
---

## What it does
The orchestrator is a single Express service that runs agent-ops's pipelines. Its generic machinery — trigger parsing, registry loading and validation, GitHub App auth, the HTTP/webhook/MCP surface — comes from the published package `@heyitschloe/pipeline-orchestrator`. This repo's `orchestrator/src/index.ts` is a thin bootstrap: it constructs config from env vars, registers two pipeline handlers, calls the engine's `createServer`, mounts a few extension routes on the returned app, and listens. Which pipeline runs, and how, is data in a registry file rather than engine code.

## How it works
`index.ts` calls `createServer(config, handlers)` with two registered handlers:

- **`dev-ticket-pipeline`** — shipped by the package (`createDevTicketPipelineHandler`), used by the `busybuddy-dev` and `ordermate-dev` registry entries.
- **`job-search-pipeline`** — private to this repo (`orchestrator/src/handlers/job_search_pipeline.ts`), wrapping `dispatchPersonalPipeline` behind the generic `PipelineHandler` interface, used by `resume-job-applier`.

The registry `orchestrator/src/registry/pipelines.yaml` has one entry per pipeline (`name`, `handler`, `skill_path`, `execution`, `triggers`, `params`). The engine loads and validates it (each handler exposes a Zod `paramsSchema`); a narrower second reader, `orchestrator/src/registry/load.ts`, is used only by the extension routes to validate a project name and read its params.

**Two execution paths**, chosen by an entry's `execution.kind`:

- **`github-actions`** — the `dev-ticket-pipeline` handler mints a GitHub App installation token and fires a `repository_dispatch` (`dispatchRepositoryEvent`) at the pipeline's target repo (`owner`/`repo`), with the action (`plan`/`implement`) and issue number. The actual work runs in that repo's own `dev-pipeline-reusable.yml` reusable workflow — the orchestrator never runs the pipeline itself, it only dispatches. (Label/mention events on managed repos fire their callers natively; the handler exists for the HTTP/chat path that must dispatch on the pipeline's behalf.)
- **`in-process`** — the `job-search-pipeline` handler runs inside the orchestrator process. Personal projects have no repo and no Actions runner, so the process itself does the work and calls models directly through the LiteLLM gateway (`integrations/litellm.ts`) rather than invoking Claude Code inside a CI job.

**GitHub App auth** lives in `orchestrator/src/integrations/github.ts`: it signs a short-lived App JWT (RS256, `jsonwebtoken`), exchanges it for an installation token via `POST /app/installations/{id}/access_tokens`, and caches the token per installation (refreshed 5 minutes before its 1h expiry). This replaced a PAT so scaling to a new repo is an install, not a re-scoped token. Two installations of the same App are threaded through: `GH_APP_INSTALLATION_ID` (the 11thandOrange org, for dev-ticket dispatch) and `GH_APP_INSTALLATION_ID_PERSONAL` (the heyitschloe account, for the job-search pipeline's skill fetch and the-store append).

**The integrations layer** (`orchestrator/src/integrations/`) holds the outward-facing adapters the in-process handler needs: `litellm.ts` (the OpenAI-compatible model gateway, addressing model *aliases* like `planning`), `anthropic.ts` (direct Messages API, used only by the `claude_web_search` discovery provider for Anthropic's server-side web-search tool), `github.ts` (App auth + the small GitHub API surface), `google_drive.ts` (reads a resume from a public "anyone with the link" Drive file, no OAuth), `the_store.ts` (appends completed application rows to a CSV in a separate repo; optional, fail-open), `pdf.ts` (renders drafted resume/cover-letter text to a PDF for `generated_pdf` mode), `site_sessions.ts` (resolves a saved authenticated session per site for scraping), `llmJson.ts` (parses model JSON output), and `plane.ts` (a placeholder for an optional Plane tracker — currently a no-op, GitHub issues are the system of record).

## Configuration & running
Everything is configured via env vars (see `.env.example`): the shared secret and GitHub webhook secret, the GitHub App id/private key and the two installation ids, the LiteLLM proxy URL and key, and optional sourcing/profile/the-store settings that gate the in-process job-search features on/off. Pipelines themselves are configured only by editing `orchestrator/src/registry/pipelines.yaml` — a new pipeline is a new entry, not engine code. Locally: `npm install`, copy `.env.example` to `.env`, `npm run dev` (tsx watch). In production, `deploy-orchestrator.yml` builds the multi-stage Dockerfile and deploys to Cloud Run (`agent-ops-501120`, `us-central1`) on pushes to `main` touching `orchestrator/**`, or via manual dispatch. Dependencies: `@heyitschloe/pipeline-orchestrator`, `express`, `zod`, and `jsonwebtoken`.
