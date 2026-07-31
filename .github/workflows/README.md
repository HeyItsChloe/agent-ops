# GitHub Actions workflows

This directory holds two kinds of workflow:

- **Reusable** (`on: workflow_call`) — the shared pipelines other repos call
  with a thin caller workflow. There are two: `wiki-generate-reusable.yml` and
  `e2e-pipeline-reusable.yml`.
- **Local** — this repo's own deploy/sync automation, triggered by pushes to
  `main`, a schedule, or manual dispatch.

> **`dev-pipeline-reusable.yml` is not here.** Several files below reference it
> in comments/registry entries, but the dev-ticket pipeline's reusable workflow
> ships with the `@heyitschloe/pipeline-orchestrator` package (and the caller
> lives in target repos), not in this repo. See [`../../README.md`](../../README.md).

See also: [`../../templates/README.md`](../../templates/README.md) for the caller
templates, and [`../../scripts/README.md`](../../scripts/README.md) for the wiki
generator the wiki workflow runs.

---

## `wiki-generate-reusable.yml` — reusable

Runs the shared wiki generator against the **calling** ("target") repo and
deploys the built site to GitHub Pages. Mirrors the dev pipeline's
central-logic / thin-caller split (agent-ops issue #286).

- **Trigger:** `workflow_call`.
- **Flow:** checkout the target repo → mint a GitHub App token for the control
  repo and check it out at `.wiki-control` → optionally run the authoring agent
  (`wiki-author.mjs`) → run `wiki-generate.mjs` → commit any changed generated
  files back to the target's default branch → build the site → deploy to Pages.

**Inputs**

| Input | Type | Default | Meaning |
|---|---|---|---|
| `site_dir` | string | `docs` | Directory in the target repo the site lives in / is bootstrapped into. |
| `config_path` | string | `wiki.config.yaml` | Path to the target repo's `wiki.config.yaml`. |
| `control_repo` | string | `HeyItsChloe/agent-ops` | `owner/repo` of this control repo; overridable so a fork can point at its own copy. |
| `control_repo_ref` | string | `main` | Ref of the control repo to check out. |
| `author_content` | boolean | `false` | Opt-in: run `wiki-author.mjs` before extraction to draft missing feature prose via the `documentation` alias. |

**Secrets**

| Secret | Required | Meaning |
|---|---|---|
| `GH_APP_ID` | yes | GitHub App id used to mint the control-repo checkout token. |
| `GH_APP_PRIVATE_KEY` | yes | GitHub App private key. |
| `LITELLM_PROXY_URL` | only if `author_content: true` | Gateway base URL for the authoring agent. |
| `LITELLM_VIRTUAL_KEY` | only if `author_content: true` | Gateway virtual key. |

**Permissions:** the `generate-and-commit` job needs `contents: write` (to push
generated output back); reusable-workflow permissions are the intersection of
caller-granted and callee-requested, so the caller must grant `contents: write`,
`pages: write`, `id-token: write`.

**Minimal caller** (also [`../../templates/wiki-caller.yml`](../../templates/wiki-caller.yml)):

```yaml
name: wiki-generate
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  generate:
    permissions:
      contents: write
      pages: write
      id-token: write
    uses: HeyItsChloe/agent-ops/.github/workflows/wiki-generate-reusable.yml@main
    with:
      site_dir: docs
      config_path: wiki.config.yaml
    secrets: inherit
```

---

## `e2e-pipeline-reusable.yml` — reusable

Shared e2e test pipeline (BusyBuddy_v2#285 Phase 6). The checkout, artifact
upload, PR comment, `record_video` toggle, and the coverage requirement live
here once; the actual test framework is always an opaque, pass-through input.

- **Trigger:** `workflow_call`.
- **Two job paths, selected by `needs_emulator`:**
  - `e2e-tests` (Playwright or any non-Android stack) — runs `install_command`
    then `test_command` directly.
  - `e2e-tests-emulator` (Android/Espresso) — boots a cached AVD and runs
    `test_command` inside a live emulator session. Contains extensive hardening
    against races in the third-party emulator action (see the file's inline
    comments).
- **Coverage gate:** when `coverage_manifest_path` is set, checks out
  agent-ops's `scripts/` and runs `check-flow-coverage.mjs` against the target's
  manifest — every declared critical flow must have a matching *passing* test.

**Inputs**

| Input | Type | Default | Meaning |
|---|---|---|---|
| `working_directory` | string | *(required)* | Where in the target repo to run install/test. |
| `install_command` | string | `""` | Repo-specific setup (ignored when `needs_emulator: true`). |
| `test_command` | string | *(required)* | The actual test command; never interpreted by this workflow. |
| `needs_emulator` | boolean | `false` | `true` for Android/Espresso — runs the test command inside a booted emulator. |
| `emulator_api_level` | number | `30` | Android API level for the AVD. |
| `record_video` | boolean | `false` | Playwright: `PLAYWRIGHT_VIDEO=on`; emulator: `adb screenrecord` around the run. |
| `coverage_manifest_path` | string | `""` | Path to the critical-flow manifest; empty skips the flow-coverage check. |
| `node_version` | string | `"22"` | Node version for the non-emulator path. |

> **Note:** the coverage step checks out `11thandOrange/agent-ops` for
> `scripts/check-flow-coverage.mjs`. This works because e2e target repos are
> same-org (11thandOrange), so no GH App token is needed there.

**Minimal caller** (see [`../../templates/e2e-pipeline-caller.yml`](../../templates/e2e-pipeline-caller.yml)
for both a Playwright and an Android/Espresso worked example):

```yaml
name: e2e-pipeline
on:
  pull_request:
    branches: [main]
jobs:
  playwright:
    permissions:
      contents: read
      pull-requests: write
    uses: 11thandOrange/agent-ops/.github/workflows/e2e-pipeline-reusable.yml@main
    with:
      working_directory: extensions/my-app
      install_command: "npx playwright install chromium --with-deps"
      test_command: "npm run test:e2e"
      needs_emulator: false
      coverage_manifest_path: e2e-coverage.yaml
```

---

## `deploy-docs.yml` — local

Builds `agent-ops-docs/` and publishes it to GitHub Pages.

- **Trigger:** push to `main` touching `agent-ops-docs/**`, or `workflow_dispatch`.
- **Why `main` (not a docs branch):** the auto-created `github-pages`
  environment restricts deployments to the default branch, so a separate
  docs-site branch was rejected outright.
- **One-time manual setup:** repo *Settings → Pages → Build and deployment →
  Source: "GitHub Actions"* must be enabled before this can succeed.
- **Permissions:** `contents: read`, `pages: write`, `id-token: write`.

## `deploy-orchestrator.yml` — local

Deploys `orchestrator/` to Cloud Run using only GitHub Secrets.

- **Trigger:** `workflow_dispatch`, or push to `main` touching `orchestrator/**`.
- **What it does:** authenticates with `GCP_SA_KEY`, assembles an env-vars file
  from secrets (required + a large set of optional, presence-gated
  personal-pipeline/applicant vars — omitted keys stay unset so `server.ts`
  defaults apply), then `gcloud run deploy orchestrator` (project
  `agent-ops-501120`, region `us-central1`, `--memory=2Gi`, `--timeout=900`).
- **Key secrets:** `GCP_SA_KEY`, `ORCHESTRATOR_SHARED_SECRET`, `GH_APP_ID`,
  `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID_11THANDORANGE`,
  `GH_APP_INSTALLATION_ID_HEYITSCHLOE`, `GH_WEBHOOK_SECRET`, `LITELLM_PROXY_URL`,
  `LITELLM_VIRTUAL_KEY`, plus optional `JSEARCH_*`, `SERPAPI_API_KEY`,
  `ANTHROPIC_API_KEY`, `THE_STORE_*`, `EXTENSION_API_KEY`, and the `APPLICANT_*`
  set. See the file for the full list and the presence-gating rationale.

## `deploy-litellm.yml` — local

Deploys `litellm/` to Cloud Run (same pattern as `deploy-orchestrator.yml`).

- **Trigger:** `workflow_dispatch`, or push to `main` touching `litellm/**`.
- **What it does:** authenticates with `GCP_SA_KEY`, writes an env-vars file
  from `GEMINI_API_KEY`, `LITELLM_VIRTUAL_KEY` (→ `LITELLM_MASTER_KEY`), and
  `DATABASE_URL`, then `gcloud run deploy litellm-gateway --source litellm/`
  (project `agent-ops-501120`, region `us-central1`, `--memory 2Gi`).

## `sync-upstream.yml` — local

Keeps this fork's `main` in sync with canonical `HeyItsChloe/agent-ops` `main`.

- **Trigger:** daily cron (`0 9 * * *`) + `workflow_dispatch`.
- **What it does:** mints an upstream-scoped App token, `git merge` (never
  rebase) upstream `main`. A clean merge pushes straight to `main`; a
  **conflicting** merge is *never* auto-resolved — it's pushed to a
  `sync/upstream-<run-id>` branch and opened as a PR for a human, who uses the
  `FORK-ONLY: do not upstream` markers to decide what to keep. See
  [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
- **Permissions:** `contents: write`, `pull-requests: write`.
- **Secrets:** `GH_APP_ID`, `GH_APP_PRIVATE_KEY` (+ the default `GITHUB_TOKEN`).

---

## Summary

| Workflow | Kind | Trigger(s) | One-liner |
|---|---|---|---|
| `wiki-generate-reusable.yml` | reusable | `workflow_call` | Generate + deploy a consuming repo's wiki. |
| `e2e-pipeline-reusable.yml` | reusable | `workflow_call` | Shared e2e tests (Playwright/Android) + coverage gate. |
| `deploy-docs.yml` | local | push `main` (`agent-ops-docs/**`), dispatch | Build & publish this repo's docs to Pages. |
| `deploy-orchestrator.yml` | local | push `main` (`orchestrator/**`), dispatch | Deploy orchestrator to Cloud Run. |
| `deploy-litellm.yml` | local | push `main` (`litellm/**`), dispatch | Deploy the LiteLLM gateway to Cloud Run. |
| `sync-upstream.yml` | local | daily cron, dispatch | Merge upstream `main` into this fork. |
