/**
 * Extracts WorkflowDoc[] from .github/workflows/*.yml.
 * Writes src/data/workflows.generated.json + src/data/workflows.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { parse } from 'yaml';
import { globSync } from './glob.mjs';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource, readAuthoredItems, overlayAuthored } from './merge.mjs';

function slugFromFilename(file) {
  return basename(file).replace(/\.ya?ml$/, '');
}

/**
 * The first contiguous block of `#` comment lines in a workflow file - these
 * hand-written header comments are the real "why this workflow exists"
 * documentation (see e.g. deploy-docs.yml), far more useful than a synthetic
 * "Extracted from X." string. Returns '' if the file has no such block.
 */
function firstCommentBlock(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let started = false;
  for (const line of lines) {
    const isComment = /^\s*#/.test(line);
    if (isComment) {
      started = true;
      out.push(line.replace(/^\s*#\s?/, ''));
    } else if (started) {
      break; // end of the first contiguous comment block
    }
  }
  return out.join('\n').trim();
}

function titleFromWorkflow(doc, file) {
  return doc?.name ?? titleCase(slugFromFilename(file));
}

function titleCase(s) {
  return s
    .split(/[-_]/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function describeTrigger(on) {
  if (!on) return 'unknown';
  if (typeof on === 'string') return on;
  const parts = [];
  for (const [event, cfg] of Object.entries(on)) {
    if (!cfg || typeof cfg !== 'object') {
      parts.push(event);
      continue;
    }
    const bits = [];
    if (cfg.branches) bits.push(`branches: [${[].concat(cfg.branches).join(', ')}]`);
    if (cfg.paths) bits.push(`paths: [${[].concat(cfg.paths).join(', ')}]`);
    if (cfg.types) bits.push(`types: [${[].concat(cfg.types).join(', ')}]`);
    parts.push(bits.length ? `${event} (${bits.join(', ')})` : event);
  }
  return parts.join('  ·  ');
}

function jobsFromWorkflow(doc) {
  if (!doc?.jobs) return [];
  return Object.entries(doc.jobs).map(([jobName, job]) => ({
    name: jobName,
    runsOn: Array.isArray(job['runs-on']) ? job['runs-on'].join(', ') : String(job['runs-on'] ?? 'unknown'),
    steps: (job.steps ?? []).map((step, i) => ({
      name: step.name ?? step.uses ?? step.run?.split('\n')[0]?.slice(0, 80) ?? `step ${i + 1}`,
      detail: step.uses ? `uses: ${step.uses}` : step.run ? `run: ${step.run.split('\n')[0].slice(0, 120)}` : '',
    })),
  }));
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.workflows;
  if (!opts?.enabled) return { skipped: true };

  const globs = opts.glob ?? ['.github/workflows/*.yml'];
  const exclude = new Set(opts.exclude ?? []);
  const files = globs.flatMap((g) => globSync(g, { cwd: repoRoot })).filter((f) => !exclude.has(basename(f)));

  const incoming = [];
  for (const relFile of files) {
    const abs = resolve(repoRoot, relFile);
    const raw = readFileSync(abs, 'utf8');
    let doc;
    try {
      doc = parse(raw);
    } catch {
      continue; // unparsable workflow YAML - skip rather than fail the whole run
    }
    incoming.push({
      slug: slugFromFilename(relFile),
      title: titleFromWorkflow(doc, relFile),
      file: relFile,
      trigger: describeTrigger(doc?.on),
      description: firstCommentBlock(raw) || `Extracted from ${relFile}.`,
      jobs: jobsFromWorkflow(doc),
      _sourceHash: hashSource(raw),
    });
  }

  const sidecarPath = join(outputPaths.dataDir, 'workflows.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });
  overlayAuthored(result.merged, readAuthoredItems(repoRoot, 'workflows'), ['description']);

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'workflows.ts'),
    `import type { WorkflowDoc } from '../types';\nimport data from './workflows.generated.json';\n\nexport const workflows = data as unknown as WorkflowDoc[];\n\nexport function getWorkflow(slug: string) {\n  return workflows.find((w) => w.slug === slug);\n}\n`
  );

  return { kind: 'workflows', ...result };
}
