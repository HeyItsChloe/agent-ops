# templates/

Copy-me starting points for repos that consume agent-ops's reusable workflows
and wiki generator. Nothing here is pushed into consuming repos automatically —
each file is meant to be copied by hand into the target repo and adjusted.

Contents:

- **`wiki-caller.yml`** — thin caller for `wiki-generate-reusable.yml`.
- **`e2e-pipeline-caller.yml`** — thin caller for `e2e-pipeline-reusable.yml`.
- **`wiki-site/`** — the React/TS/Tailwind/Vite docs-site template a repo's
  `docs/` is bootstrapped from (includes `wiki.config.example.yaml`).
- **`wiki-backend/`** — the Node/Express proxy that powers the site's Sandbox
  ("Try it") panel.

Related: [`../README.md`](../README.md) ·
[`../.github/workflows/README.md`](../.github/workflows/README.md) ·
[`../scripts/README.md`](../scripts/README.md)

---

## `wiki-caller.yml`

Drop into `<consuming-repo>/.github/workflows/wiki-generate.yml`, alongside a
`<consuming-repo>/wiki.config.yaml` (start from
[`wiki-site/wiki.config.example.yaml`](wiki-site/wiki.config.example.yaml)).

- Calls `HeyItsChloe/agent-ops/.github/workflows/wiki-generate-reusable.yml@main`.
- Passes `site_dir` (default `docs`) and `config_path` (default
  `wiki.config.yaml`); `secrets: inherit`.
- Requires `GH_APP_ID` / `GH_APP_PRIVATE_KEY` to exist as repo/org secrets in
  the target repo.
- Runs on push to `main` + manual dispatch.

Adjust `site_dir` / `config_path` if the repo's docs site isn't at the defaults.

## `e2e-pipeline-caller.yml`

Drop into `<consuming-repo>/.github/workflows/e2e-pipeline.yml`. Ships **two
worked examples** — copy whichever matches the stack and delete the other:

- **Playwright** (e.g. BusyBuddy_v2): `needs_emulator: false`, an
  `install_command`, and a `test_command`.
- **Android/Espresso** (e.g. OrderMate): `needs_emulator: true`,
  `emulator_api_level`, and a Gradle `test_command`.

Both call
`11thandOrange/agent-ops/.github/workflows/e2e-pipeline-reusable.yml@main`,
grant `contents: read` + `pull-requests: write`, and set
`coverage_manifest_path` (omit/empty to skip the flow-coverage gate). See
[`../.github/workflows/README.md`](../.github/workflows/README.md) for every input.

> The two caller templates deliberately reference different owners:
> `wiki-caller.yml` points at `HeyItsChloe/agent-ops` and
> `e2e-pipeline-caller.yml` at `11thandOrange/agent-ops` (the fork the
> 11thandOrange app repos consume). Point a caller at whichever copy the target
> repo actually has access to.

---

## `wiki-site/`

Shared React + TypeScript + Tailwind + Vite documentation site template. It is
**not** developed against directly — `scripts/wiki-generate.mjs` copies it into
each consuming repo's `docs/` (or whatever `--site-dir` is configured), once,
only for files that don't already exist there, then the extractors populate its
data/content. This repo's own [`agent-ops-docs/`](../agent-ops-docs/) is a
bootstrapped instance of this template.

Generated vs. hand-owned:

| Path | Owner |
|---|---|
| `src/data/*.generated.json` | extractors (idempotent merge — safe to hand-edit between runs) |
| `src/data/*.ts` | extractors/driver (always fully regenerated — never hand-edit) |
| `src/content/*.md` | markdown/features extractors |
| `src/wiki.config.generated.ts`, `src/data/navigation.ts` | driver, from `wiki.config.yaml` |
| everything else (components, pages, config) | the consuming repo, once bootstrapped — the generator never overwrites files outside the paths above |

It also carries [`wiki.config.example.yaml`](wiki-site/wiki.config.example.yaml)
— the annotated starting config. See
[`wiki-site/README.md`](wiki-site/README.md) for the content model, the Sandbox
proxy design, and local dev.

## `wiki-backend/`

Shared Node/Express proxy — one deployed instance per app wiki. Its only job is
to let the site's Sandbox ("Try it") panel call the real target API without
CORS: the browser `POST`s `/api/proxy`, the server forwards to a **fixed,
server-side** `TARGET_API_BASE_URL` (not client-suppliable — not an open
proxy), attaching whatever auth header the user typed in the sandbox.

- `GET /health` — liveness.
- `POST /api/proxy` — `{ method, path, headers?, body? }` → forwards to
  `TARGET_API_BASE_URL + path`, returns `{ status, body }`.
- Config: `PORT`, `TARGET_API_BASE_URL`, `ALLOWED_ORIGINS`. `TARGET_API_BASE_URL`
  should match the consuming repo's `wiki.config.yaml` `backend.targetApiBaseUrl`;
  the deployed URL should match `backend.proxyBaseUrl`.

See [`wiki-backend/README.md`](wiki-backend/README.md) for the full contract and
why it's Node/Express rather than a port of OrderMate's FastAPI backend.

---

## How a consuming repo adopts all this

1. Copy `wiki-caller.yml` → `.github/workflows/wiki-generate.yml`.
2. Copy `wiki-site/wiki.config.example.yaml` → repo-root `wiki.config.yaml` and
   fill it in (schema: [`../scripts/README.md`](../scripts/README.md)).
3. Push to `main` — the reusable workflow bootstraps `docs/` from `wiki-site`,
   runs the extractors, commits generated output, and deploys to Pages.
4. (Optional) deploy a `wiki-backend` instance and set `backend.*` in the config
   to enable the Sandbox.
5. (Optional, for API testing repos) copy `e2e-pipeline-caller.yml` and add an
   `e2e-coverage.yaml` manifest.
