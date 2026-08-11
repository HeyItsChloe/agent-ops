/**
 * Environment / configuration extractor (agent-ops).
 *
 * Reads each configured `.env.example` and emits one EnvVarDoc per declared
 * variable: its name, default value (verbatim RHS), the preceding comment
 * block as its description, its component, and whether it is required. The
 * "required" signal is the real one - a variable is required iff it appears
 * in a `requireEnv("NAME")` call in the configured source file (e.g. the
 * orchestrator's index.ts) - so the reference matches the code, not a guess.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource } from './merge.mjs';

const KV_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/;

/** Collects every NAME from requireEnv("NAME") calls in a source file. */
function requiredNames(repoRoot, requiredFrom) {
  if (!requiredFrom) return new Set();
  const abs = resolve(repoRoot, requiredFrom);
  if (!existsSync(abs)) return new Set();
  const src = readFileSync(abs, 'utf8');
  const names = new Set();
  const re = /requireEnv\(\s*["'`]([A-Z0-9_]+)["'`]\s*\)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

/** Parses a .env.example into { name, defaultValue, description } records. */
function parseEnvExample(text) {
  const out = [];
  let buffer = [];
  let lastWasVar = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) {
      if (lastWasVar) buffer = []; // a new comment after a var starts a new block
      buffer.push(line.replace(/^\s*#\s?/, ''));
      lastWasVar = false;
    } else if (/^\s*$/.test(line)) {
      buffer = [];
      lastWasVar = false;
    } else {
      const m = KV_RE.exec(line);
      if (!m) continue;
      out.push({ name: m[1], defaultValue: m[2].trim(), description: buffer.join('\n').trim() });
      lastWasVar = true; // grouped vars under one comment block share its description
    }
  }
  return out;
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.env;
  if (!opts?.enabled) return { skipped: true };

  const bySlug = new Map(); // dedupe: .env.example may list a var more than once
  for (const source of opts.sources ?? []) {
    const abs = resolve(repoRoot, source.envFile);
    if (!existsSync(abs)) continue;
    const required = requiredNames(repoRoot, source.requiredFrom);
    for (const v of parseEnvExample(readFileSync(abs, 'utf8'))) {
      if (bySlug.has(v.name)) continue;
      const doc = {
        slug: v.name,
        name: v.name,
        required: required.has(v.name),
        description: v.description,
        component: source.component ?? 'app',
        defaultValue: v.defaultValue,
      };
      bySlug.set(v.name, { ...doc, _sourceHash: hashSource(`${doc.component}|${doc.name}|${doc.required}|${doc.defaultValue}|${doc.description}`) });
    }
  }
  const incoming = [...bySlug.values()];

  const sidecarPath = join(outputPaths.dataDir, 'env.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'env.ts'),
    `import type { EnvVarDoc } from '../types';\nimport data from './env.generated.json';\n\nexport const envVars = data as unknown as EnvVarDoc[];\n`
  );

  return { kind: 'env', ...result };
}
