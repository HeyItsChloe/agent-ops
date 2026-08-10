# Reusable E2E/CI pipeline

This document describes the shared end-to-end (E2E) test pipeline hosted in
`agent-ops`, the contract it exposes to app repos, and how to adopt it.

## What "Reusable E2E/CI" means here

The pipeline is split into two pieces:

- **One centrally-hosted `workflow_call` workflow** —
  [`.github/workflows/e2e-pipeline-reusable.yml`](../.github/workflows/e2e-pipeline-reusable.yml).
  It lives here, once, and owns everything that is the same across every app
  repo. Managed repos reference it as
  `11thandOrange/agent-ops/.github/workflows/e2e-pipeline-reusable.yml@main`.
- **A thin per-repo caller** — modelled on
  [`templates/e2e-pipeline-caller.yml`](../templates/e2e-pipeline-caller.yml).
  Each app repo copies this template into its own
  `.github/workflows/`, wires up the `pull_request` / `workflow_dispatch`
  triggers, and passes only its own install/test commands and toggles. The
  caller interprets nothing; the reusable workflow interprets nothing about the
  framework either — the test command is an opaque string passed straight
  through (see `e2e-pipeline-reusable.yml` lines 9–11).

The design intent is captured in the reusable workflow's header comment
(lines 3–16): the framework that actually runs (Playwright vs. Gradle/Espresso)
is **never hardcoded** in the shared workflow — it is always an input the
workflow passes through without interpreting.

## Reusable portions (owned by agent-ops)

Everything below is implemented once inside `e2e-pipeline-reusable.yml` and is
identical for every consuming repo:

- **Checkout** — `actions/checkout@v4` (lines 65, 140).
- **Toolchain setup** — Node via `actions/setup-node@v4` on the non-emulator
  path (lines 67–69, `node_version` input); Java (Temurin 17) via
  `actions/setup-java@v4` on the emulator path (lines 142–145).
- **Install step** — runs the caller's `install_command`, but only when it is
  non-empty (lines 71–74). Ignored entirely on the emulator path.
- **Test execution** — runs the caller's `test_command` in
  `working_directory` (lines 76–81 non-emulator; lines 317–320 emulator).
- **Emulator lifecycle** (emulator path only) — all owned centrally:
  - **KVM enablement** for hardware acceleration (lines 147–151).
  - **AVD cache** via `actions/cache@v4`, keyed `avd-v2-<api_level>`
    (lines 153–168). The `avd-v2-` prefix is deliberate: an older cached AVD
    defaulted to a 320×640 skin that clipped real headers, so the key was
    version-bumped alongside the `pixel_6` `profile:` (lines 160–167, 177).
  - **AVD snapshot creation** on cache miss via
    `reactivecircus/android-emulator-runner@v2` with a `pixel_6` profile
    (lines 170–180).
  - **SDK install** — platform-tools, the platform, the emulator, and the
    `google_apis;x86_64` system image, plus `PATH`/`$GITHUB_PATH` wiring so
    later steps get `adb`/`emulator` (lines 246–255). These SDK packages live
    outside the AVD cache path, so they are (re)installed every run
    (lines 231–245).
  - **Boot + input-ready wait** — the workflow launches the cached AVD itself
    and polls `sys.boot_completed` (up to 600s), then `service check input`
    (up to 60s), then retries `input keyevent 82` up to five times
    (lines 257–311). This exists to close a real race inside the third-party
    action's boot handshake, where the keyevent could fire before
    `InputManagerService` was published (lines 214–230, 294–302).
  - **Animation disable** — sets `window`, `transition`, and `animator`
    animation scales to `0.0` for test stability (lines 313–315).
  - **Teardown** — `adb emu kill` with `if: always()` (lines 322–324).
- **Artifact upload** — test results and (optionally) video, both with
  `if-no-files-found: ignore` (see below).
- **The `record_video` toggle** — Playwright repos get `--video=on` via the
  `PLAYWRIGHT_VIDEO` env var (line 79); emulator repos get an
  `adb shell screenrecord` wrapper around the test command that is pulled off
  the device afterward (lines 191–212, 349–355).
- **PR pass/fail comment** — a `github-script` step posts a
  `## ✅/❌ E2E Tests — PASSED/FAILED` comment linking the run, on
  `pull_request` events, `if: always()` (lines 115–129, 357–371).
- **Critical-flow coverage-manifest check** — checks out `agent-ops` scripts
  and runs [`scripts/check-flow-coverage.mjs`](../scripts/check-flow-coverage.mjs)
  when `coverage_manifest_path` is set (lines 86–97, 326–337). The script
  cross-checks each declared flow name against passing test identifiers
  (substring match) so a silently-deleted flow test fails the gate even when
  the rest of the suite passes.

## Repo-specific portions (provided by the caller)

The caller supplies only what actually differs per repo:

- **`working_directory`** — where install/test/artifacts are rooted.
- **`install_command`** — e.g. `npx playwright install chromium --with-deps`
  (Playwright); omitted for emulator repos.
- **`test_command`** — the real framework invocation:
  `npm run test:e2e` for Playwright, `./gradlew connectedDebugAndroidTest`
  for Android/Espresso.
- **`needs_emulator`** — selects the emulator path (see below).
- **`emulator_api_level`** — Android API level for the AVD/system image.
- **`record_video`** — usually wired to the `workflow_dispatch` input.
- **`coverage_manifest_path`** — path to the repo's `e2e-coverage.yaml`.
- **The repo's own test suite and `e2e-coverage.yaml` manifest** — the tests
  themselves and the flow list live in the app repo. Test naming that lets the
  coverage check match (e.g. a Playwright `test.describe('flow: bundle-checkout', …)`
  title, or an Espresso `BundleCheckoutFlowTest` class) is the repo's
  responsibility; the script only does substring matching.

