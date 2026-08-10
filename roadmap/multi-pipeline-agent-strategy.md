# Multi-Pipeline Agent Automation Strategy

A model-agnostic, multi-project automation system covering both software development tickets and personal-assistant workflows, built around Claude as the automation engine, a swappable chat front end, and a single orchestrator that scales across multiple apps and multiple personal projects.

> **Revision note:** this version supersedes the original draft after a design review. Changes are called out inline as **(Revised)**; the rationale for each is in `docs/decisions-log.md`.

> **Split note (2026-07-19):** the single-repo design described below (one
> `orchestrator/` in `agent-ops` running both pipelines) has been split into
> two repos. The generic engine + dev-ticket-pipeline handler moved to the
> public, self-hosted `HeyItsChloe/pipeline-orchestrator` — see its README
> for the registry format and how to write a custom pipeline handler.
> `agent-ops/orchestrator` is now a thin bootstrap that imports that engine
> as a dependency, registers the dev-ticket-pipeline handler (for
> `busybuddy-dev`) and this repo's own private `job-search-pipeline` handler
> (for `resume-job-applier`), and boots one server — see `src/index.ts`. The
> two-file `registry/development/` + `registry/personal/` split described in
> §6 is now one `registry/pipelines.yaml`. Everything else below —
> triggers, the plan/implement/quality-gate flow, the personal pipeline's
> discovery/sourcing mechanics, the-store — is still accurate; only *where
> the code lives* changed, not what it does.

---

## 1. Goals

1. Complete GitHub tickets end-to-end: review repo context, break tickets into real subtasks, get human approval on the approach, implement, test, and open a PR for review.
2. Act as a personal assistant: chat-driven task execution, ticket creation/management, research, and — via chat only — result delivery.
3. Run this for 3+ app repos concurrently without duplicating the pipeline per app.
4. Run this for 3+ personal projects concurrently (trip planning, property sourcing, asset purchases) without duplicating the pipeline per project.
5. Keep every component swappable: the model behind any task, and the chat platform used to talk to the system.

---

## 2. Core architecture

```
                 ┌────────────────────────────┐
   Triggers ───▶ │   Trigger adapter           │
 (GH label,      │   normalizes to one job      │
  @mention,      │   payload regardless of      │
  chat, curl)    │   source                     │
                 └─────────────┬──────────────┘
                                ▼
                 ┌────────────────────────────┐
                 │   Orchestrator              │
                 │   routing, state,            │
                 │   approval gates,             │
                 │   per-project registry,       │
                 │   auth on all endpoints,       │
                 │   structured logging (Revised) │
                 └──────┬───────────────┬──────┘
                         ▼               ▼
            ┌─────────────────┐  ┌─────────────────────┐
            │ Dev ticket       │  │ Personal assistant   │
            │ pipeline          │  │ pipeline              │
            │ (per app repo)    │  │ (per personal project)│
            └─────────────────┘  └─────────────────────┘
                         │               │
                         └───────┬───────┘
                                 ▼
                 ┌────────────────────────────┐
                 │   Shared agent layer         │
                 │   model gateway (LiteLLM)     │
                 │   Claude Code, local models    │
                 │   skills repo + RAG             │
                 └────────────────────────────┘
```

Three structural principles run through everything below (third one added in this revision):

- **Model-agnostic by config, not code.** Every call to an LLM goes through a gateway. Swapping which model powers a pipeline or task is a one-line config change.
- **One integration per surface, parameterized per project.** One orchestrator, one MCP server, one skill-folder pattern, one CI workflow — each project is a config entry, not a forked copy of the pipeline. **(Revised)** this now applies to the GitHub Actions workflow too (§4.5) and to skill onboarding (§6.1) — both were exceptions to this rule in the original draft.
- **Auth and observability are day-one concerns, not day-ninety.** **(Revised)** the original draft deferred endpoint auth, budget alerts, and structured logging to a final hardening phase. Both are now built alongside the pieces they protect (§8, §9.1).

---

## 3. Model-agnostic orchestrator: LiteLLM

**What it is:** an open-source (MIT-licensed, free) proxy that puts one OpenAI-compatible endpoint in front of 100+ model providers — Claude, GPT, Gemini, local Ollama models, etc. The proxy itself costs $0; you pay providers directly at their standard rates and host the proxy yourself (a small VPS is enough at this scale, roughly $10–40/month). A paid Enterprise tier exists only for SSO/RBAC/governance features, which don't matter for a single-person setup.

**Why it matters here:** the orchestrator and every agent call a *model alias* (`planning`, `implementation`, `classification`) rather than a literal model name. Changing which model answers to that alias is a one-line edit in `litellm/config.yaml` — no pipeline code changes.

```yaml
# litellm/config.yaml
model_list:
  - model_name: planning
    litellm_params:
      model: anthropic/claude-opus-4-8
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: implementation
    litellm_params:
      model: anthropic/claude-sonnet-5
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: classification
    litellm_params:
      model: ollama/qwen2.5-coder:7b
      api_base: http://localhost:11434

  - model_name: implementation-fallback
    litellm_params:
      model: openai/gpt-5.1
      api_key: os.environ/OPENAI_API_KEY

router_settings:
  fallbacks:
    - implementation: ["implementation-fallback"]

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
```

Each project's registry entry (see §6) references the alias, not a hardcoded model — so the same `projects.yaml` line works whether `implementation` currently points at Claude or something else.

