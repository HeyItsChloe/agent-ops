# Implementation Roadmap

Step-by-step build order for the multi-pipeline agent automation system. Companion to `multi-pipeline-agent-strategy.md` — that doc explains *what* and *why*; this one is *in what order, concretely*.

Each phase ends with a checkpoint: don't move to the next phase until the checkpoint passes. Build on one app repo and one personal project first — replicate to the rest only after the pattern is proven.

> **Revision note:** this version folds in a design review's decisions — GitHub App instead of PAT, Bird removed, skill onboarding turned into a reusable pipeline capability instead of a static template, and several hardening steps (auth, logging, idempotency, budget alerts) moved earlier instead of sitting in a final phase. Each change is marked **(Revised)** where it lands.

---

## Phase 0 — Accounts, access, and decisions to lock in first

- [x] Anthropic API account — pending. Gemini is the configured model for now; Claude aliases will be repointed when the key lands.
- [x] **(Re-revised) Hosting — live:** moved from the originally-provisioned Oracle Cloud Free Tier instance to **Google Cloud Run** (project `agent-ops-501120`, region `us-central1`) — the manual VM/VNIC/public-IP/Caddy setup on Oracle Cloud had real friction; Cloud Run gives an HTTPS endpoint automatically from a container push. GCP project created, billing linked, scoped service account (`agent-ops-deployer`) created with Cloud Run Admin, Service Account User, Cloud Build Editor, Artifact Registry Administrator, Storage Admin, Logs Viewer.
- [x] Create the control repo: `agent-ops` (`HeyItsChloe/agent-ops`) — no longer empty; holds the orchestrator, litellm config, skills, and both deploy workflows.
- [x] Pilot app repo: `11thandOrange/BusyBuddy_v2`. Pilot personal project: resume builder + job applier (LinkedIn, PDF output, draft-and-queue — no auto-submit).
- [ ] Qodo account — not needed; using self-hosted `PR-Agent` + `qodo-cover` instead (BYOK against the Gemini/Claude gateway).
- [x] Chat front end for the pilot: **claude.ai** — connect the MCP server as a Claude connector rather than via ChatGPT Developer Mode.
- [x] **(Revised) GitHub App, not a PAT — done.** Custom GitHub App `pipeline-orchestrator-management` created with Issues/PRs/Contents permissions, installed as two separate installations: one on the `heyitschloe` personal account, one on the `11thandOrange` organization (covering `BusyBuddy_v2`). App ID, private key, and both installation IDs live in GitHub Secrets, never in chat or in this repo.
- [ ] **Retire the OpenHands pipeline on BusyBuddy_v2** — still outstanding, blocked on this session's repo scope (can't touch `BusyBuddy_v2` directly from here regardless of the App being installed there now). Do this in a new session scoped to that repo — disable/remove the OpenHands automation registration (ID `3cfefdb0-a1bc-4f26-bcc6-4136ff0fb4da`), stop using the `ready-to-implement` label trigger, and turn off the callmebot WhatsApp notifier step so the two pipelines don't fire on the same issue.

**Checkpoint — met, except OpenHands retirement:** GCP project with billing linked and a scoped service account exists, Gemini API key confirmed working (real completions returned), the GitHub App is created and installed on both accounts. BusyBuddy_v2's old automation is not yet disabled — carries into Phase 3.

---

## Phase 1 — Stand up the model gateway — ✅ COMPLETE

Live at `https://litellm-gateway-836703226343.us-central1.run.app`.

