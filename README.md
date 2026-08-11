# agent-ops

The control plane for a small fleet of AI-driven pipelines. One repository holds
the **pipeline orchestrator**, a **model gateway**, a **shared wiki/docs
generator**, **reusable CI**, and the **shared skills** those pipelines run
with. Two long-running services (the orchestrator and the gateway) are deployed
to Google Cloud Run; everything else is CI and generated content.

> **Heads-up on cost/uptime:** both services run on GCP project
> `agent-ops-501120`. Deploys use `gcloud run deploy --source`, which needs a
> **billing account linked** to the project even though scale-to-zero keeps the
> actual bill near-zero. The LiteLLM gateway also needs its external **Supabase**
> Postgres to be awake. If requests start failing, check billing → quota →
> Supabase before the code.

---

## What's in here

| Path | What it is |
| --- | --- |
| `orchestrator/` | Express service on Cloud Run. Hosts the pipeline engine + this repo's private job-search pipeline + the Chrome-extension HTTP routes. |
| `litellm/` | LiteLLM model gateway (config + Dockerfile) on Cloud Run. Every component calls a model **alias**, never a provider SDK. |
| `agent-ops-docs/` | The generated documentation site (Vite/React), published to GitHub Pages. |
| `skills/` | Shared, versioned skills (`SKILL.md` files) the pipelines resolve at runtime. |
| `orchestrator/src/registry/pipelines.yaml` | The **registry** — one entry per pipeline (source of truth for its handler, triggers, and params). |
| `scripts/` | The wiki generator (`wiki-generate.mjs`), its extractors (`wiki-extractors/*`), and the optional authoring step (`wiki-author.mjs`). |
| `templates/` | Templates copied **into other repos** — the wiki site scaffold and the thin `wiki-caller.yml` those repos use to call our reusable generator. |
| `wiki-content/` | Authored inputs to the generator (e.g. `changelog.yaml`). |
| `wiki.config.yaml` | Per-repo manifest telling the generator which extractors to run for **this** repo. |
| `roadmap/` | Long-form strategy/roadmap markdown (ingested into the docs). |
| `.github/workflows/` | Deploy workflows + reusable pipeline workflows (see below). |

---

## The pipelines

A **pipeline** is one entry in `orchestrator/src/registry/pipelines.yaml`.
Adding a pipeline is a new registry entry, not new engine code.

- **dev-ticket pipeline** (`busybuddy-dev`, `ordermate-dev`) — `execution.kind:
  github-actions`. Triggered by issue labels / `@dev-agent` mentions on the
  target repo; dispatches `dev-pipeline-reusable.yml` in that repo to plan or
  implement a ticket. Runs the model inside a GitHub Actions job.
- **job-search pipeline** (`resume-job-applier`) — `execution.kind: in-process`.
  This repo's private personal pipeline. It sources postings, drafts a tailored
  resume + cover letter as PDFs, builds a form-field map, and stops — it never
  submits an application. Because there is no repo/CI runner to dispatch to, the
  orchestrator process itself loads the skill and calls the gateway. It also
  exposes the Chrome-extension HTTP routes (`/personal-projects/:project/…`).

## The model gateway

`litellm/config.yaml` defines **aliases** (`planning`, `implementation`,
`classification`, `documentation`, `implementation-fallback`). Components address
an alias; repointing an alias at a different model is a one-line edit here and
nothing downstream changes. The gateway requires a Postgres DB (Supabase) for
virtual-key auth.

## Deployment

| Workflow | Deploys | Trigger |
| --- | --- | --- |
| `.github/workflows/deploy-orchestrator.yml` | `orchestrator/` → Cloud Run `orchestrator` | push to `main` touching `orchestrator/**`, or manual |
| `.github/workflows/deploy-litellm.yml` | `litellm/` → Cloud Run `litellm-gateway` | push to `main` touching `litellm/**`, or manual |
| `.github/workflows/deploy-docs.yml` | `agent-ops-docs/` → GitHub Pages | push to `main` touching `agent-ops-docs/**`, or manual |
| `.github/workflows/wiki-generate-reusable.yml` | *(reusable)* runs the generator, commits regenerated data, builds + deploys the site | `workflow_call` only |
| `.github/workflows/wiki-generate.yml` | self-caller that invokes the reusable for **this** repo | push to `main` touching a doc source, or manual |
| `.github/workflows/wiki-author.yml` | on-demand run of the optional AI authoring step (drafts missing feature pages) | manual (`workflow_dispatch`) only |
| `.github/workflows/e2e-pipeline-reusable.yml` | *(reusable)* e2e test runner for app repos | `workflow_call` only |
| `.github/workflows/sync-upstream.yml` | opens a PR syncing this fork with upstream | daily cron, or manual |