## Inputs

Taken verbatim from `e2e-pipeline-reusable.yml`'s `workflow_call.inputs`
(lines 20–54):

| Name | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `working_directory` | true | string | — | Directory install/test/artifact paths are rooted at. |
| `install_command` | false | string | `""` | Repo-specific setup (e.g. `npx playwright install chromium --with-deps`). Ignored when `needs_emulator` is true — the emulator-runner handles its own setup. |
| `test_command` | true | string | — | The opaque framework command to run the tests. |
| `needs_emulator` | false | boolean | `false` | True for Android/Espresso repos — runs `test_command` inside a live emulator session instead of as a bare step. |
| `emulator_api_level` | false | number | `30` | Android API level for the AVD and system image. |
| `record_video` | false | boolean | `false` | Capture video of the test run. Playwright repos get `--video=on` via `PLAYWRIGHT_VIDEO`; emulator repos get `adb shell screenrecord` wrapped around `test_command`. |
| `coverage_manifest_path` | false | string | `""` | Path to this repo's critical-flow manifest (e.g. `e2e-coverage.yaml`). Empty string skips the check. |
| `node_version` | false | string | `"22"` | Node version for the non-emulator path. |

## Outputs / side-effects

The workflow declares no `workflow_call.outputs`; its effects are artifacts,
a PR comment, and a pass/fail gate:

- **Artifact `e2e-test-results`** — always uploaded (`if: always()`), with
  `if-no-files-found: ignore`. Non-emulator path uploads
  `<working_directory>/test-results/**` (lines 99–104); emulator path uploads
  `build/outputs/androidTest-results/**` and `build/reports/androidTests/**`
  (lines 339–347).
- **Artifact `e2e-test-video`** — uploaded only when `record_video` is true
  (`if: always() && inputs.record_video`). Non-emulator path uploads the
  Playwright `*.webm` files (lines 107–113); emulator path uploads
  `e2e-test-run.mp4` (lines 349–355).
- **PR comment** — on `pull_request` events, a pass/fail comment linking the
  run (lines 115–129, 357–371).
- **Coverage gate pass/fail** — when `coverage_manifest_path` is set, the job
  fails if any declared flow lacks a matching passing test, or if no test
  results are found at all (`check-flow-coverage.mjs` exit codes; the step runs
  as an ordinary failing step, lines 93–97 / 333–337).

## The single Android branch point

`needs_emulator` is the only real fork. The workflow defines two jobs guarded
by mutually exclusive `if:` conditions:

- `e2e-tests` — `if: inputs.needs_emulator == false` (line 59). The
  **Playwright / non-emulator path**: checkout → Node setup → install → run →
  coverage → artifacts → PR comment.
- `e2e-tests-emulator` — `if: inputs.needs_emulator == true` (line 133). The
  **emulator path**: checkout → Java setup → KVM → AVD cache → SDK install →
  launch+wait → run → teardown → coverage → artifacts → PR comment.

Everything else — the coverage check, artifact upload, the `record_video`
toggle, and the PR comment — is functionally identical between the two paths;
only the plumbing to get to (and tear down) a live Android emulator differs.
This is exactly why the emulator has to be booted and kept live for the whole
`test_command` run rather than merely installed beforehand (header comment,
lines 12–16).

## How to adopt

Copy [`templates/e2e-pipeline-caller.yml`](../templates/e2e-pipeline-caller.yml)
into the target repo's `.github/workflows/`, keep the block that matches the
stack, delete the other, and fill in the `CHANGE_ME` values.

**Playwright** (e.g. BusyBuddy_v2):

```yaml
jobs:
  playwright:
    permissions:
      contents: read
      pull-requests: write
    uses: 11thandOrange/agent-ops/.github/workflows/e2e-pipeline-reusable.yml@main
    with:
      working_directory: extensions/bogo-shopify-app
      install_command: "npx playwright install chromium --with-deps"
      test_command: "npm run test:e2e"
      needs_emulator: false
      record_video: ${{ inputs.record_video || false }}
      coverage_manifest_path: e2e-coverage.yaml
```

**Android/Espresso** (e.g. OrderMate):

```yaml
jobs:
  espresso:
    permissions:
      contents: read
      pull-requests: write
    uses: 11thandOrange/agent-ops/.github/workflows/e2e-pipeline-reusable.yml@main
    with:
      working_directory: app
      test_command: "./gradlew connectedDebugAndroidTest"
      needs_emulator: true
      emulator_api_level: 30
      record_video: ${{ inputs.record_video || false }}
      coverage_manifest_path: e2e-coverage.yaml
```

Then add the repo's `e2e-coverage.yaml` manifest at the path you pointed
`coverage_manifest_path` at (a `flows:` list of critical-flow names), and name
tests so each flow name appears in a passing test's identifier.

## Scope note

Today only a reusable **E2E** pipeline has been extracted. There is **no**
reusable **CI** (unit-test/build) workflow: BusyBuddy's `ci.yml` is
repo-specific and OrderMate has none of its own. The "CI" in the title is
aspirational — the shared piece so far is E2E only.

Extracting a reusable CI (unit-test/build) workflow, along the same
centrally-hosted `workflow_call` + thin-caller pattern used here, is worthwhile
**future work** but has not been done yet.