**(Re-revised twice) Postgres is required after all — but external, not self-hosted.** An initial attempt to drop Postgres entirely (reasoning: it only backs the optional virtual-key/spend-tracking layer, not core routing) turned out to be wrong for this LiteLLM build: it hard-depends on a DB connection existing for key auth, and throws a misleading `"No connected db"` error even with a correct master key if neither `prisma_client` nor `custom_db_client` is configured (confirmed against `BerriAI/litellm` issues #2532, #4880, #12273 — not something fixable from config alone). `DATABASE_URL` now points at a **free-tier Supabase Postgres instance**, using Supabase's **direct connection** (port `5432`), not its transaction-mode connection pooler (port `6543`) — the pooler doesn't support the multi-statement/advisory-lock behavior LiteLLM's startup `prisma migrate deploy` needs, and hangs/times out against it. This avoids Cloud SQL's recurring cost while still satisfying the hard DB requirement.

Trade-off still accepted, DB or not: there's no separately-scoped, revocable key distinct from `LITELLM_MASTER_KEY` in active use — the master key is what GitHub Actions/the orchestrator actually use, since wiring up real per-project dynamic key issuance (now technically possible with the DB in place) hasn't been built yet. Worth doing once `app-2`/`app-3` make spend-by-repo breakdown actually matter.

**(Re-revised) budget alert moves outside LiteLLM entirely.** Rather than LiteLLM's own DB-backed alerting (which needs the Postgres this doc just dropped), the budget alert is **GCP's native Billing → Budgets & alerts** on the underlying Gemini/Vertex spend — free, no extra infrastructure, and arguably more authoritative since it reflects actual billed spend rather than LiteLLM's own estimate. This still satisfies the original goal (§8, §9.1): a real alert live before real pipeline traffic runs, just via a different mechanism than originally planned.

---

## 4. Dev ticket pipeline

### 4.1 Triggers — four entry points, one job

The pipeline must be startable by:
- a GitHub label change (e.g. label set to `approved`)
- a prompt in conversation (chat platform → orchestrator)
- a direct Postman/curl request to the orchestrator's HTTP API
- an `@agent_name` comment on a GitHub issue or PR

All four normalize into the same internal job payload (`{repo, issue_number, action, requested_by, source}`) via a trigger adapter, so the orchestrator only ever handles one shape of job regardless of where it came from. Concretely:

- GH label and `@mention` triggers fire natively via GitHub Actions (`on: issues: types: [labeled]` and `on: issue_comment`).
- Chat and curl/Postman triggers hit the orchestrator's own `POST /trigger` endpoint, which then calls GitHub's `repository_dispatch` API so the same GitHub Actions workflow runs regardless of origin.

**(Revised) `@mention` author check:** the workflow condition matches on comment *body* only. Even though `agent-ops` and its app repos are private with a single collaborator today, the `if:` condition should also check `github.event.comment.user.login` against an allowlist (currently just `heyitschloe`) before honoring `@dev-agent implement`. This is cheap defense-in-depth against the day access is ever widened, and costs nothing while it isn't.

### 4.2 Planning stage — real GitHub sub-issues, not text blocks

GitHub has a native sub-issues feature (REST + GraphQL): up to 100 sub-issues per parent, 8 levels of nesting, and sub-issues inherit the parent's project/milestone. The planning stage should:

1. Read the issue and the relevant project skill (see §6).
2. Draft an approach doc.
3. Create one real GitHub sub-issue per subtask via `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` (or the GraphQL `addSubIssue` mutation) — the subtask's content becomes that sub-issue's **description**, not a checklist line.
4. Use sub-sub-issues for further breakdown where useful (up to 8 levels deep).
5. Post "added notes" as **comments** on whichever issue/sub-issue/sub-sub-issue they relate to, rather than rewriting descriptions.
6. Label the parent issue `approach-ready` and stop — wait for human approval.

**(Revised) idempotency:** if planning fails partway (e.g. 3 of 5 sub-issues created, then an API error), the job must be safely re-runnable — check for existing sub-issues matching the plan before creating new ones, rather than creating duplicates on retry. This is a Phase 3/4 checkpoint now, not a Phase-10 afterthought (§9.1).

### 4.3 Implementation stage — Claude Code

Once the issue is labeled `approved`, **Claude Code** is the implementor:

- Runs headless (`claude -p`) via the official `anthropics/claude-code-action@v1` GitHub Action, authenticated against the LiteLLM gateway rather than the Anthropic API directly, so the model behind this step is swappable.
- Reads the approved approach doc and its sub-issues, implements the change, writes unit tests as part of the implementation, commits, and opens a PR.
- Adds the designated reviewer to the PR automatically — **(Revised)** the reviewer is a per-project field in `registry/development/projects.yaml` (§6), not fixed. Every project's entry currently sets `reviewer: heyitschloe`, but nothing structural limits it to one person; adding a second reviewer later is a registry edit, not a pipeline change.

**Billing note:** automated/headless Claude usage (Agent SDK, headless `claude -p`, GitHub Actions, third-party agents) is metered separately from interactive `claude.ai` chat or interactive terminal Claude Code usage. Check current terms at docs.claude.com before scaling usage, since this is a recent change and may evolve.

### 4.4 Quality gate — Qodo

Qodo sits *after* implementation, not as part of code generation:

- **Qodo Cover** generates additional unit tests targeting uncovered code paths, runs them, and keeps only tests that pass and measurably raise coverage toward a target (e.g. 85–90%). This runs as a GitHub Action (`qodo-ai/qodo-ci/.github/actions/qodo-cover@v0.1.12`).
- **Qodo Merge** (Qodo's Git integration) reviews the diff for bugs/security/standards issues and can cross-check the diff against the linked ticket's requirements, flagging partial implementations.
- **Scope and limits, honestly:**
  - Qodo does **not** generate tests purely from a pre-implementation spec — it analyzes actual code/diffs. To approximate "tests from the approach," have Claude Code write tests first (TDD-style) against the approach doc's acceptance criteria as part of implementation; Qodo's value-add is auditing what's there afterward.
  - **Unit tests:** Qodo's core strength.
  - **Integration tests:** Qodo can scaffold setup/teardown but the assertions usually need manual review.
  - **E2E tests:** out of Qodo's scope. Plan on Claude Code writing Playwright/Cypress specs directly as part of implementation; Qodo can confirm they exist and pass, but won't generate them.
- On failure, the gate sends the PR back to the implementation step rather than pinging you directly, to avoid notification noise on an unattended pipeline.
- **(Revised) self-hosted fallback decision point:** this build uses self-hosted `PR-Agent` + `qodo-cover` against the LiteLLM gateway instead of the hosted Qodo product (§8). Before relying on this in production, explicitly test self-hosted coverage/review quality against a few real diffs. If it doesn't reach usable parity with the hosted product within the Phase 4/5 test tickets, the fallback is reverting to hosted Qodo for the gate step only — decide this at the Phase 5 checkpoint, not silently mid-build.

### 4.5 GitHub Actions workflow — reusable, not per-repo copy-paste

**(Revised)** the original draft had a single `dev-pipeline.yml` living independently in each app repo, explicitly *not* shared — a direct exception to the "one integration per surface" principle in §2. That's fixed here: the actual pipeline logic lives once, centrally, as a **reusable workflow** in `agent-ops`; each app repo keeps only a thin caller.

**Central reusable workflow** — `agent-ops/.github/workflows/dev-pipeline-reusable.yml`:

> **Note:** the skeleton below is illustrative — treat the actual file in the repo as the source of truth, not this doc, since it's accumulated real fixes from live testing that aren't worth keeping byte-for-byte duplicated here (`id-token: write` permissions for `claude-code-action`'s OIDC request, and — significant — **a second checkout of `agent-ops` itself with its own App token**. Skills live once, centrally, in `agent-ops` per this doc's own principle, but the reusable workflow only checks out the *calling* repo by default. Since caller repos and `agent-ops` are often under different GitHub accounts, e.g. `11thandOrange/BusyBuddy_v2` vs. `HeyItsChloe/agent-ops`, reading skill files needs a second App token scoped specifically to `agent-ops`'s installation, checked out to a `.agent-ops/` subpath, with the prompt referencing that path rather than assuming skills exist in the caller's own tree. Confirmed as a real bug via a live `BusyBuddy_v2` test run before being fixed.)

```yaml
name: dev-pipeline-reusable

on:
  workflow_call:
    inputs:
      project_language: { required: true, type: string }
      test_command: { required: true, type: string }
      coverage_type: { required: true, type: string }
      desired_coverage: { required: true, type: number }
      skill_folder: { required: true, type: string }
      reviewer: { required: true, type: string }
      action: { required: true, type: string }   # "plan" | "implement"
    secrets:
      LITELLM_PROXY_URL: { required: true }
      LITELLM_VIRTUAL_KEY: { required: true }
      GH_APP_ID: { required: true }
      GH_APP_PRIVATE_KEY: { required: true }

jobs:
  plan:
    if: inputs.action == 'plan'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.GH_APP_ID }}
          private-key: ${{ secrets.GH_APP_PRIVATE_KEY }}
      - uses: anthropics/claude-code-action@v1
        env:
          ANTHROPIC_BASE_URL: ${{ secrets.LITELLM_PROXY_URL }}
          ANTHROPIC_API_KEY: ${{ secrets.LITELLM_VIRTUAL_KEY }}
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
        with:
          prompt: |
            Read this issue and ${{ inputs.skill_folder }}/SKILL.md. Produce an approach doc.
            Before creating sub-issues, check for existing sub-issues on this parent that already
            match the plan (idempotency: do not duplicate on a retried run).
            Create one GitHub sub-issue per subtask via the sub-issues API,
            with the subtask's content as that sub-issue's body.
            Then label this issue "approach-ready".
          claude_args: "--max-turns 12 --model planning"

  implement:
    if: inputs.action == 'implement'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.GH_APP_ID }}
          private-key: ${{ secrets.GH_APP_PRIVATE_KEY }}
      - uses: anthropics/claude-code-action@v1
        env:
          ANTHROPIC_BASE_URL: ${{ secrets.LITELLM_PROXY_URL }}
          ANTHROPIC_API_KEY: ${{ secrets.LITELLM_VIRTUAL_KEY }}
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
        with:
          prompt: |
            Implement the approved approach for this issue and its sub-issues.
            Write unit tests for the core logic as part of the implementation.
            Open a PR and request review from ${{ inputs.reviewer }}.
          claude_args: "--max-turns 30 --model implementation"

      - name: Qodo coverage gate
        uses: qodo-ai/qodo-ci/.github/actions/qodo-cover@v0.1.12
        with:
          github_token: ${{ steps.app-token.outputs.token }}
          branch: ${{ github.head_ref }}
          project_language: ${{ inputs.project_language }}
          project_root: .
          code_coverage_report_path: ./coverage/cobertura-coverage.xml
          coverage_type: ${{ inputs.coverage_type }}
          test_command: ${{ inputs.test_command }}
          desired_coverage: ${{ inputs.desired_coverage }}
          max_iterations: 3
```

**Per-app-repo caller** — e.g. `BusyBuddy_v2/.github/workflows/dev-pipeline.yml`:

```yaml
name: dev-pipeline

on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]
  repository_dispatch:
    types: [agent-trigger]

jobs:
  dispatch:
    uses: HeyItsChloe/agent-ops/.github/workflows/dev-pipeline-reusable.yml@main
    with:
      project_language: typescript
      test_command: "npm test -- --coverage"
      coverage_type: cobertura
      desired_coverage: 85
      skill_folder: skills/app-1
      reviewer: heyitschloe
      action: >-
        ${{
          (github.event.label.name == 'approach-ready' && 'plan') ||
          (github.event.label.name == 'approved' && 'implement') ||
          (contains(github.event.comment.body, '@dev-agent plan') && 'plan') ||
          (contains(github.event.comment.body, '@dev-agent implement') && 'implement') ||
          github.event.client_payload.action
        }}
    secrets: inherit
```

Every input the reusable workflow needs (`test_command`, `coverage_type`, `desired_coverage`, `project_language`, `skill_folder`, `reviewer`) is sourced from that repo's `registry/development/projects.yaml` entry (§6) when the caller is generated — see the scaffold skill in §6.1. This keeps one source of truth instead of the value living in both the registry and a repo-level GitHub Actions variable.

This is a working skeleton, not a copy-paste-and-done file — exact `claude_args` flags and Qodo's required inputs vary per repo/stack. Validate end to end on one repo before replicating.

---

## 5. Personal assistant pipeline

### 5.1 Chat front end — platform-agnostic via MCP

Discord is not required. Instead of a fixed chat app, the system exposes **one MCP (Model Context Protocol) server** wrapping the orchestrator's functions as tools. Any MCP-capable chat client can then connect to that same server — the chat platform becomes swappable without rebuilding the integration.

**(Revised) tool surface, collapsed by category, not by project:** the original draft listed a separate tool per personal-project type (`plan_trip`, `source_property`, etc.), which meant adding a new personal project required adding a new tool — breaking the "config entry, not new code" principle in §2. That's still true: one tool per project was never built. **(Re-revised)** what *did* change is that the single `run_project_pipeline` tool split into two — one per *category* (dev vs. personal), not per project — since dev and personal calls have structurally different shapes (dev: `repo`+`issueNumber`; personal: `project`+`request`) that were awkward to force into one flat schema. Adding a 4th app repo or a 4th personal project still never adds a tool; it's still a registry entry:

| Tool | Scope |
|---|---|
| `create_ticket` | Dev pipeline — file a new ticket on a registered app repo |
| `check_status` | Dev or personal — status of any registered job/ticket |
| `request_approval` | Dev pipeline — apply the `approved` label / equivalent |
| `run_development_project_pipeline(repo, issueNumber, action)` | Dev projects — dispatches a plan/implement run via GitHub Actions |
| `run_personal_project_pipeline(project, request, ...)` | Personal projects — executed directly by the orchestrator, no CI runner. Also accepts `strategy` (`scrapeOne`/`scrapeAll`/`scrapeAny`, §5.3), `criteria`, and `maxResults` |
| `scaffold_project(name, type, repo?)` | Onboard a new dev or personal project — see §6.1 |

Platform readiness for this, current as of mid-2026:

| Platform | MCP support for personal/consumer chat | Notes |
|---|---|---|
| **Claude** | Native, mature | Best choice for backend automation regardless; also works fine as a chat client. |
| **ChatGPT** | Strong — Developer Mode (Plus+) supports full read/write MCP connectors via Settings → Connectors; Apps SDK for published/distributable integrations | Best all-around daily-driver chat experience: broadest memory, most mature Actions/MCP ecosystem, solid voice mode. |
| **Gemini** | Strong in Gemini CLI / Antigravity / Gemini Enterprise; noticeably behind in the consumer mobile/web app | Best if workflow lives in Google Workspace (Gmail/Drive/Docs/Sheets); MCP via the everyday consumer chat app isn't yet as turnkey as ChatGPT's. |
| **Perplexity** | Local MCP available now (Mac app only); remote MCP still rolling out | Best for the research-heavy personal pipelines (property/asset/trip due diligence) once remote MCP lands; Zapier MCP integration covers 9,000+ apps as an interim bridge. |

**Decision: claude.ai is the chat front end for this build.** It has native, mature MCP support, so the MCP server connects directly as a Claude connector with no Developer Mode toggle or OpenAPI schema needed. The MCP-agnostic design still holds: ChatGPT or another client could be added as a second front end later by connecting to the same server, with no backend changes.

**What "chat" vs. "automation" means in practice:** the chat platform is the front door — wherever you type. Every actual action (creating tickets, running research, modifying GitHub state) is executed by the orchestrator and, for anything substantive, by **Claude** specifically — Claude Code for dev work, Claude API (via the gateway) for planning/analysis/PA tasks. Swapping the chat app never changes which engine does the work.

### 5.2 Notifications — chat only

**(Revised)** Bird (bird.com) was evaluated as a unified multi-channel notification API (SMS/email/WhatsApp/voice) in the original draft, marked "descoped for now." That's now a permanent decision, not a deferred one: it added a dependency and an integration surface with no current use case. **There is no separate notification channel in this system.** Every result — status updates, approach docs, PR links, PDFs — is delivered back through whichever MCP-connected chat client made the request. If a genuine need for out-of-band notification (e.g. SMS for time-sensitive approvals) shows up later, it gets evaluated fresh at that point rather than carried as unused scaffolding now.

### 5.3 Personal pipeline flow

Chat request (via `run_personal_project_pipeline`) or a Postman/curl `POST /trigger` with `kind: "personal"` (**New** — `/trigger` was dev-only through Phase 7, fixed alongside the tool split above) → orchestrator's trigger adapter → looks the project up in `registry/personal/projects.yaml` and calls `run_personal_pipeline.ts` directly (no GitHub Actions runner involved — personal projects have no repo) → the job loads the project's skill, **discovers candidate postings per the requested `strategy`** (**New** — see below), and for each candidate: gathers its content via the configured `sourcing_method`, calls the `planning` model alias via the gateway, renders/assembles the output package, and appends a row to `the-store` (§8) → result(s) delivered back in the same chat thread.

**(New) Discovery strategy — a second, separate axis from `sourcing_method`:** `sourcing_method` (above) answers "how do I fetch a *known* posting's content." `strategy` answers "how many postings, and how are they found":

- `scrapeOne` (default) — the request itself is a known posting/URL, no discovery step, one application produced.
- `scrapeAll` — the request is a job-site URL; `orchestrator/src/jobs/discovery/scrapeAll.ts` crawls its listings (rendering the page and asking the model to identify individual posting links, since fixed selectors can't generalize per site the way `sourcing/scraping.ts`'s LinkedIn-specific selectors do for one known site) and filters by `criteria`.
- `scrapeAny` — no URL given; `orchestrator/src/jobs/discovery/scrapeAny.ts` searches the open web via a configurable search API. **Confirmed scope: no site allowlist** — this is a broader, less-characterized version of the scraping ToS exposure below, not bounded to LinkedIn or any named list of sites.

Both `scrapeAll`/`scrapeAny` cap results at `max_results` (registry default 10, per-call override) — each result costs a full model call plus document renders, so this is a real cost/latency bound, not an arbitrary one. Candidates are filtered by `criteria` (title, location, remote, salary, skills, keywords, date posted, company, whitelist/blacklist) via `orchestrator/src/jobs/criteria.ts`, deliberately forgiving toward missing data rather than over-excluding on incomplete scraped/searched metadata.

**(Re-revised) LinkedIn ToS note (Phase 7):** "draft and queue, never auto-submit" removes the auto-apply risk, but doesn't by itself clear LinkedIn's Terms of Service — that depends on *how* job data is sourced. This was originally left as an open question to resolve before relying on the pipeline; it has since been resolved by decision, not by avoidance: sourcing is now a configurable, per-project `sourcing_method` (`scraping` | `api` | `manual`, §6), and `scraping` — direct, authenticated-session scraping of LinkedIn job pages — is the accepted default for the resume-job-applier project. That is a deliberate acceptance of the ToS exposure this note originally flagged, not a resolution of it; `api`/`manual` remain available as the ToS-safe alternatives if that trade-off ever needs to change for a given run. `scrapeAny`'s open-web scope (above) extends this same kind of acceptance to sites with no individual review at all.

**(New) Form prefill — job-application-form-prefill:** each output package includes `formFields` (a flat label→value map) alongside the narrative application summary, specifically for `orchestrator/scripts/job-application-form-prefill.mjs` — a local script the human runs themselves against their own saved session, which opens the link, fills the form, and stops. Confirmed as **fill-only, permanently** during planning: no code path in it clicks submit; an opt-in auto-submit mode is a separate, explicit future decision, not something to add quietly. This doesn't loosen the orchestrator's own "never touches a form" rule — the script runs locally, triggered by the human, not by the orchestrator's unattended pipeline.

---

## 6. Agents & skills repo, and multi-project scaling

One control repo (`agent-ops/`) holds the orchestrator, the model gateway config, and a skill folder per project — app or personal. Each project is a config entry, not a duplicated pipeline.

```
agent-ops/
├── .github/
│   └── workflows/
│       └── dev-pipeline-reusable.yml   # the one shared workflow_call target (§4.5)
├── litellm/
│   ├── config.yaml
│   └── docker-compose.yml
├── orchestrator/
│   ├── src/
│   │   ├── server.ts                  # POST /trigger, /webhook/github, /webhook/mcp — all authenticated
│   │   ├── auth.ts                    # shared-secret / token check on all inbound endpoints (Revised)
│   │   ├── logging.ts                 # structured logs + correlation ID per job run (Revised)
│   │   ├── triggers/
│   │   │   ├── github_label.ts
│   │   │   ├── github_mention.ts      # includes commenter allowlist check (Revised)
│   │   │   ├── chat_command.ts        # via the MCP server
│   │   │   └── http_api.ts            # Postman/curl entrypoint
│   │   ├── jobs/
│   │   │   ├── plan_ticket.ts             # subtasks + approach via GH sub-issues API, idempotent retries (Revised)
│   │   │   ├── implement_ticket.ts        # invokes Claude Code via gateway
│   │   │   ├── quality_gate.ts            # invokes Qodo
│   │   │   ├── open_pr.ts
│   │   │   ├── run_personal_pipeline.ts   # (New, §5.3/§6) executes personal projects directly — no repo/CI runner to dispatch to, so the orchestrator itself loads the skill, discovers postings, and calls the gateway per candidate
│   │   │   ├── criteria.ts                # (New, §5.3) JobCriteria matching for scrapeAll/scrapeAny candidates — deliberately forgiving toward missing data
│   │   │   ├── discovery/                 # (New, §5.3) how postings are found, separate from sourcing/ (how a known posting's content is fetched)
│   │   │   │   ├── scrapeAll.ts               # crawl one given site's listings, model-assisted candidate extraction (fixed selectors can't generalize per site)
│   │   │   │   └── scrapeAny.ts               # open-web search, no site allowlist (confirmed)
│   │   │   ├── sourcing/                  # (New) per-sourcing-method scripts, selected by a personal project's sourcing_method
│   │   │   │   ├── manual.ts
│   │   │   │   ├── api.ts
│   │   │   │   └── scraping.ts
│   │   │   └── scaffold_project.ts        # generates a new project's skill file + registry entry (Revised, §6.1)
│   │   ├── integrations/
│   │   │   ├── github.ts              # GitHub App JWT → installation token exchange (Revised); also getFileContents, reading skill files remotely since skills/ isn't in the orchestrator's own Docker build context (New)
│   │   │   ├── litellm.ts             # (New) direct gateway calls for the personal pipeline — the dev pipeline calls the gateway from inside GitHub Actions instead, this is the orchestrator-process equivalent
│   │   │   ├── pdf.ts                 # (New) renders drafted text to PDF for generated_pdf document sources
│   │   │   ├── the_store.ts           # (New, §8) appends completed job-application rows to a CSV in a separate repo ("the-store") — gated, skipped with a warning if unconfigured
│   │   │   ├── plane.ts
│   │   │   └── mcp_server.ts
│   │   ├── scripts/
│   │   │   └── job-application-form-prefill.mjs       # (New) local companion prefill script — NOT part of the deployed service; lives here (not under skills/) so Node's ESM resolver finds `playwright` via the normal node_modules walk-up
│   │   └── registry/
│   │       ├── load.ts                    # (New) local-fs registry loader — reads the yaml below, bundled into the deployed image at build time
│   │       ├── development/
│   │       │   └── projects.yaml          # (Revised) dev projects only — was one shared projects.yaml; split so the two schemas (dev vs personal, non-overlapping) can't cross-contaminate
│   │       └── personal/
│   │           └── projects.yaml          # (Revised) personal projects only
│   └── package.json
├── skills/
│   ├── shared/
│   │   └── dev/                         # (Revised) dev-only shared tier — was skills/shared/ directly; personal projects never read this folder, matched via applies_to within dev projects only
│   │       ├── approach-doc-format/SKILL.md      # applies_to: all
│   │       ├── approval-gate-protocol/SKILL.md   # applies_to: all
│   │       ├── project-scaffold/SKILL.md         # applies_to: all — generates new project skills, not a static template (Revised, §6.1)
│   │       ├── project-conventions/SKILL.md      # applies_to: all — was skills/app-1/SKILL.md; genuinely shared, not pinned to BusyBuddy_v2 alone
│   │       ├── fe-code-standards/SKILL.md        # applies_to: [node] — example
│   │       └── android-gradle-standards/SKILL.md # applies_to: [android] — example
│   └── personal/                        # (Revised) no shared tier of their own — each personal project's skill folder is fully self-contained, including its sourcing/ sub-skills
│       ├── resume-job-applier/
│       │   ├── SKILL.md
│       │   ├── sourcing/                # (New) one skill per configurable sourcing_method
│       │   │   ├── manual/SKILL.md
│       │   │   ├── api/SKILL.md
│       │   │   └── scraping/SKILL.md    # default — see SKILL.md for the accepted-ToS-risk note
│       │   └── job-application-form-prefill/SKILL.md    # (New) documents orchestrator/scripts/job-application-form-prefill.mjs — fill-only, permanently (confirmed)
│       ├── trip-planning/SKILL.md
│       ├── property-sourcing/SKILL.md
│       └── asset-purchase/SKILL.md
```

**(Revised)** `integrations/bird.ts` and `integrations/qodo.ts` are removed from this tree: Bird per §5.2, and Qodo is invoked as a GitHub Action step (§4.5) rather than an orchestrator-side integration, since it never needs to be called outside that workflow context.

**(Revised) Skills are two-tier for dev projects; personal projects have no shared tier at all:**

- **Shared tier, dev only (the default for everything, including a project's own conventions)** — every dev skill lives in `agent-ops/skills/shared/dev/` (Revised — was `skills/shared/` directly; moved so the boundary between dev-shared and personal content is structural, not just a code convention), tagged in frontmatter with `applies_to: all`, `applies_to: [<language>, ...]`, or `applies_to: [repo:<owner>/<name>]`. The reusable workflow matches this against the project's `project_language` list and/or its `repo` field and tells Claude Code to read whichever skills match — the workflow itself never names a specific skill or a specific repo. A project's own conventions skill (what used to be `skills/app-1/SKILL.md`) is an ordinary shared skill like any other: tagged `applies_to: all`, reaching every dev project, not narrowed to BusyBuddy_v2 alone. Nothing here requires cross-repo write access — everything stays in the one control repo.
- **Repo-local tier, dev only (available, not currently used by any project)** — for a skill so specific to a single repo that it makes more sense living inside that repo's own checkout than tagged `applies_to: [repo:...]` in agent-ops (e.g. a narrow build-system quirk only one Android repo would ever need). No current skill uses this; it remains an option for that case if it comes up.
- **Personal projects have no shared tier.** Each personal project's skill folder (`skills/personal/<name>/`) is fully self-contained — the personal-pipeline job (`run_personal_pipeline.ts`) only ever reads that one project's `SKILL.md` (and its `sourcing/<method>/SKILL.md`, §5.3), never anything under `skills/shared/dev/`. Content there (GitHub sub-issue format, PR approval gates, dev coding conventions) has no bearing on drafting a resume.

Registry entries are split into two files by type — `registry/development/projects.yaml` and `registry/personal/projects.yaml` (Revised: previously one shared `registry/projects.yaml`; the two schemas don't overlap, so a project can never accidentally carry the wrong type's fields). Adding a 4th app or a 4th personal project is a new entry in the matching file, not new pipeline code. There is no `skill_folder`/`skill_path` field for dev projects — which skills apply is resolved entirely by matching, not by a registry pointer. `project_language` is a list, so a polyglot repo can match more than one shared skill's `applies_to`:

```yaml
# registry/development/projects.yaml
- project: app-1
  type: dev
  repo: github.com/11thandOrange/BusyBuddy_v2
  model_profile: implementation     # alias from litellm/config.yaml
  test_gate: qodo
  project_language: [typescript]
  test_command: "npm test -- --coverage"
  coverage_type: cobertura
  desired_coverage: 85
  reviewer: heyitschloe
```

```yaml
# registry/personal/projects.yaml — personal projects keep an explicit
# skill_path pointer (they have no project_language/repo to match a shared
# skill against — and, per above, nothing to match against anyway). Each
# document source is independent; sourcing_method picks which sourcing
# skill+script gathers posting data (§5.3).
- project: resume-job-applier
  type: personal
  skill_path: skills/personal/resume-job-applier
  model_profile: planning
  resume_source:
    mode: generated_pdf
  cover_letter_source:
    mode: generated_pdf
  sourcing_method: scraping   # default — accepted ToS risk, see the skill file
```

### 6.1 Onboarding a new project — a skill, not a static template

**(Revised)** the original idea of a static `skills/_template/SKILL.md` file was dropped: an inert template that a human copies by hand is exactly the kind of asset that goes stale and doesn't get reused consistently. Instead, onboarding a new dev or personal project is itself a pipeline capability:

- `skills/shared/dev/project-scaffold/SKILL.md` defines what a valid project skill must contain (conventions, test commands, guardrails, PR/approach format) and how a new registry entry must be structured.
- `orchestrator/src/jobs/scaffold_project.ts`, exposed as the `scaffold_project(name, type, repo?)` MCP tool (§5.1), invokes Claude with that skill to generate the project's skill file, append the entry to `registry/development/projects.yaml` or `registry/personal/projects.yaml` (whichever matches `type`), and — for a `type: dev` project — generate the thin per-repo caller workflow shown in §4.5 with that project's values filled in. **(Revised)** for `type: dev`, the skill file is written into `agent-ops/skills/shared/dev/<descriptive-name>/SKILL.md` (shared dev tier, §6), tagged `applies_to` to match the new project — never into the target repo, and never named after the project's internal registry codename (e.g. not `skills/app-2/`). `type: personal` projects still get their skill file written under `skills/personal/<name>/SKILL.md`, unchanged — they have no `project_language`/`repo` to match against, and no shared tier to reach even if they did.

This turns what were Phase 8/9 manual steps ("write a new project skill folder," "add a registry entry," "copy the workflow file") into one reused, agent-driven action instead of three hand-done steps repeated per project.

---

## 7. Component summary — what does what

| Component | Role | Why this one |
|---|---|---|
| **LiteLLM** | Model gateway | Free, open source, makes every model choice a config change |
| **GitHub Actions** | Compute for dev pipeline runs | Native trigger source, free/cheap, no separate webhook infra for GH-side events; one reusable workflow shared across repos (Revised) |
| **GitHub App** | Cross-repo GitHub auth | **(Revised)** replaces a fine-grained PAT — permissions are set once on the App, and scaling to a new repo is an install, not a re-minted/re-scoped token |
| **Claude Code** | Implementor for dev tickets | Native repo/git awareness, headless execution, official GitHub Action |
| **Qodo** (self-hosted PR-Agent + qodo-cover) | Post-implementation quality gate | Strong unit test generation + coverage validation; complements rather than duplicates Claude Code — with a defined fallback to hosted Qodo if parity isn't reached (§4.4) |
| **Cursor** | Optional manual-intervention coding surface | Useful when a ticket needs a human to jump in mid-task; Claude Code remains the default headless executor |
| **MCP server (custom)** | Chat-platform-agnostic front door | One integration, many possible chat clients (Claude, ChatGPT, Gemini, Perplexity); one generic personal-project tool instead of one per project (Revised) |
| **ChatGPT** (or other MCP client) | Optional second chat interface | Swappable without backend changes if added later |
| **GitHub native sub-issues** | Subtask tracking | Real tracked hierarchy in the GitHub UI instead of text checklists |
| **agent-ops repo (skills + registry)** | Multi-project scaling | Each project is a config entry; pipeline logic is written once; onboarding itself is a skill, not a manual template copy (Revised) |

**(Revised)** Bird is removed from this table — see §5.2.

---

## 8. Confirmed configuration (decisions log)

- **Dev project #1:** `11thandOrange/BusyBuddy_v2`. Currently has a working but different pipeline — OpenHands-based, triggered by a single `ready-to-implement` label, no plan/approval gate, with its own agent roster (`ticket-planner`, `busybuddy-implementer`, `shopify-extension-implementer`, `tester`, `smoke-tester`, `pr-reviewer`) and shared agents in `HeyItsChloe/.agents` (`ticket-manager`, `ci-monitor`, `whatsapp-notifier` via callmebot/Twilio). **Decision: replace this entirely** with the GH Actions + Claude Code + LiteLLM + Qodo architecture in this doc, including the planning/approval gate and real GitHub sub-issues it currently lacks. The OpenHands automation registration, the `ready-to-implement` label trigger, and the callmebot WhatsApp notifier step should all be retired as part of this — don't run both pipelines on the same repo at once. **Executed:** the OpenHands workflow and its Postman collection were removed from BusyBuddy_v2 in BusyBuddy_v2#325, so the old pipeline no longer fires; only manual cleanup of the external OpenHands Cloud registration, the `ready-to-implement`/`ready-to-implement-legacy` labels, and the `OPENHANDS_API_KEY`/`OPENHANDS_HOST` secrets remains.
- **Agents & skills repo:** `HeyItsChloe/agent-ops` (currently empty) is the long-term home for all skills and orchestrator code. `HeyItsChloe/.agents` is the legacy location BusyBuddy_v2 currently points at — `agent-ops` will replace it once the rebuild lands; until then `.agents` stays as a reference for what the old pipeline did, not as an active dependency.
- **Reviewer for all dev pipeline PRs:** `@heyitschloe` for now, set per-project in `registry/development/projects.yaml` — **(Revised)** the field was always meant to support other reviewers later; nothing changes structurally when a second reviewer is added, it's a registry edit.
- **(Re-revised) Hosting — live:** moved from the originally-provisioned Oracle Cloud Free Tier instance to **Google Cloud Run**, GCP project `agent-ops-501120`, region `us-central1`. Switched because the Oracle Cloud path required manual VM/VNIC/public-IP/Caddy setup with real friction, whereas Cloud Run gives HTTPS + a public endpoint automatically from a container push.
  - LiteLLM gateway: `https://litellm-gateway-836703226343.us-central1.run.app` (Phase 1 — live).
  - Orchestrator (MCP server mounted at `/mcp`): `https://orchestrator-836703226343.us-central1.run.app` (Phase 2 — live).
  - **(New) Deploy mechanism:** the orchestrator deploys via a GitHub Actions workflow (`.github/workflows/deploy-orchestrator.yml`) driven entirely by GitHub Secrets, not by running `gcloud` from a chat session — deliberately, so credentials never need to pass through chat. LiteLLM's first deploy was done manually via `gcloud` before this pattern was established; consider giving it the same treatment later.
- **Model gateway:** Gemini is the only configured model for now (`planning` and `implementation` aliases both point at a Gemini model in `litellm/config.yaml`). Anthropic key to be added later — when it lands, repoint those aliases at Claude rather than standing up new ones, so nothing else in the system needs to change.
- **(Re-revised) Budget alert — live:** GCP's native Billing → Budgets & alerts (budget named "Agent-Ops", scoped to `agent-ops-501120`) rather than LiteLLM's own DB-backed alerting — set up before real pipeline traffic ran, per the original Phase 1 goal.
- **Quality gate:** self-hosted `PR-Agent` (`The-PR-Agent/pr-agent`) for review + self-hosted `qodo-cover` for test generation/coverage, both pointed at the LiteLLM gateway. Replaces the hosted Qodo product referenced earlier in this doc, with the fallback decision point in §4.4. **Not yet wired into the reusable workflow** — only `qodo-cover` is in `dev-pipeline-reusable.yml` today; the PR-Agent step is still an open Phase 4 task.
- **Personal project #1:** resume builder + job applier. Each of resume and cover letter is independently either freshly generated as a tailored **PDF** or pointed at an existing Google Drive doc (`resume_source`/`cover_letter_source`, registry/personal/projects.yaml). Targets **LinkedIn only for now**, with other job sites added later on request. The orchestrator's own pipeline never submits or fills a form on its own initiative; it prepares the documents, application content, and `formFields`. **(Revised)** sourcing is now configurable (`sourcing_method`: `scraping` | `api` | `manual`), defaulting to `scraping` — a deliberate, accepted deviation from the ToS caution originally noted in §5.3, not a resolution of it. See `skills/personal/resume-job-applier/sourcing/scraping/SKILL.md` for the explicit risk note. **(New)** discovery is a separate, second axis (`strategy`: `scrapeOne` | `scrapeAll` | `scrapeAny`, capped at `max_results` per run) — `scrapeAny` searches the open web with no site allowlist, confirmed and deliberate. **(New)** the human can locally prefill (never auto-submit) a posting's actual form via `orchestrator/scripts/job-application-form-prefill.mjs` when they open the link themselves.
- **(New) the-store:** completed job applications are appended as CSV rows to a separate repo, `the-store` (`projects/job-applications/job-app-results.csv`) — application *data*, kept out of `agent-ops`, which is pipeline *config*. **Blocked as of this note:** the repo doesn't exist yet, and this session's GitHub integration can't create repositories (`403 Resource not accessible by integration`) — a human needs to create `HeyItsChloe/the-store` (private) directly, then it can be added to a session's scope and the GitHub App installed on it. Until then, `THE_STORE_*` env vars are unset and `the_store.ts`'s append is skipped with a warning log rather than failing the pipeline.
- **(Revised) GitHub access — live:** a custom **GitHub App** (`pipeline-orchestrator-management`, not a PAT) with Issues/PRs/Contents permissions. Installed as **two separate installations**: one on the `heyitschloe` personal account, one on the `11thandOrange` organization (covering `BusyBuddy_v2`) — each has its own installation ID, since GitHub App installations are per-account/org, not global to the App. The App's ID and private key live in GitHub Secrets, not in chat or any file in this repo.
- **(Revised) Notifications:** chat only, permanently — Bird is not part of this system (§5.2).
- **(Revised) Orchestrator endpoint auth — verified:** `/trigger`, `/webhook/mcp`, and `/webhook/github` all require a shared-secret or token check from the moment they're stood up in Phase 2. Confirmed working post-deploy: unauthenticated requests to `/trigger` and `/webhook/mcp` return `401`; authenticated requests pass through to Zod validation. `/webhook/github` (GitHub's own HMAC signature, not the shared secret) still needs the GitHub App's Webhook URL pointed at the live orchestrator before it can be exercised for real.
- **(New) Chat-exposed credentials get rotated, not just noted.** During Phase 1/2 setup, the GitHub App webhook secret, the GCP service account key, the orchestrator's shared secret, and the Supabase database password (`DATABASE_URL`) all ended up pasted into a chat session at some point (needed at the time to get deployment working manually, before the GitHub-Secrets-driven deploy workflow was in place — the DB password specifically was re-shared a second time when `deploy-litellm.yml` needed it as a GitHub Secret). Decision: any credential that touches a chat transcript during setup is treated as compromised by default and rotated once the pipeline is stable, regardless of whether anything has actually gone wrong — see the Phase 10 checklist item.

## 9. Open items to validate before relying on this in production

- Confirm current Claude automation billing terms (the split between interactive chat/Code usage and headless/Agent SDK usage) at docs.claude.com before estimating monthly automation cost.
- Validate Qodo's exact GitHub Action inputs and coverage report format against your specific stack per repo — the sample YAML is a starting skeleton. If self-hosted PR-Agent/qodo-cover don't reach usable parity with hosted Qodo by the Phase 5 checkpoint, fall back to hosted Qodo for the gate step (§4.4).
- Track Gemini consumer-app and Perplexity remote-MCP rollout if you want either as a chat front end beyond Claude/ChatGPT.
- Re-test the plan → approve → implement → gate → PR loop end to end on one app repo before replicating the registry pattern to additional apps or personal projects.
- **(Revised, moved up from a later phase)** confirm what happens on partial failure at each stage (e.g. Claude Code opens a PR but the coverage gate errors, or planning creates some but not all sub-issues) — this must be a Phase 3/4 checkpoint, not discovered later, since idempotent retries depend on it (§4.2, §9.1).
- **(New)** revisit the single-reviewer setup if/when a second app repo's PR volume makes `@heyitschloe` a bottleneck — no pipeline change needed, just a registry edit (§8).

### 9.1 Reliability and observability, built in from Phase 2–3 (not Phase 10)

**(Revised)** these were originally listed only in a final hardening phase; moved earlier because the risk window (endpoints live and unauthenticated, no logs, no idempotency) otherwise spans most of the build:

- Real authentication on `/trigger` and `/webhook/mcp` from Phase 2 onward.
- A correlation/job ID attached to every trigger → orchestrator → GitHub Action → Claude Code → Qodo run, with basic structured logging, so a stuck pipeline is debuggable without re-reading code.
- Idempotent planning/implementation jobs, tested deliberately (not just the happy path) at the Phase 3/4 checkpoint.
- A monthly budget alert on model spend, live from the end of Phase 1.

What's left for a true end-of-build hardening pass:
- Re-check current Claude automation billing terms, Gemini/Perplexity consumer MCP support, and the self-hosted PR-Agent/qodo-cover setup against your stack — all are moving targets.
- Back up `agent-ops` (skills, registry, orchestrator code) somewhere beyond GitHub's own availability — this repo is now infrastructure, not just code.