> **Caller permissions (gotcha):** a workflow that calls
> `wiki-generate-reusable.yml` must grant its job `permissions: { contents:
> write, pages: write, id-token: write }` — a reusable workflow can never hold
> more than the calling job does, so omitting this makes the run fail at
> **startup with 0 jobs** (not a build error). `wiki-generate.yml` and
> `templates/wiki-caller.yml` both declare this block; copy it into any new
> caller.

Config/secrets the services need are held as **GitHub Secrets** and forwarded by
the deploy workflows (never committed). Orchestrator requires: `GH_APP_ID`,
`GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID`,
`GH_APP_INSTALLATION_ID_PERSONAL`, `GH_WEBHOOK_SECRET`, `ORCHESTRATOR_SHARED_SECRET`,
`LITELLM_PROXY_URL`, `LITELLM_VIRTUAL_KEY`; plus optional, feature-gated
`SERPAPI_API_KEY`, `JSEARCH_API_KEY`/`JSEARCH_BASE_URL`, `ANTHROPIC_API_KEY`,
`THE_STORE_*`, `EXTENSION_API_KEY`, `APPLICANT_*`, `SITE_SESSIONS_DIR`. Gateway
requires: `GEMINI_API_KEY`, `LITELLM_MASTER_KEY` (the virtual key), `DATABASE_URL`.

---

## The documentation system (wiki generator)

The docs site is **not** hand-maintained page by page. It is produced by a
generator that reads this repo, so the docs stay close to the source. There are
exactly two kinds of content in it, and the distinction matters:

### Authored vs Extracted

- **Extracted** = *machine-derived from repo source, deterministically.* An
  extractor reads real files (workflow YAML, `package.json`, `SKILL.md`, …) and
  emits structured facts **verbatim** — versions, names, descriptions, and
  comments are copied, never reworded. Re-running the generator on unchanged
  source produces zero diff. You do not edit extracted output by hand as a
  matter of course (though the merge model below makes it safe if you do).
- **Authored** = *written by a human or an agent and committed as prose.* The
  narrative pages (`agent-ops-docs/src/content/features/*.md`), the
  `integrations:` list in `wiki.config.yaml`, and `wiki-content/changelog.yaml`
  are authored. The generator only *indexes/renders* them — it never invents or
  rewrites this text. Authored content is the only place subjective prose
  ("why", "how it works", tradeoffs) lives.

> In short: **facts are extracted; prose is authored.** Every feature page is a
> mix — extracted `implements` links and machine facts around authored
> explanation.

### How generation works

`scripts/wiki-generate.mjs` (run by `wiki-generate-reusable.yml`, or manually):

1. Reads a repo's `wiki.config.yaml`. The `extractors:` block is the manifest of
   what runs for that repo.
2. For each enabled key, it resolves a module by convention
   (`fooBar` → `scripts/wiki-extractors/foo-bar.mjs`) and calls its
   `extract(ctx)`. Adding an extractor kind = one module + one config key; the
   driver never changes.
3. Each extractor globs/reads its sources, stamps every entry with a
   `_sourceHash` (SHA-1 of the exact source text), merges into a
   `<name>.generated.json` sidecar, and writes a thin typed `<name>.ts` wrapper.
4. It then derives `navigation.ts` from which extractors are enabled and writes
   `wiki.config.generated.ts` (literal theme/site values — never model-generated).
5. The reusable workflow commits changed generated files back to the default
   branch, builds the Vite site, and deploys it to GitHub Pages.

**Merge model (`scripts/wiki-extractors/merge.mjs`)** — additive and idempotent:
entries are keyed by `slug`; a new key is appended, an existing key is replaced
**only if its `_sourceHash` changed**, and an entry whose source has disappeared
is **kept** (never deleted). Because change-detection keys on source hash, the
`.generated.json` sidecars are safe to hand-edit between runs.

### Extractor catalog

Every extractor lives in `scripts/wiki-extractors/`. A given repo enables the
subset that fits it via `wiki.config.yaml`. This repo (the control plane) enables
the first group; the second group exists for **app repos** (e.g. BusyBuddy_v2)
that have an application surface agent-ops doesn't.

