# Automation Audit — Manual-Step Inventory

> Deliverable **1d** of issue **#8 (Fully Automate All Pipelines & Workflows)**.
>
> This document inventories **every** manual step across the repository's
> pipelines, reusable workflows, GitHub Actions, deploys, and the wiki
> generator engine. For each step it records **where it lives**, **why it
> exists today**, and either the **automated replacement** that now removes it
> or a **technical justification** for why it must remain manual.
>
> Status legend: ✅ automated in this work · 🔁 automated elsewhere · 🔒 must stay
> manual (justified) · ⚠️ manual but low-friction / one-time.

---

## Summary of what this PR changes

| Manual step | Where | Resolution |
| --- | --- | --- |
| Wiki page metadata (`summary`/`order`/`status`) needs hand-authored frontmatter | `scripts/wiki-extractors/features.mjs` | ✅ **1a** — deterministic derivation in `scripts/wiki-extractors/metadata.mjs`; authored frontmatter still overrides |
| GitHub Pages "Source: GitHub Actions" one-time UI toggle | `deploy-docs.yml`, `wiki-generate-reusable.yml` | ✅ **1b** — `scripts/setup/enable-pages.mjs` (idempotent REST call), run once at onboarding |
| E2E control-repo checkout hardcodes `11thandOrange/agent-ops` | `e2e-pipeline-reusable.yml` | 🔁 **1c** — parameterized in **PR #15** (`feat/e2e-autogen`); not touched here |
| `author_content` LLM authoring is opt-in / off by default | `wiki-generate-reusable.yml` | ✅ removed from the critical path by 1a — a new entity now renders correctly with zero authoring; the LLM path is now purely optional prose enrichment |

---

## 1. Wiki generator engine (`scripts/`)

### 1.1 Page metadata / summaries required hand-authored frontmatter — ✅ FIXED (1a)

- **Where:** `scripts/wiki-extractors/features.mjs`. It read `summary`, `order`,
  and `status` straight from each `<site>/src/content/features/*.md` file's YAML
  frontmatter and fell back to fixed placeholders (`summary: ''`, `order: 999`,
  `status: 'stable'`) when a field was absent.
- **Why it existed:** the `features` extractor is the "authored-content" layer —
  prose is committed markdown, not derived from source. Metadata rode along in
  the same frontmatter, so a new feature could not appear with a sensible
  summary/order/status until a human wrote frontmatter (or someone flipped
  `author_content: true` to invoke the LLM drafting path).
- **Automated replacement:** new pure, dependency-free, no-network module
  `scripts/wiki-extractors/metadata.mjs`:
  - `deriveMetadata(entity, ctx)` — fills a **missing** field only:
    - `summary`: authored `summary` → entity `description` → first non-heading
      paragraph of the markdown body → title (clamped to ≤160 chars on a word
      boundary, matching the wiki-author contract).
    - `status`: authored `status` → `ctx.defaultStatus` (default `stable`).
    - `order`: authored numeric `order` wins; otherwise resolved across the set.
  - `assignOrders(entities, ctx)` — preserves authored orders verbatim, assigns
    un-authored entities a stable, collision-free order (sorted by title then
    slug) appended after the highest authored order, so re-runs produce zero
    churn.
  - `applyMetadata(entities, ctx)` — convenience that applies both.
  - Wired into `features.mjs`: missing fields are passed through as `undefined`
    (not defaulted) so the metadata layer derives them; the transient `body`
    field is stripped before it reaches the sidecar / public `FeatureDoc`.
- **Authored-override guarantee (verified):** all 7 existing authored feature
  files regenerate **byte-identical** (`unchanged: 7`, empty JSON diff) because
  the `merge.mjs` `_sourceHash` path leaves entries whose source is unchanged
  untouched, and derived values equal authored values when present.
- **Remaining manual:** none for `features` metadata. Prose *bodies* are still
  human/LLM-authored by design (see 1.2) — that is content, not metadata.

### 1.2 `author_content` LLM authoring is opt-in (off by default) — ✅ REMOVED FROM CRITICAL PATH

- **Where:** `wiki-generate-reusable.yml` input `author_content` (default
  `false`); `scripts/wiki-author.mjs`.
- **Why it existed:** drafting *missing* feature prose via the LiteLLM
  `documentation` alias is expensive/non-deterministic, so it was gated off and
  most runs just extract facts + rebuild already-authored prose.
