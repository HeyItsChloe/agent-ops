#!/usr/bin/env node
/**
 * Documentation-authoring step (agent-ops issue #286, approach A).
 *
 * The wiki generator only extracts *facts*; the prose (summaries, descriptions,
 * curated lists) is authored. This script is the automation path for producing
 * that prose: it asks the model behind the LiteLLM `documentation` alias to
 * draft it, grounded only in the extracted facts.
 *
 * Two authoring surfaces, both automatic:
 *   1. Features — drafts <site>/src/content/features/<slug>.md from the
 *      wiki-content/authoring.yaml manifest (facts hand-listed there).
 *   2. Every other page kind (apps, automation, tests, workflows) — reads the
 *      facts the generator already extracted into <site>/src/data/<kind>.generated.json
 *      and drafts the prose fields into wiki-content/authored/<kind>.yaml, which
 *      the generator then overlays onto the facts on its next run. No per-entry
 *      manifest needed — the facts drive it.
 *
 * Deliberately conservative:
 *   - No-op (exit 0) when LITELLM_PROXY_URL / LITELLM_VIRTUAL_KEY are unset, so
 *     a normal generate run is unaffected.
 *   - Never overwrites an existing authored feature file or authored entry —
 *     human/committed prose always wins.
 *
 * Everything through the LiteLLM alias; no provider SDK or key is used here.
 *
 * Usage: node scripts/wiki-author.mjs --repo-root <target> --site-dir <dir>
 *        [--manifest <path>] [--model documentation] [--data-dir src/data]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parse, stringify } from 'yaml';

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

const FEATURE_SYSTEM = `You write documentation for a software repo's wiki. Output ONLY a single markdown file: YAML frontmatter delimited by --- lines, then the body. Frontmatter keys: title, order (int), summary (<=160 chars), status, implements (workflows/skills/dependencies/integrations: arrays of slugs), runWith (array), tradeoffs (array), notes (array of {kind: tip|note|warning|important, body}). Body sections: "## What it does", "## How it works", "## Configuration & running". Be accurate and concise. Never invent file names, packages, or behavior beyond the provided facts.`;

async function chat(model, system, user) {
  // LITELLM_PROXY_URL already ends in /v1, so the path is /chat/completions
  // (not /v1/chat/completions) — matches orchestrator/src/integrations/litellm.ts.
  const res = await fetch(`${PROXY.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Asks the model for a JSON object with exactly the requested fields, grounded in facts. */
async function chatJson(model, fieldSpec, facts) {
  const keys = Object.entries(fieldSpec)
    .map(([k, t]) => `"${k}" (${t})`)
    .join(', ');
  const system = `You write concise, accurate documentation prose for a software repo's wiki, grounded ONLY in the facts given. Never invent file names, endpoints, packages, or behavior beyond the facts. Output ONLY a single minified JSON object with exactly these keys: ${keys}. No markdown, no code fences, no commentary.`;
  const user = `Facts (JSON):\n${JSON.stringify(facts)}\n\nWrite the documentation fields now as JSON.`;
  const raw = (await chat(model, system, user)).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(raw);
}

// The prose fields to draft per data kind, and their shapes (for the prompt).
const KINDS = {
  apps: {
    overview: 'string, 1-2 sentences',
    keyFeatures: 'array of short strings',
    configuration: 'array of short strings',
    storefrontBehavior: 'string, 1-2 sentences',
  },
  automation: { description: 'string, 1-2 sentences' },
  tests: { description: 'string, 1-2 sentences' },
  workflows: { description: 'string, 1-2 sentences' },
};

async function draftFeatures(model, repoRoot, siteDir, manifestArg) {
  const manifestPath = resolve(repoRoot, manifestArg ?? 'wiki-content/authoring.yaml');
  if (!existsSync(manifestPath)) {
    console.log(`[wiki-author] no authoring manifest at ${manifestPath} — skipping features.`);
    return;
  }
  const manifest = parse(readFileSync(manifestPath, 'utf8')) ?? {};
  const featuresDir = resolve(repoRoot, siteDir, 'src/content/features');
  for (const f of manifest.features ?? []) {
    const dest = join(featuresDir, `${f.slug}.md`);
    if (existsSync(dest)) {
      console.log(`[wiki-author] feature ${f.slug}: already authored, leaving as-is.`);
      continue;
    }
    console.log(`[wiki-author] drafting feature ${f.slug} via "${model}"...`);
    const user = `Write the feature file for "${f.title ?? f.slug}" (slug: ${f.slug}, order: ${f.order ?? 999}).\n\nFacts you must use (do not go beyond them):\n${f.facts ?? ''}`;
    try {
      const out = await chat(model, FEATURE_SYSTEM, user);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, out.trim() + '\n', 'utf8');
    } catch (err) {
      // Gateway hiccup — leave this feature unauthored rather than fail the
      // whole run (the generator still emits facts; a later run retries).
      console.warn(`[wiki-author]   feature ${f.slug} failed: ${err.message} — skipping.`);
    }
  }
}

async function draftDataKinds(model, repoRoot, dataDir) {
  const authoredDir = join(repoRoot, 'wiki-content', 'authored');
  for (const [kind, fieldSpec] of Object.entries(KINDS)) {
    const factsPath = join(repoRoot, dataDir, `${kind}.generated.json`);
    if (!existsSync(factsPath)) continue;
    let entries;
    try {
      entries = JSON.parse(readFileSync(factsPath, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(entries) || entries.length === 0) continue;

    const authoredPath = join(authoredDir, `${kind}.yaml`);
    const existingDoc = existsSync(authoredPath) ? parse(readFileSync(authoredPath, 'utf8')) ?? {} : {};
    const items = Array.isArray(existingDoc) ? existingDoc : existingDoc.items ?? [];
    const bySlug = new Map(items.filter((it) => it && it.slug).map((it) => [it.slug, it]));

    let drafted = 0;
    for (const e of entries) {
      if (bySlug.has(e.slug)) continue; // never overwrite committed authored prose
      const facts = { ...e };
      delete facts._sourceHash;
      console.log(`[wiki-author] drafting ${kind} "${e.slug}" via "${model}"...`);
      try {
        const prose = await chatJson(model, fieldSpec, facts);
        bySlug.set(e.slug, { slug: e.slug, ...prose });
        drafted++;
      } catch (err) {
        console.warn(`[wiki-author]   ${kind}/${e.slug} failed: ${err.message} — leaving to facts.`);
      }
    }

    if (drafted > 0) {
      mkdirSync(authoredDir, { recursive: true });
      const out = { items: [...bySlug.values()] };
      writeFileSync(authoredPath, stringify(out), 'utf8');
      console.log(`[wiki-author] wrote ${drafted} ${kind} entr${drafted === 1 ? 'y' : 'ies'} to ${authoredPath}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!PROXY || !KEY) {
    console.log('[wiki-author] LITELLM_PROXY_URL/LITELLM_VIRTUAL_KEY not set — skipping (content is authored/committed).');
    return;
  }
  const repoRoot = resolve(args['repo-root'] ?? '.');
  const siteDir = args['site-dir'] ?? 'docs';
  const dataDir = join(siteDir, args['data-dir'] ?? 'src/data');
  const model = args.model ?? process.env.WIKI_AUTHOR_MODEL ?? 'documentation';

  await draftFeatures(model, repoRoot, siteDir, args.manifest);
  await draftDataKinds(model, repoRoot, dataDir);

  console.log('[wiki-author] done.');
}

main().catch((err) => {
  console.error('[wiki-author] FAILED:', err);
  process.exit(1);
});