**Enabled for agent-ops:**

| Extractor | Reads | Emits (key fields) → page | Authored or Extracted |
| --- | --- | --- | --- |
| `features` | Authored `.md` frontmatter in `src/content/features/` | `slug, title, summary, order, status, implements{…}, runWith, tradeoffs, notes` (body rendered as-is) → **Features** | **Authored** (extractor only indexes) |
| `workflows` | `.github/workflows/*.yml` | `slug, title, file, trigger, description (first #-comment block), jobs[…]` → **CI/CD** | Extracted |
| `skills` | `SKILL.md` under `roots` | `slug, title, description (verbatim), appliesTo, category, path` → **Skills** | Extracted |
| `dependencies` | listed `package.json` manifests | `name, version (verbatim), kind, component, packageFile` → **Dependencies** | Extracted |
| `integrations` | `integrations:` list in `wiki.config.yaml` | `slug, name, kind, summary, auth, url, notes` → **Dependencies & Integrations** | **Authored** (in config) |
| `automation` (pipelines) | `orchestrator/src/registry/pipelines.yaml` (`showAll` → every entry) | `name, handler, executionKind, workflow, triggers, params` → **Automation** | Extracted |
| `endpointsExpress` (`appFiles` mode) | `app.<method>()` routes in `orchestrator/src/index.ts` | endpoint groups (`method, path, auth, params`) → **API Reference** | Extracted |
| `models` | `litellm/config.yaml` `model_list` | `alias, model, apiKeyEnv, apiBase, fallbacks` → **Model Gateway** | Extracted |
| `env` | `orchestrator/.env.example` (required-ness from `requireEnv()` in `index.ts`) | `name, required, description, component, defaultValue` → **Configuration** | Extracted |
| `markdown` | Globbed `.md` (`roadmap/*`, `CONTRIBUTING.md`, `orchestrator/README.md`), copied byte-for-byte | `slug, title (H1), sourcePath, contentFile, navSection` | Extracted (verbatim copy) |
| `changelog` | `wiki-content/changelog.yaml` | `date, added[], changed[], fixed[]` → **Changelog** | **Authored** |

**Disabled here, available to app repos** (no applicable source in this repo):

| Extractor | Purpose |
| --- | --- |
| `endpointsKotlin` | API Reference from Kotlin `@GET/@POST` controllers. |
| `tests` | Test-suite / coverage section. |
| `appList` | List-of-apps section. |

### Optional authoring step (`scripts/wiki-author.mjs`)

The generator only *extracts facts*; it never writes prose. `wiki-author.mjs` is
the **optional** automation path for drafting a **missing** feature page: for
each entry in an authoring manifest (`wiki-content/authoring.yaml`) whose
`.md` does not yet exist, it asks the model behind the LiteLLM `documentation`
alias to draft the file in the exact frontmatter format the `features` extractor
parses. It is deliberately conservative — it **no-ops** without
`LITELLM_PROXY_URL`/`LITELLM_VIRTUAL_KEY`, no-ops without a manifest, and
**never overwrites** an existing authored file. It runs only when a caller passes
`author_content: true` (the `wiki-author.yml` workflow does). A manifest is
committed at `wiki-content/authoring.yaml`, so drafting a **new** feature page is
just: add a manifest entry, run `wiki-author.yml`. It is **not** the normal way
features are made — existing pages are hand/agent-authored and committed, and are
never overwritten. Its one remaining runtime prerequisite is a reachable gateway
`documentation` alias.

---

## What's extracted vs. still authored

The registry, the orchestrator's HTTP routes, the gateway aliases, and the
config/env reference are all **extracted** now (the `automation`,
`endpointsExpress`, `models`, and `env` extractors above) — a change to
`pipelines.yaml`, `index.ts`, `litellm/config.yaml`, or `.env.example` flows into
the docs on the next generator run, no hand-editing.

What is still **authored** (by design — facts are extracted, prose is not):

- Feature **narrative** and frontmatter (`summary`, `tradeoffs`, `notes`, the
  `implements` links) in `src/content/features/*.md`.
- The `integrations:` list in `wiki.config.yaml` and `wiki-content/changelog.yaml`.

Known extraction boundary: `endpointsExpress` here reads only the routes mounted
in `orchestrator/src/index.ts`; routes defined inside the external
`@heyitschloe/pipeline-orchestrator` engine package aren't visible to extraction.