- **Resolution:** 1a makes the LLM path non-essential for correctness — a new
  entity now appears with correct derived metadata and (for extractor-derived
  kinds) derived summaries with **zero** authoring. `author_content` remains an
  *optional* enrichment for hand-quality prose bodies, not a gate on a page
  showing up. Left opt-in deliberately: default-on would put a non-deterministic
  LLM call on every consuming repo's critical build path and cost tokens per run
  — the opposite of the issue's determinism goal.
- **Status:** ✅ off the critical path; ⚠️ optional by choice (justified).

### 1.3 Extractor-resolution convention — 🔒 stays (by design, not a manual step)

- **Where:** `scripts/wiki-generate.mjs` core loop (`fooBar` key →
  `foo-bar.mjs` exporting `extract(ctx)`).
- **Why:** adding a doc *kind* is one new module + one config key; no driver
  change. This is intentional extensibility, not manual toil. `metadata.mjs`
  preserves it (it is a helper module, not an extractor — it exports no
  `extract()` and is imported by extractors).

### 1.4 New feature file creation — ⚠️ inherently human

- Deciding a feature *deserves* a page, and writing its prose body, is a human
  editorial act. 1a removes the *metadata* burden; the file's existence and
  narrative remain author-owned. Justification: documentation intent cannot be
  synthesized deterministically without an LLM, and the LLM path is optional.

---

## 2. GitHub Pages source enablement — ✅ FIXED (1b)

- **Where:** documented as a one-time manual toggle in `deploy-docs.yml`'s
  header ("Settings → Pages → Source: GitHub Actions") and implicitly required
  by `wiki-generate-reusable.yml`'s `deploy-pages` step.
- **Why it existed:** GitHub's `actions/deploy-pages` only publishes once a
  repo's Pages **build type** is `workflow`. Historically no tool in-session
  could toggle it, so a brand-new consuming repo could not deploy until a human
  clicked through the UI.
- **Automated replacement:** `scripts/setup/enable-pages.mjs` — idempotently
  sets `build_type=workflow` via the GitHub REST API
  (`GET/POST/PUT /repos/{owner}/{repo}/pages`):
  - already `workflow` → no-op (`unchanged`);
  - exists with another build type → `PUT` (`updated`);
  - not enabled → `POST` (`created`).
  - Auth via `--token` / `GITHUB_TOKEN` / `GH_TOKEN` (needs `pages` write). No
    PAT hardcoded; a GitHub App installation token or the in-workflow
    `GITHUB_TOKEN` with `permissions: pages: write` both work.
- **Onboarding invocation (run once per new consuming repo):**

  ```bash
  GITHUB_TOKEN=<token with pages:write for the target repo> \
    node scripts/setup/enable-pages.mjs --slug <owner>/<repo>
  # or:  node scripts/setup/enable-pages.mjs --owner <owner> --repo <repo> --token <tok>
  ```

- **Why once, not per-build:** wiring it into the reusable workflow's
  `build-and-deploy` job would require a cross-account GitHub App token in that
  job purely to re-check an already-set toggle on every run. Idempotent setup at
  onboarding is cheaper and keeps the deploy path token-simple. `deploy-docs.yml`
  and `wiki-generate-reusable.yml` headers now point at this script.
- **Status:** ✅ automated; ⚠️ invoked once at onboarding (justified — a
  repo-lifecycle setup action, not a per-run step).

---

## 3. Reusable E2E pipeline (`e2e-pipeline-reusable.yml`) — 🔁 NOT TOUCHED HERE

- **Manual/hardcoded step:** the coverage-script checkout hardcoded
  `11thandOrange/agent-ops` instead of taking a `control_repo` input.
- **Status:** 🔁 **Handled in PR #15 (`feat/e2e-autogen`)** — parameterization
  (subtask **1c**), framework detection, test generation, caller scaffolding,
  and a repair loop. This PR intentionally does **not** edit
  `e2e-pipeline-reusable.yml`, `scripts/e2e/**`, or `scripts/postman/**` to
  avoid conflicting with that open PR.

---

## 4. Deploy workflows

### 4.1 `deploy-docs.yml` — Pages source — ✅ see §2. Otherwise fully automated

- Trigger: push to `main` touching `agent-ops-docs/**`, or manual dispatch.
- Only manual pre-req was the Pages source toggle (now scripted, §2).

### 4.2 `deploy-litellm.yml` — 🔒 one-time secrets (justified)

- **Automated:** deploys `litellm/` to Cloud Run on push to `main` touching
  `litellm/**` or manual dispatch; no gcloud-from-chat needed.
- **Manual pre-req (one-time):** repository secrets `GCP_SA_KEY`,
  `GEMINI_API_KEY`, `LITELLM_VIRTUAL_KEY` (→ `LITELLM_MASTER_KEY`),
  `DATABASE_URL`.