1. Deployed `litellm/` (config.yaml + Dockerfile) to **Cloud Run**, project `agent-ops-501120`, region `us-central1` — first deploy was done manually via `gcloud run deploy --source litellm/` from a chat session (before the GitHub-Secrets-driven deploy pattern used for the orchestrator existed).
2. `litellm/config.yaml` has the `planning` and `implementation` aliases pointed at Gemini, with a commented-out Anthropic block ready to uncomment once that key arrives.
3. **(Re-revised twice)** an initial attempt to run without Postgres failed: this LiteLLM build hard-requires a DB connection for key auth, throwing a misleading `"No connected db"` error even with a correct master key (confirmed against `BerriAI/litellm` #2532, #4880, #12273). Added Postgres back via a **free-tier Supabase instance**, using its **direct connection** (port `5432`) — the transaction pooler (port `6543`) hangs on LiteLLM's startup `prisma migrate deploy`, which needs session-level behavior the pooler doesn't support.
4. Confirmed the deployed service responds with a real completion (`curl .../v1/chat/completions` with the master key) — took a few debugging rounds (the DB timeout, then a corrupted copy-paste of the master key producing a `401`) before landing on a genuine `200` with real model output.
5. No separate virtual key issued — `LITELLM_MASTER_KEY` is what GitHub Actions/the orchestrator use directly (§3's accepted trade-off, still true even with Postgres back, since dynamic key issuance was never wired up).
6. HTTPS is automatic on Cloud Run — no Caddy/Let's Encrypt/VNIC setup needed.
7. Budget alert live: GCP Billing → Budgets & alerts, budget named "Agent-Ops", scoped to `agent-ops-501120`.

**Checkpoint — met:** a curl request through the Cloud Run HTTPS URL, using the master key, returns a real completion. A GCP budget alert is live.

---

## Phase 2 — Scaffold the control repo — ✅ COMPLETE

Orchestrator live at `https://orchestrator-836703226343.us-central1.run.app`, MCP mounted at `/mcp`.

1. `agent-ops` folder structure in place (`orchestrator/`, `skills/`, `litellm/`, `.github/workflows/`).
2. Orchestrator built in Node/TypeScript/Express with three routes:
   - `POST /trigger` — generic entry point for chat/curl/Postman
   - `POST /webhook/github` — receives GitHub webhook events
   - `POST /webhook/mcp` — backing endpoint for the MCP server (Phase 6)
3. Real authentication verified working post-deploy: unauthenticated `POST /trigger` returns `401`; with the correct shared secret, requests pass through to Zod body validation (`400` on missing fields, not `401`) — confirmed auth is genuinely gating, not a no-op.
4. Structured logging with a correlation ID per request is wired (`src/logging.ts`).
5. `registry/projects.yaml` has the `app-1` entry using the extended schema (`model_profile`, `skill_folder`, `test_gate`, `project_language`, `test_command`, `coverage_type`, `desired_coverage`, `reviewer`). (Later split into `registry/development/projects.yaml`/`registry/personal/projects.yaml` — see the Phase 7 dev/personal separation note.)
6. Shared skills written: `approach-doc-format`, `approval-gate-protocol`, and `project-scaffold` (the onboarding-as-a-skill capability, §6.1).
7. `skills/app-1/SKILL.md` written by hand as the reference example for BusyBuddy_v2.
8. `agent-ops/.github/workflows/dev-pipeline-reusable.yml` written — the one place the dev pipeline's CI logic lives.
9. **(New)** deployed via a dedicated GitHub Actions workflow (`.github/workflows/deploy-orchestrator.yml`), driven entirely by GitHub Secrets rather than running `gcloud` from chat — the credential-in-chat problem from Phase 1's LiteLLM deploy prompted building this pattern before deploying the orchestrator.
10. **Still open:** the GitHub App's Webhook URL hasn't been pointed at `https://orchestrator-836703226343.us-central1.run.app/webhook/github` yet, so `/webhook/github`'s real HMAC signature verification hasn't been exercised against a live GitHub event yet (the shared-secret-based endpoints are confirmed; this one needs an actual webhook delivery to prove out).

**Checkpoint — met:** `agent-ops` has a running orchestrator, reachable over HTTPS, genuinely authenticated (verified via curl, not assumed), logging with correlation IDs, all skills written, and the reusable workflow file in place.

---

## Phase 3 — Dev pipeline: planning stage only — ✅ COMPLETE

Validated live against `11thandOrange/BusyBuddy_v2`. Getting here took several rounds of real-run debugging, not a clean first pass — each of these was found from an actual Actions log, not anticipated in advance:

- Missing `id-token: write` permission blocked `anthropics/claude-code-action@v1`'s OIDC request — added explicit `permissions:` blocks to both reusable-workflow jobs (the caller workflow needs a matching block too, since reusable-workflow permissions are the *intersection* of caller and callee).
- `gemini-2.5-pro` had a `0` free-tier quota — `planning` alias repointed to `gemini-2.5-flash`, with `implementation-fallback` wired in for both aliases.
- Skill files (`.agent-ops/...`) didn't exist in the runner's checkout — added a second cross-account GitHub App token + checkout of `agent-ops` itself into `.agent-ops/`.
- The agent stopped and asked for interactive tool approval with no human to answer it on a CI runner — fixed with `--permission-mode dontAsk` plus explicit `--allowedTools`, verified locally against the raw CLI before trusting it in CI.
- The prompt never named which issue to work on (the action doesn't auto-inject issue context) — interpolated the issue number into the prompt from both possible trigger shapes; this also surfaced that the orchestrator's own `dispatchRepositoryEvent` never sent the issue number in its `repository_dispatch` payload, fixed across `github.ts`/`plan_ticket.ts`/`implement_ticket.ts`.
- Retroactive sub-issue linking (`gh api .../sub_issues` or a GraphQL `addSubIssue` mutation after creating a plain issue) reliably 403'd — the prompt and `approach-doc-format/SKILL.md` now mandate the atomic `gh issue create --parent` form exclusively.

**Checkpoint — met:** real GitHub sub-issues get created with subtask content in their descriptions, the parent issue gets labeled `approach-ready`, and a retried plan run doesn't duplicate sub-issues.

**Still outstanding from this phase's original scope, not blocking:** the OpenHands retirement on BusyBuddy_v2 (Phase 0) hasn't happened yet; the curl/`@dev-agent` trigger paths and the commenter-allowlist check haven't been separately exercised live (only the label-triggered path has been proven end to end).

---

## Phase 4 — Dev pipeline: implementation + quality gate — ✅ COMPLETE

Validated live on the same pilot repo. Two more rounds of real-run debugging on top of Phase 3's:

- The Qodo coverage-gate step's `--branch` input was empty, crashing with `fatal: empty string is not a valid pathspec`. First attempt (`github.head_ref`) was wrong because this job isn't `pull_request`-triggered. Second attempt (`claude-code-action`'s own `branch_name` output) reproduced the identical failure on retest, because that output is only populated when the action manages branch creation itself in its built-in "tag mode" — this workflow runs it in plain prompt mode, so Claude Code creates the branch itself via Bash and the action never sees it. Fixed by computing the branch name *before* Claude Code runs and having the prompt, the workflow step, and the Qodo input all reference that one precomputed value instead of two of them guessing independently.
- The same log surfaced a second bug: `.agent-ops`'s checkout sits inside the main working tree (nested `.git` dir), so a broad `git add -A` from Claude Code could get it auto-staged as a gitlink with no matching `.gitmodules` entry — fixed by excluding `.agent-ops/` via `.git/info/exclude` in both jobs, so git never sees it as trackable content in the outer repo.

**Checkpoint — met:** a real ticket went from `approved` label to a PR with the coverage gate running (not crashing) and the registry-configured reviewer tagged, with no manual steps in between.

**Still outstanding from this phase's original scope, not blocking:** the self-hosted PR-Agent/qodo-cover-vs-hosted-Qodo parity call, the deliberate under-tested-change gate-blocking check, folding in the existing Playwright smoke tests, and a deliberately forced mid-pipeline failure test haven't been separately exercised yet — worth doing during Phase 5's real-ticket runs rather than as a one-off synthetic test.

---

## Phase 4.5 — Two-tier skill model (shared, matched by tag) — ✅ COMPLETE

Skills are matched to projects by tag instead of every project's skill file being a fixed registry pointer.

- **Shared tier** — every dev skill lives in `agent-ops/skills/shared/dev/` (moved from `skills/shared/` directly during the dev/personal separation work, see the new phase note below), tagged `applies_to: all`, `applies_to: [<language>, ...]`, or `applies_to: [repo:<owner>/<name>]` in frontmatter. The reusable workflow's "Match shared skills" step compares this against the project's `project_language` (a list) and/or `repo` field and tells Claude Code to read whichever skills match — the workflow never hardcodes a skill name. `skills/app-1/SKILL.md` (BusyBuddy_v2's own conventions) moved here as `skills/shared/dev/project-conventions/SKILL.md`, tagged `applies_to: all` — an ordinary shared skill, not narrowed to one repo, per explicit correction mid-build (an earlier version of this phase had it moving *into* BusyBuddy_v2 as repo-local; that was wrong and reverted before any code was written).
- **Repo-local tier** — for a skill specific enough to one repo that it belongs in that repo's own checkout instead of a `repo:` tag in agent-ops. A "List repo-local skills" step reads every `*.md` under `skills/` in the caller's own default checkout, unconditionally — no `applies_to` needed, living there is what scopes it. First real use: BusyBuddy_v2's legacy `.agents`-era domain knowledge (Shopify cart-transformer extension specifics, plus the Express/Mongoose/React/Redux/Polaris/async-await conventions that turned out *not* to belong in the shared tier — they're stack-specific to this one repo, not universal) was triaged and migrated into `skills/shopify-cart-transformer.md` and `skills/backend-frontend-conventions.md` at BusyBuddy_v2's own root (PR #171, merged), rather than folded into `project-conventions`.

**Checkpoint — met, validated live on BusyBuddy_v2 run #24 (28659515991, `dispatch/plan`, conclusion: success):** the "List repo-local skills" step ran correctly, and the job logs show Claude Code's own `Read` tool call returning the literal, verbatim content of `skills/backend-frontend-conventions.md`, plus an explicit reference to `skills/shopify-cart-transformer.md` in its reasoning. Both tiers of the model confirmed working end to end — shared skills matched by tag, repo-local skills read unconditionally from the caller's own checkout — nothing left unverified.

---

## Phase 5 — Close the loop on one repo

1. Run 3–5 real tickets of varying size through the full pipeline (plan → approve → implement → gate → PR) on the pilot repo.
2. Tune the skill files based on what Claude Code consistently gets wrong or has to be told repeatedly — the shared `agent-ops/skills/shared/dev/project-conventions/SKILL.md` for general conventions, and BusyBuddy_v2's own repo-local `skills/shopify-cart-transformer.md`/`skills/backend-frontend-conventions.md` (Phase 4.5) for anything specific to this repo's actual stack.
3. Tune `max-turns` and the Qodo `desired_coverage` target based on real run costs/times.
4. Decide your approval mechanism for real use: is labeling `approved` by hand enough, or do you want the orchestrator to ping you somewhere first? Note this is a chat-only ping (strategy doc §5.2) — there is no separate notification channel to wire up.
5. **(Revised)** if PR volume across this repo alone already feels like a lot for one reviewer, this is the point to note it — no pipeline change needed, just a reminder that `reviewer` is a per-project registry field and can be changed anytime (strategy doc §8).

**Checkpoint:** you trust this pipeline enough to use it on real, non-test tickets without watching every step.

---

## Phase 6 — MCP server and chat front end

1. Build the MCP server wrapping the orchestrator's job functions as tools: `create_ticket`, `check_status`, `request_approval`, and **(Revised)** the generic `run_project_pipeline(project, request)` tool (instead of one tool per personal-project type) and `scaffold_project(name, type, repo?)` — using the official MCP SDK (TypeScript or Python — match your orchestrator's language).
2. Deploy it behind the same HTTPS domain as the orchestrator (a path like `/mcp` is fine), behind the same auth from Phase 2.
3. Connect it to your chosen chat platform:
   - **Claude (claude.ai):** add the MCP server as a connector in Claude's settings — this is the primary front end for this build.
   - **ChatGPT (optional, later):** Settings → Connectors → enable Developer Mode → Add custom connector → paste the MCP URL → authenticate, if you want a second front end on the same server down the line.
4. Test each tool from chat: "create a ticket for X in app-1," "what's the status of issue #42," "approve the approach on #42," "scaffold a new dev project called app-2."
5. Confirm write actions (creating tickets, approving, scaffolding) prompt for confirmation appropriately rather than firing silently — set this deliberately, don't rely on defaults.

**Checkpoint:** you can trigger and check on dev pipeline runs entirely from chat, with the same MCP server ready to connect to a second chat platform later with no backend changes.

---

## Phase 7 — Personal assistant: resume builder + job applier — code complete, live-credential testing outstanding

1. [x] Skill written (`skills/personal/resume-job-applier/SKILL.md`): resume/cover letter rules, **PDF or Google Drive link, independently configurable per document** (`resume_source`/`cover_letter_source` — Revised, widened from PDF-only), and the pipeline **drafts and queues, it never submits**. Scoped to LinkedIn only for now.
2. [x] **(Re-revised)** the sourcing question from the original plan — manual input, authorized API, or scraping — is resolved by decision, not avoidance: `sourcing_method` is a configurable, per-project registry field (`scraping` | `api` | `manual`), and `scraping` is now the accepted default for this project. This is a knowing acceptance of the ToS exposure the original plan flagged, not a resolution of it — see `skills/personal/resume-job-applier/sourcing/scraping/SKILL.md` for the explicit risk note. `api`/`manual` remain available as ToS-safe overrides.
3. [x] Registry entry added by hand at `registry/personal/projects.yaml` (registry split into `development/`/`personal/` as part of this same pass — see the new phase note below; `scaffold_project` also updated to write to the correct file).
4. [x] Job wired through the orchestrator — but structurally different from the dev pipeline, not a re-use of it: `run_project_pipeline` originally branched on call shape (`repo`+`issueNumber` vs `project`+`request`); **(Re-revised)** now split into two literal MCP tools, `run_development_project_pipeline`/`run_personal_project_pipeline` (§ note below), with the personal one calling `run_personal_pipeline.ts` directly since personal projects have no repo/CI runner to dispatch to. That job loads the skill (fetched via GitHub Contents API — `skills/` isn't in the orchestrator's own Docker build context), discovers candidate postings per the requested `strategy`, gathers each via the selected `sourcing_method`, calls the `planning` model alias through `integrations/litellm.ts`, and renders `generated_pdf` documents via `integrations/pdf.ts` (pdfkit).
5. [x] **(New) Discovery strategy added:** `scrapeOne` (default, one known posting) / `scrapeAll` (crawl one given site's listings, `jobs/discovery/scrapeAll.ts`, model-assisted candidate extraction since fixed selectors can't generalize per site) / `scrapeAny` (open-web search via a configurable search API, `jobs/discovery/scrapeAny.ts`, **no site allowlist — confirmed and deliberate**). Both cap at `max_results` (default 10, per-call override) — each result costs a full model call plus document renders. Candidates filtered by a new `JobCriteria` type (`jobs/criteria.ts`) — title, location, remote, salary, skills, keywords, date posted, company, whitelist/blacklist — deliberately forgiving toward missing data.
6. [x] **(New) `formFields` added to the output package** — a flat label→value map alongside the narrative application summary, and **(New) a local companion prefill script**, `orchestrator/scripts/job-application-form-prefill.mjs`: opens a job link in a visible (non-headless) browser using your saved session, heuristically matches detected form fields to `formFields` by label/placeholder/name token overlap with an optional LLM-assisted fallback for ambiguous fields, fills them, and stops — **fill-only, permanently, confirmed during planning**; no code path clicks submit. Verified locally against a hand-built test HTML form (4/4 fields correctly detected, matched, and filled; the submit button correctly excluded from candidates) — not yet verified against a real, live application form.
7. [x] **(New) CSV storage wired, but blocked on a missing repo:** `integrations/the_store.ts` appends one row per completed application to a CSV in a separate repo, `the-store` (`projects/job-applications/job-app-results.csv`) — gated: skipped with a warning log, not a hard failure, while `THE_STORE_*` env vars are unset. **The repo doesn't exist yet, and this session's GitHub integration can't create repositories** (`403 Resource not accessible by integration`, confirmed by attempting it) — creating `HeyItsChloe/the-store` (private) needs to happen outside this session, then the GitHub App needs installing on it.
8. [x] **the-store created** — `HeyItsChloe/the-store` (private) exists, added to session scope and cloned (confirmed empty — zero commits, no branches yet). **Still open:** the GitHub App needs installing on it before the deployed orchestrator can write to it (only a human can do this, via GitHub App settings).
9. [x] **Partial-batch-failure gap fixed.** Found during a later confirmation pass: a `scrapeAll`/`scrapeAny` batch with one bad candidate aborted the whole request, losing every already-drafted result even though earlier `the-store` rows may have already been written. `PersonalPipelineResult` is now `(ApplicationPackage | ApplicationFailure)[]` — each candidate is caught independently; a partial batch returns whatever succeeded plus a failure entry (with the error message) for whatever didn't.
10. [x] **`deploy-orchestrator.yml` now forwards the new personal-pipeline env vars.** Found during the same pass: `JOB_API_BASE_URL/KEY`, `SITE_SESSIONS_DIR`, `WEB_SEARCH_API_URL/KEY`, and `THE_STORE_*` were never in this workflow's secrets-forwarding step at all — setting them as GitHub Secrets alone would never have reached the deployed service. Added, conditionally (only when the underlying secret is actually set, so an unset optional var doesn't override an in-code default with a literal empty string — `gcloud run deploy --env-vars-file` fully replaces the service's env vars each deploy).
11. [x] **Playwright browser binaries added to the deploy pipeline.** `orchestrator/Dockerfile`'s final stage now runs `npx playwright install --with-deps chromium` (verified as valid CLI syntax against Playwright's own `--help`, but **not build-verified** — no Docker daemon available in the environment this was built in, so the image itself was never actually built). `deploy-orchestrator.yml`'s `gcloud run deploy` also now sets `--memory=2Gi` (Chromium alongside Node needs more than Cloud Run's 512Mi default) and `--timeout=900` (a rough accommodation for `scrapeAll`/`scrapeAny`'s still-fully-synchronous multi-candidate processing, not a fix for that underlying design — see §5.3's cost/latency note).
12. [ ] **Not yet run against real job postings or a real LinkedIn session.** Everything above is implemented and typechecks, but: no live LiteLLM gateway credentials, no `SITE_SESSIONS_DIR` (authenticated Playwright sessions — **Revised**, was a single `LINKEDIN_STORAGE_STATE_PATH` path until a real design flaw was caught: `scrapeAll` had been wired to reuse it too, even though `scrapeAll` crawls arbitrary sites by design; now a directory of per-hostname session files, `integrations/site_sessions.ts`), no `WEB_SEARCH_API_URL`/`KEY`, and no `JOB_API_BASE_URL`/`JOB_API_KEY` were available in the environment this was built in. In particular, `sourcing/scraping.ts`'s selectors (`.jobs-description__content`, `.jobs-box__html-content`) are a first draft against LinkedIn's presumed page structure, not verified against a live page — check these against a real posting before trusting the scraping path. The Dockerfile fix above hasn't been build-verified either.
13. [ ] Test with a handful of real job postings across all three strategies, end to end, confirming the human-submit handoff is clear and nothing auto-submits — including a real run of `job-application-form-prefill.mjs` against a live application form.
14. [x] **(Revised)** notifications: the result comes back through whichever chat platform is connected to the MCP server. There is no separate notification channel to add or configure — Bird is not part of this system.

**Checkpoint — not yet met:** the code path exists, typechecks (`npm run typecheck`/`npm run build` pass), `job-application-form-prefill.mjs`'s field-matching/fill logic has been verified against a local test form, `the-store` exists, and the deploy pipeline now actually forwards every env var the code needs. What's left is genuinely un-verifiable without live access: real `LITELLM_PROXY_URL`/`LITELLM_VIRTUAL_KEY` traffic, a real `SITE_SESSIONS_DIR` with a saved LinkedIn session, confirming the scraping/discovery selectors against real postings, an actual Docker build of the updated Dockerfile, and installing the GitHub App on `the-store`.

### Dev/personal separation (folded into this same pass, not a separate phase)

Requested alongside Phase 7 rather than after it: dev and personal projects are now separated at the registry, skill, and code-path level, not just conceptually.

- Registry split into `registry/development/projects.yaml` and `registry/personal/projects.yaml` (was one shared `projects.yaml`) — `types.ts`'s `ProjectEntry` correspondingly split into a `DevProjectEntry`/`PersonalProjectEntry` discriminated union instead of one interface with optional fields for either shape.
- `skills/shared/` renamed to `skills/shared/dev/` — the dev-only shared/repo-local skill-matching tiers (Phase 4.5) never applied to personal projects in practice (their content is all GitHub-ticket/PR concepts), but nothing structurally prevented a future personal code path from reaching them until this rename. Personal projects have no shared tier of their own; each one's skill folder is fully self-contained.
- **(Re-revised)** `run_project_pipeline` dispatch was originally one function branching on call shape; now split into two literal MCP tools/handlers (`run_development_project_pipeline`/`run_personal_project_pipeline`) — dev and personal request shapes are structurally distinct at the schema level, not just at a runtime branch, so a personal-shaped call can't accidentally hit the dev dispatcher or vice versa. `POST /trigger` (Postman/curl) got the equivalent split at the same time — it had been dev-only since Phase 2 and never gained a personal-pipeline shape until now.

---

## Phase 8 — Scale to additional app repos

For each new app repo:
1. **(Revised)** install the GitHub App on the new repo — no PAT to re-mint or re-scope.
2. Call `scaffold_project(name: "app-2", type: "dev", repo: "...")` (Phase 6) to generate the project skill folder, the registry entry, and the thin caller workflow file in one action — rather than writing all three by hand as in the original plan.
3. Add the same two LiteLLM repo secrets (`LITELLM_PROXY_URL`, `LITELLM_VIRTUAL_KEY`) plus the GitHub App secrets if not inherited from an org-level secret.
4. Run the same 3–5 test tickets as Phase 5 before trusting it with real work, including the idempotency and forced-failure checks from Phases 3–4.

Do this for app-2 and app-3 only after Phase 5's checkpoint is solid — don't parallelize the first replication with debugging the original.

---

## Phase 9 — Scale to additional personal projects

For each new personal project (property sourcing, asset purchases, etc.):
1. Call `scaffold_project(name, type: "personal")` (Phase 6) to generate its skill folder and registry entry, rather than writing both by hand.
2. Confirm the registry entry references the right model alias.
3. Decide if it needs a dedicated context/thread separation from other personal projects (e.g. a clearly separated chat thread) so research on one project doesn't bleed into another. **(Revised)** this is chat-thread separation only — there's no separate sender identity to configure, since Bird and multi-channel notifications are not part of this system.
4. Test with real low-stakes requests before relying on it.

---

## Phase 10 — Remaining hardening

**(Revised)** most of the original Phase 10 items — endpoint auth, budget alerts, structured logging, idempotency/partial-failure handling — have been moved earlier (Phases 1–4) so the risk window they cover doesn't span the whole build. What's left here is genuinely end-of-build or ongoing:

- [ ] Re-check current Claude automation billing terms (once the Anthropic key is added), Gemini/Perplexity consumer MCP support, and your self-hosted PR-Agent/qodo-cover setup against your stack — all were noted as moving targets in the strategy doc.
- [ ] Back up `agent-ops` (skills, registry, orchestrator code) somewhere beyond GitHub's own availability — this repo is now infrastructure, not just code.
- [ ] Revisit the self-hosted Qodo fallback decision (strategy doc §4.4) once more real-world PRs have gone through the gate, in case behavior changes with scale.
- [ ] Revisit the single-reviewer setup if PR volume across multiple repos makes it a bottleneck (strategy doc §8) — a registry edit, not a rebuild.
- [ ] **(New) Rotate every credential that was ever pasted into a chat session during setup**, once the pipeline is stable — specifically the GitHub App webhook secret, the `agent-ops-deployer` GCP service account key, the orchestrator's shared secret, and the **Supabase database password** (`DATABASE_URL`) — the last one got re-shared in chat a second time when setting up `deploy-litellm.yml`'s required `DATABASE_URL` GitHub Secret. Generate a fresh value in the source system (GitHub App settings for the webhook secret; IAM & Admin → Service Accounts → Keys for the SA key; Supabase → Database → Reset password for the DB), update the corresponding GitHub Secret to match, and delete/revoke the old one so the exposed value stops working entirely, not just goes unused. Treat this as the general rule going forward too: anything that touches a chat transcript during setup gets rotated before being trusted long-term, not left in place because it happens to still work.

---

## Suggested overall order

```
Phase 0 → 1 → 2 → 3 → 4 → 5  (one app repo, fully working — auth, logging,
                  ↓             idempotency, and budget alerts already in place
                                by the time this phase starts)
                Phase 6  (chat front end, once the dev pipeline is trustworthy)
                  ↓
                Phase 7  (one personal project, with the ToS sourcing question resolved)
                  ↓
        Phase 8  +  Phase 9  (replicate to remaining apps/projects, using the
                  ↓            scaffold skill instead of manual copy-paste; in
                                parallel is fine here)
                Phase 10 (remaining hardening — ongoing, but the highest-risk
                          items no longer wait this long)
```
