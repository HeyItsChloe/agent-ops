#!/usr/bin/env node
/**
 * Optional documentation-authoring step (agent-ops issue #286, approach A).
 *
 * The wiki generator only extracts *facts*; the prose (per-feature summaries,
 * how-it-works, tradeoffs, note callouts) is authored content committed under
 * <site>/src/content/features/*.md. This script is the automation path for
 * producing that content: for each feature listed in an authoring manifest
 * whose file does not yet exist, it asks the model behind the LiteLLM
 * `documentation` alias (Anthropic — see litellm/config.yaml) to draft the
 * file in the exact frontmatter format the features extractor parses.
 *
 * It is deliberately conservative:
 *   - No-op (exit 0) when LITELLM_PROXY_URL / LITELLM_VIRTUAL_KEY are unset,
 *     so a normal generate run is unaffected.
 *   - Never overwrites an existing authored file — human/committed prose wins.
 *   - No-op when there is no manifest.
 *
 * Everything through the LiteLLM alias; no provider SDK or key is used here.
 *
 * Usage: node scripts/wiki-author.mjs --repo-root <target> --site-dir <dir>
 *        [--manifest <path>] [--model documentation]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parse } from 'yaml';

const PROXY = process.env.LITELLM_PROXY_URL;
const KEY = process.env.LITELLM_VIRTUAL_KEY;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[k] = v;
    }
  }
  return args;
}

const SYSTEM = `You write documentation for a software repo's wiki. Output ONLY a single markdown file: YAML frontmatter delimited by --- lines, then the body. Frontmatter keys: title, order (int), summary (<=160 chars), status, implements (workflows/skills/dependencies/integrations: arrays of slugs), runWith (array), tradeoffs (array), notes (array of {kind: tip|note|warning|important, body}). Body sections: "## What it does", "## How it works", "## Configuration & running". Be accurate and concise. Never invent file names, packages, or behavior beyond the provided facts.`;

async function chat(model, user) {
  // LITELLM_PROXY_URL already ends in /v1 (see .env.example and
  // integrations/litellm.ts, which appends /chat/completions to the same
  // value) - so append only /chat/completions here, not /v1/chat/completions,
  // which would double the segment and 404.
  const res = await fetch(`${PROXY.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!PROXY || !KEY) {
    console.log('[wiki-author] LITELLM_PROXY_URL/LITELLM_VIRTUAL_KEY not set — skipping (content is authored/committed).');
    return;
  }
  const repoRoot = resolve(args['repo-root'] ?? '.');
  const siteDir = args['site-dir'] ?? 'docs';
  const model = args.model ?? process.env.WIKI_AUTHOR_MODEL ?? 'documentation';
  const manifestPath = resolve(repoRoot, args.manifest ?? 'wiki-content/authoring.yaml');
  if (!existsSync(manifestPath)) {
    console.log(`[wiki-author] no authoring manifest at ${manifestPath} — nothing to draft.`);
    return;
  }

  const manifest = parse(readFileSync(manifestPath, 'utf8')) ?? {};
  const featuresDir = resolve(repoRoot, siteDir, 'src/content/features');
  const wanted = manifest.features ?? [];

  for (const f of wanted) {
    const dest = join(featuresDir, `${f.slug}.md`);
    if (existsSync(dest)) {
      console.log(`[wiki-author] ${f.slug}: already authored, leaving as-is.`);
      continue;
    }
    console.log(`[wiki-author] drafting ${f.slug} via alias "${model}"...`);
    const user = `Write the feature file for "${f.title ?? f.slug}" (slug: ${f.slug}, order: ${f.order ?? 999}).\n\nFacts you must use (do not go beyond them):\n${f.facts ?? ''}`;
    const out = await chat(model, user);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out.trim() + '\n', 'utf8');
  }
  console.log('[wiki-author] done.');
}

main().catch((err) => {
  console.error('[wiki-author] FAILED:', err);
  process.exit(1);
});