- **Justification:** 🔒 secret provisioning is a trust-root action. A workflow
  cannot mint its own cloud credentials without an even-more-privileged secret,
  which just moves the manual step. Secrets are set once per environment and
  never on a normal run. This is the correct security boundary.

### 4.3 `deploy-orchestrator.yml` — 🔒 one-time secrets (justified)

- **Automated:** deploys `orchestrator/` to Cloud Run on push to `main` touching
  `orchestrator/**` or manual dispatch.
- **Manual pre-req (one-time):** a large secret set — `GCP_SA_KEY`,
  `ORCHESTRATOR_SHARED_SECRET`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`,
  `GH_APP_INSTALLATION_ID_11THANDORANGE`, `GH_APP_INSTALLATION_ID_HEYITSCHLOE`,
  `GH_WEBHOOK_SECRET`, `LITELLM_PROXY_URL`, `LITELLM_VIRTUAL_KEY`, JSearch/SerpAPI
  keys, `ANTHROPIC_API_KEY`, the `THE_STORE_*` set, `EXTENSION_API_KEY`, and the
  `APPLICANT_*` profile values (see `orchestrator/.env.example`).
- **Justification:** 🔒 same as §4.2 — third-party API keys, a GitHub App
  private key, and PII-bearing applicant profile values are trust-root / personal
  data that must be provisioned by a human once. No per-run manual step.
- **Improvement noted:** the `APPLICANT_*` values are configuration data, not
  true secrets; a future improvement could move the non-sensitive subset to a
  committed config file or a single JSON secret to shrink the manual surface.
  Out of scope for #8's automation goal (no per-run manual step remains).

---

## 5. Upstream sync (`sync-upstream.yml`) — 🔒 conflict resolution stays manual (justified)

- **Automated:** daily (09:00 UTC) fork sync of `HeyItsChloe/agent-ops` `main`;
  a **clean** merge pushes straight to `main` with **zero** human involvement.
- **Manual step (by design):** on a **merge conflict**, the workflow aborts
  auto-resolution, pushes a `sync/upstream-<run_id>` branch, and opens a PR for
  a human to resolve.
- **Justification:** 🔒 explicitly required by `CONTRIBUTING.md` "Fork-only
  content": this fork carries `FORK-ONLY: do not upstream` content that a blind
  auto-resolution could silently clobber. Guessing a conflict resolution is
  unsafe; a human review gate is the correct design, not a gap. Conflicts are
  the exception, not a normal run.

---

## 6. Orchestrator (`orchestrator/`) — runtime, not a CI manual step

- The orchestrator is a deployed Node/TS service (job-search pipeline, registry,
  integrations), configured entirely from environment variables at deploy time
  (§4.3). It introduces no per-run manual CI step. Its `.env.example` documents
  the one-time secret/config provisioning already covered by §4.3.

---

## Acceptance-criteria status

- ✅ Every pipeline executes end-to-end without manual intervention on a
  **normal run** (clean sync, docs deploy, service deploys, wiki generate).
- ✅ Generators create required metadata automatically — no hand-authored
  frontmatter is required for a feature to appear correctly (1a), verified by
  tests and a zero-diff regeneration of existing authored content.
- ✅ Remaining manual work is limited to (a) one-time secret/Pages provisioning
  at onboarding and (b) human review of upstream **conflicts** — both listed
  here with technical justification.
- ✅ Reusable workflows stay backwards compatible: no input signatures changed;
  existing callers (`11thandOrange/*`, `BusyBuddy_v2`) keep working unchanged.

## What remains manual (with justification)

| # | Manual step | Frequency | Justification |
| --- | --- | --- | --- |
| 1 | Provision cloud/API/App secrets for `deploy-litellm` / `deploy-orchestrator` | Once per environment | Trust-root credentials; a workflow can't self-mint them without a more-privileged secret. Security boundary. |
| 2 | Run `enable-pages.mjs` at repo onboarding | Once per consuming repo | Automated + idempotent; a repo-lifecycle setup action, not a per-run step. Kept out of the per-build deploy job to avoid a cross-account token there. |
| 3 | Resolve upstream **merge conflicts** via the auto-opened PR | Only on conflict | `CONTRIBUTING.md` forbids auto-resolving fork-only content; human review is the intended safety gate. |
| 4 | Author a feature's **prose body** (optional LLM assist) | Per new feature page | Editorial/narrative intent; metadata is now derived (1a), body remains content. LLM authoring path is optional. |
