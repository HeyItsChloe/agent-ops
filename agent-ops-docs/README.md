# agent-ops-docs

This repo's **own** generated documentation site — a bootstrapped instance of
the shared [`templates/wiki-site`](../templates/wiki-site/README.md) template.
agent-ops "documents itself": the wiki generator runs against this repo using
[`../wiki.config.yaml`](../wiki.config.yaml) and writes into this directory.

> This is **not** the reusable template. The generic template lives at
> [`../templates/wiki-site/`](../templates/wiki-site/); this is what it looks
> like once bootstrapped and populated for one repo (agent-ops).

Built and deployed to GitHub Pages by
[`../.github/workflows/deploy-docs.yml`](../.github/workflows/README.md) on push
to `main` touching `agent-ops-docs/**`. (Note: unlike consuming repos, whose
sites are generated *and* deployed by `wiki-generate-reusable.yml`, agent-ops's
own site is deployed by the dedicated `deploy-docs.yml`.)

Related: [`../README.md`](../README.md) ·
[`../scripts/README.md`](../scripts/README.md) (the generator) ·
[`../templates/wiki-site/README.md`](../templates/wiki-site/README.md) (the template).

## What's generated vs. hand-owned

Because this is a bootstrapped `wiki-site`, the same ownership rules apply:

| Path | Owner |
|---|---|
| `src/data/*.generated.json` | extractors (idempotent merge — safe to hand-edit between runs) |
| `src/data/*.ts` | extractors/driver (always fully regenerated — never hand-edit) |
| `src/content/*.md` | markdown/features extractors (authored feature prose lives in `src/content/features/`) |
| `src/wiki.config.generated.ts`, `src/data/navigation.ts` | driver, from `../wiki.config.yaml` |
| everything else (components, pages, config files) | hand-owned — the generator never overwrites files outside the paths above |

What this site documents (per [`../wiki.config.yaml`](../wiki.config.yaml)):
authored **feature** pages, the **workflows** (CI/CD), the shared **skills**,
npm **dependencies** + authored **integrations**, ingested **markdown**
(roadmap, contributing, orchestrator README), and an authored **changelog**.
The app-repo extractors (API endpoints, app list, e2e tests, per-repo
automation) are disabled here — agent-ops ships no app API and no pipeline runs
against it.

## Local development

```bash
npm install
npm run dev      # vite dev server
npm run build    # tsc -b && vite build -> dist/
```

To regenerate the data/content from source before building, run the generator
from the repo root (see [`../scripts/README.md`](../scripts/README.md)):

```bash
node scripts/wiki-generate.mjs \
  --repo-root . \
  --control-repo . \
  --config wiki.config.yaml \
  --site-dir agent-ops-docs
```

(For agent-ops, `--repo-root` and `--control-repo` are the same checkout, since
this repo is both the documented repo and the control repo.)
