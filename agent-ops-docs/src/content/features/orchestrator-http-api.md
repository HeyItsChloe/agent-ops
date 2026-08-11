---
title: Orchestrator HTTP API
order: 8
summary: The orchestrator's Express HTTP surface — engine trigger/webhook routes plus this deployment's own Chrome-extension routes — authored by hand because the endpoint extractor only sees router.* registrations, not app.*.
status: stable
implements:
  workflows: [deploy-orchestrator]
  skills: []
  dependencies: ["@heyitschloe/pipeline-orchestrator", "express"]
  integrations: [github-app, cloud-run, github-actions]
runWith:
  - "Runs as the Express service in orchestrator/src/index.ts (engine routes from createServer, extension routes mounted on the returned app) deployed to Cloud Run via deploy-orchestrator.yml; locally via npm run dev."
tradeoffs:
  - "Every route is registered with Express app.* (in the engine's server.js and in index.ts), which the endpointsExpress extractor's router.* regex never matches, so this page is authored by hand rather than generated."
notes:
  - kind: important
    body: "The shared-secret routes check an x-orchestrator-secret header (not a bearer token or query param); the extension routes check x-extension-api-key; /webhook/github verifies GitHub's x-hub-signature-256 HMAC."
  - kind: note
    body: "The extension routes are mounted only when EXTENSION_API_KEY is set, so they return 404 (route absent) rather than 401 when the deployment has no extension key configured."
---

## What it does
The orchestrator exposes a small HTTP surface over Express. Most of it comes from the generic engine's `createServer` (`@heyitschloe/pipeline-orchestrator`): a shared-secret `/trigger` endpoint, two webhook receivers (`/webhook/github`, `/webhook/mcp`), and a mounted MCP HTTP server under `/mcp`. On top of that, this deployment mounts its own three Chrome-extension routes under `/personal-projects/*` directly on the Express `app` that `createServer` returns (`orchestrator/src/index.ts`). None of these are captured by the wiki's `endpointsExpress` extractor, so they are documented here by hand — see the note below.

## How it works
Every route is registered with `app.get`/`app.post`/`app.use`, split across two files.

Engine routes (in the package's `server.js`, mounted by `createServer`):

- **POST `/trigger`** — `sharedSecretAuth` (header `x-orchestrator-secret`). Runs `handleHttpTrigger`: the body names a registry `pipeline` (or an `httpKind` matched against a pipeline's `triggers.http_kind`), and the engine dispatches the matching handler. Responds `202` when the handler dispatches out (e.g. a `github-actions` pipeline), `200` on an in-process result, `502` on error. This is how the in-process `resume-job-applier` pipeline is reachable over HTTP (`http_kind: personal`).
- **POST `/webhook/mcp`** — `sharedSecretAuth` (`x-orchestrator-secret`). Runs `handleChatCommand` for chat-tool-style invocations (e.g. `run_personal_project_pipeline`).
- **POST `/webhook/github`** — `githubWebhookAuth`, which verifies GitHub's `x-hub-signature-256` HMAC against `GH_WEBHOOK_SECRET`. This endpoint is observability-only: it parses `issues`/`issue_comment`/`pull_request`/`check_run` events and logs the label/mention job it *would* represent, but does not re-dispatch — managed repos fire their pipelines natively via their own caller workflows. Always returns `204`.
- **`/mcp`** (all methods) — `sharedSecretAuth` middleware, then a streamable MCP HTTP server mounted via `mountMcpHttp`, pointed back at the orchestrator's own `localhost` URL.

Extension routes (in `orchestrator/src/index.ts`, mounted only when `EXTENSION_API_KEY` is set), all guarded by `extensionAuth` (header `x-extension-api-key`):

- **GET `/personal-projects/:project/applications?url=...`** — `handleApplicationsLookup`. Validates `:project` against the registry, requires the `url` query param (`400` if missing), and looks the URL up in "the-store" CSV. Returns `{ found: false }` when the-store is unconfigured or no row matches (fail-open, not an error), else `{ found: true, company, jobTitle, dateApplied, formFields }`.
- **GET `/personal-projects/:project/applicant-profile`** — `handleApplicantProfileLookup`. Returns the server-side `ApplicantProfile` (`{ found: true, profile }`) so the extension needn't store a second copy of the applicant's PII; `{ found: false }` when no profile is configured.
- **POST `/personal-projects/:project/generate-answer`** — `handleGenerateAnswer`. On-demand per-question drafting via the LiteLLM gateway for pages never run through the batch pipeline; always drafts (never refuses) except for specific checkable facts not backed by the page context or applicant profile.

All three extension routes first call `loadJobSearchPipeline(project)` (`orchestrator/src/registry/load.ts`) and return `404` for an unknown project name.

There is no `/email` route on `main` as of this writing — neither the engine's `server.js` nor `orchestrator/src/` registers one, so nothing with an `x-orchestrator-secret` `/email` surface exists to document yet. (Uncertain / forward-looking: if one is later added, it would belong here alongside the other shared-secret routes.)

## Configuration & running
Auth secrets come from env vars: `ORCHESTRATOR_SHARED_SECRET` (the `x-orchestrator-secret` value for `/trigger`, `/webhook/mcp`, `/mcp`), `GH_WEBHOOK_SECRET` (the GitHub HMAC secret for `/webhook/github`), and `EXTENSION_API_KEY` (the `x-extension-api-key` value; when unset the extension routes are not mounted at all). The service also needs the GitHub App id/key/installation ids and the LiteLLM proxy URL and key for the handlers behind these routes. Locally: copy `.env.example` to `.env`, `npm install`, then `npm run dev` (tsx watch) and the app listens on `PORT` (default `3000`). In production `deploy-orchestrator.yml` builds the Dockerfile and deploys to Cloud Run.

> Why this page is authored by hand: the wiki's `endpointsExpress` extractor matches route registrations of the form `router.get(...)` / `router.post(...)` (its regex keys off `router.`), following the one-router-file-per-feature layout used by the managed app repos. The orchestrator instead registers everything with `app.*` — the engine's `server.js` uses `app.post("/trigger", ...)` etc., and `index.ts` mounts the extension routes with `app.get`/`app.post` on the returned app — so the extractor emits nothing for this service and its HTTP surface must be written here.
