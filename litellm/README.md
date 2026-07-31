# litellm/ — the model gateway

A [LiteLLM](https://github.com/BerriAI/litellm) proxy that every agent-ops
component calls instead of a provider SDK. The whole point is **model aliases**:
components call `planning` / `implementation` / `classification` /
`documentation`, and swapping the real model behind an alias is a one-line edit
in [`config.yaml`](config.yaml) — nothing downstream (orchestrator, skills,
GitHub Actions, the wiki authoring agent) changes.

Contents:

- **`config.yaml`** — the model list, aliases, fallbacks, and general settings.
- **`Dockerfile`** — bakes `config.yaml` into the official LiteLLM image for
  Cloud Run.
- **`docker-compose.yml`** — local/VM run.

Related: [`../README.md`](../README.md) · deploy workflow
[`../.github/workflows/README.md`](../.github/workflows/README.md).

---

## Aliases (`config.yaml`)

| Alias | Model today | Used by |
|---|---|---|
| `planning` | `gemini/gemini-2.5-flash` *(temporary — see below)* | dev/personal pipelines' planning phase |
| `implementation` | `gemini/gemini-2.5-flash` | dev pipelines' implementation phase |
| `classification` | `ollama/qwen2.5-coder:7b` (local, `http://localhost:11434`) | lightweight local classification |
| `documentation` | `anthropic/claude-opus-4-8` | the wiki authoring agent (`scripts/wiki-author.mjs`) |
| `implementation-fallback` | `openai/gpt-5.1` | fallback target |

**Fallbacks** (`router_settings.fallbacks`): `implementation` →
`implementation-fallback`, and `planning` → `implementation-fallback`.

Notes captured in `config.yaml`:

- `planning` points at `gemini-2.5-flash` **temporarily** — `gemini-2.5-pro`'s
  free-tier quota on the current key is 0 req/tokens. Revert once billing/quota
  is upgraded, or once the Anthropic key lands and it repoints to Claude.
- Commented-out Anthropic entries show the intended `planning`/`implementation`
  → Claude switch (a two-alias edit, nothing else).
- The `documentation` alias is deliberately Anthropic even while the dev
  pipelines run on Gemini — docs prose is the one place the strongest writer is
  wanted regardless of the dev model. This is the alias `wiki-author.mjs`
  defaults to.

## General settings

```yaml
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
```

- **`master_key`** — the gateway's virtual-key master (deployed from the
  `LITELLM_VIRTUAL_KEY` secret; see the deploy workflow, which maps it to
  `LITELLM_MASTER_KEY`).
- **`database_url`** — a Postgres URL is **required**: this LiteLLM build hard-
  fails key auth with a misleading "No connected db" error without one, even
  with a correct master key. Points at a free-tier **Supabase** Postgres. Use
  Supabase's *direct* connection (port 5432), **not** the transaction-mode
  pooler (6543) — the pooler breaks LiteLLM's startup `prisma migrate deploy`.

Provider keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are read
from the environment by the referenced `litellm_params`. Budget alerting is
handled outside LiteLLM via GCP Billing budgets, not the DB-backed alerting.

---

## Local development

```bash
# from litellm/
export LITELLM_MASTER_KEY=… DATABASE_URL=… GEMINI_API_KEY=… ANTHROPIC_API_KEY=… OPENAI_API_KEY=…
docker compose up
# proxy on http://localhost:4000
```

`docker-compose.yml` runs only the proxy (`--port 4000`); there's no local
Postgres container because `DATABASE_URL` points at the external Supabase
instance in every environment.

## Deploy

`Dockerfile` bakes `config.yaml` into `ghcr.io/berriai/litellm:main-stable` and
listens on port `8080` (Cloud Run's expected port). `docker-compose.yml` remains
the source of truth for local/VM runs.

[`../.github/workflows/deploy-litellm.yml`](../.github/workflows/README.md)
deploys to Cloud Run (`gcloud run deploy litellm-gateway --source litellm/`,
project `agent-ops-501120`, region `us-central1`, `--memory 2Gi`) on push to
`main` touching `litellm/**`, or manual dispatch. It forwards `GEMINI_API_KEY`,
`LITELLM_VIRTUAL_KEY` (→ `LITELLM_MASTER_KEY`), and `DATABASE_URL`.

## Calling the gateway

Standard OpenAI-compatible chat completions, using an alias as the model name:

```bash
curl "$LITELLM_PROXY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"documentation","messages":[{"role":"user","content":"hi"}]}'
```

This is exactly what `scripts/wiki-author.mjs` does with the `documentation`
alias.
