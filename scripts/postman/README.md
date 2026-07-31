# Postman Collection Generator

Central logic for the shared **Postman Collection (v2.1)** generator
(agent-ops issue #12). It produces a schema-valid Postman collection for a
repo's API, detects new/changed endpoints, regenerates + commits the
collection, and fails CI when generation or validation fails.

Like the wiki generator, the real logic lives here once; app repos keep only a
thin caller workflow (`templates/postman-caller.yml`).

## Files

| File | Purpose |
| --- | --- |
| `generate.mjs` | Build a Postman v2.1 collection from a spec or the endpoint inventory. |
| `validate.mjs` | Validate a collection against the vendored Postman v2.1 JSON Schema; nonzero exit on failure. |
| `schema/collection-v2.1.0.json` | Vendored official Postman Collection Format v2.1 schema (offline, deterministic validation). |
| `__fixtures__/` | Tiny OpenAPI + endpoint-inventory fixtures used by the test. |
| `generate.test.mjs` | `node --test` suite: generate + validate both source modes. |

## Two source modes

Source selection is config-driven (`--source` / `PM_SOURCE` / `postman.config.json`).

### 1. `spec` (preferred)

Convert an **OpenAPI/Swagger** document with the maintained
[`openapi-to-postmanv2`](https://www.npmjs.com/package/openapi-to-postmanv2)
library. We never hand-roll the OpenAPI→Postman mapping.

```bash
node scripts/postman/generate.mjs \
  --repo-root /path/to/target-repo \
  --source spec \
  --spec-path openapi.json \
  --output postman/collection.json \
  --name "My API"
```

Supports `.json`, `.yaml`, and `.yml` specs.

### 2. `extractors` (no spec available)

Reuse the endpoint inventory the **wiki generator** already emits
(`scripts/wiki-extractors/endpoints-express.mjs` and `endpoints-kotlin.mjs`
write `endpoints.generated.json`, an `EndpointGroup[]`). This keeps the
Postman collection in sync with the wiki from a single source of truth — no
duplicate endpoint list to maintain.

```bash
node scripts/postman/generate.mjs \
  --repo-root /path/to/target-repo \
  --source extractors \
  --endpoint-source docs/src/data/endpoints.generated.json \
  --output postman/collection.json \
  --name "My API"
```

Path params (`:id` or `{id}`), query params, and JSON request bodies are all
mapped into the collection.

## Validate

```bash
node scripts/postman/validate.mjs postman/collection.json
# or
node scripts/postman/validate.mjs --repo-root /path/to/repo --output postman/collection.json
```

Exit `0` = valid Postman v2.1; nonzero (with printed schema errors) = invalid.
This is the gate that fails CI on a broken generation.

## Configuration

CLI flags and env vars override an optional `postman.config.json` at the
target repo root:

```json
{
  "source": "spec",
  "specPath": "openapi.json",
  "endpointSource": "docs/src/data/endpoints.generated.json",
  "output": "postman/collection.json",
  "name": "My API"
}
```

Env equivalents: `PM_REPO_ROOT`, `PM_SOURCE`, `PM_SPEC_PATH`,
`PM_ENDPOINT_SOURCE`, `PM_OUTPUT`, `PM_NAME`.

## How it stays in sync (determinism)

`openapi-to-postmanv2` stamps fresh random UUIDs and doesn't guarantee item
ordering, which would make the committed collection churn every run. The
generator therefore **canonicalizes** its output:

- every item / response `id` and `info._postman_id` is replaced with a
  deterministic sha1 derived from the item's stable identity (folder path +
  method + url + name);
- items are sorted by `(method, url, name)`;
- non-deterministic generator metadata (e.g. `_postman_exporter_id`) is dropped.

Result: for an **unchanged API the output is byte-identical**, so `git diff`
is empty. The reusable workflow uses exactly that — a non-empty diff means an
endpoint was added/changed, which triggers the commit-back. Unchanged APIs
produce no noisy diffs and no commits.

## CI (reusable workflow)

`.github/workflows/postman-generate-reusable.yml` is a `workflow_call`
reusable workflow. Inputs: `working_directory`, `spec_path`,
`endpoint_source` (`spec` | `extractors`), `output_path`,
`endpoints_inventory_path`, `collection_name`.

Steps: **generate → validate → diff vs committed → commit-back only when
changed → fail the job on any generation/validation error.** App repos add a
thin caller (`templates/postman-caller.yml`).

## Tests

```bash
cd scripts
npm install
node --test postman/generate.test.mjs
```
