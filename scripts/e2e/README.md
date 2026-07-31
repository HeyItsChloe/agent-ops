# `scripts/e2e/` — automated E2E onboarding for the reusable pipeline

These scripts let a **brand-new repository** (no tests, no CI) adopt fully
automated end-to-end testing through
[`.github/workflows/e2e-pipeline-reusable.yml`](../../.github/workflows/e2e-pipeline-reusable.yml)
with minimal configuration. They implement subtasks 3a–3f of agent-ops
issue #10.

Everything here is **opt-in and backwards compatible**: existing callers that
pass their own `install_command` / `test_command` are completely unaffected.
The new behavior only runs when a caller sets `autogen: true`.

## The scripts

| Script | Role | Pure/testable core |
| --- | --- | --- |
| `detect.mjs` | Detect `language`, `framework`, `packageManager`, `appType` (frontend/backend/both), `startCommand`, `baseUrl`, `testFramework`, `needsEmulator` from `package.json` + config markers. | `detectFromInputs()` — no filesystem |
| `generate.mjs` | Given detection + a route/endpoint inventory, generate framework-appropriate specs (Playwright, Cypress, Jest, Mocha). Uses the LiteLLM gateway alias when configured; deterministic fallback otherwise. | `buildTestPlan()`, `endpointsFromInventory()`, `specPathFor()`, `fallbackSpec()`, `buildPrompt()` |
| `scaffold-caller.mjs` | Write a target repo's `.github/workflows/e2e.yml` thin caller + `e2e-coverage.yaml` manifest. | `renderCaller()`, `renderCoverageManifest()` |

## Model usage (same pattern as `wiki-author.mjs`)

- All generation/repair goes through the **LiteLLM gateway alias**
  (`LITELLM_PROXY_URL` / `LITELLM_VIRTUAL_KEY`). No provider SDK or key ever
  touches CI.
- When those env vars are **unset**, `generate.mjs` is a **no-op (exit 0)** by
  default — a normal pipeline run is unaffected. With `--allow-fallback` (used
  by the repair loop) it emits a deterministic, dependency-light spec so the
  bounded loop always has something runnable.
- Existing authored specs are **never overwritten** (committed tests win)
  unless `--force` is passed (the repair loop owns its generated file).

## Detection → generation → scaffolding (local)

```bash
# 1. Detect
node scripts/e2e/detect.mjs --repo-root . > detection.json

# 2. Generate specs from an inventory (Playwright first-class)
#    inventory.json: { "routes": ["/", "/about"],
#                      "endpoints": [{ "method": "GET", "path": "/api/health" }] }
node scripts/e2e/generate.mjs --repo-root . \
  --detection detection.json --inventory inventory.json --allow-fallback

# 3. Scaffold the caller + coverage manifest into a target repo
node scripts/e2e/scaffold-caller.mjs --repo-root ../target-repo \
  --detection detection.json --flows flows.json --autogen
```

## The CI flow (`autogen: true`)

The `e2e-autogen` job in the reusable workflow runs, bounded by
`max_repair_attempts` (default 3):

```
detect → install deps → install test framework → boot app (start_command)
      → [ generate → run tests → on fail: feed logs back → regenerate ] × N
      → coverage check → upload artifacts (results, video, screenshots)
      → PR comment
```

- **Framework detection** — `detect.mjs` picks the framework; the workflow
  keeps framework choice an opaque input (never hardcoded inline), same as the
  existing pass-through path.
- **Test generation** — Playwright by default; Cypress/Jest/Mocha selectable.
  Frontend journeys come from `routes`; backend journeys from `endpoints` or an
  OpenAPI/Swagger `openapi` doc in the inventory.
- **Repair loop** — on failure, the run log is fed back into `generate.mjs`
  (`--failure-log`) so the model repairs the spec, then re-runs. Bounded to
  avoid infinite CI spend.
- **Video & screenshots** — `record_video` and the new `capture_screenshots`
  toggle are independent. Playwright gets `PLAYWRIGHT_VIDEO` /
  `PLAYWRIGHT_SCREENSHOT`; emulator repos get `screenrecord` + a `screencap`
  pull.
- **Coverage expectations** — generated Playwright titles are
  `test('flow: <name>')`, so [`check-flow-coverage.mjs`](../check-flow-coverage.mjs)
  matches each declared flow in `e2e-coverage.yaml` to a passing test.

## New reusable-workflow inputs (all defaulted → backwards compatible)

| Input | Default | Purpose |
| --- | --- | --- |
| `autogen` | `false` | Enable the generate/repair job. Off ⇒ legacy behavior. |
| `test_framework` | `""` | Framework for autogen; empty ⇒ detected. |
| `start_command` | `""` | Boot the app under test (backgrounded). |
| `base_url` | `""` | Exported as `E2E_BASE_URL`; empty ⇒ detected. |
| `inventory_path` | `e2e-inventory.json` | Route/endpoint inventory (relative to `working_directory`). |
| `max_repair_attempts` | `3` | Upper bound on repair cycles. |
| `capture_screenshots` | `false` | Screenshot capture alongside video. |
| `control_repo` | `11thandOrange/agent-ops` | owner/repo hosting these scripts (was hardcoded; now parameterized — issue #10 / #1c). |

## Tests

```bash
cd scripts && npm ci
npm test            # runs: node --test "e2e/*.test.mjs"
```

Unit tests (`e2e/detect.test.mjs`) cover the pure logic in all three scripts:
framework/package-manager/appType detection across Vite, Next, Nest, Express,
Angular, Android, FastAPI, Django; inventory normalization (list + OpenAPI);
test-plan building; spec-path selection; fallback-spec flow-name embedding;
and caller/manifest rendering (legacy vs. autogen vs. emulator).
