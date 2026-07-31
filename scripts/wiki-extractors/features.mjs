/**
 * Feature docs (agent-ops issue #286 extension): the authored-content layer.
 *
 * Unlike the other extractors, `features` does not derive anything from repo
 * source — it registers hand-authored (approach-A) feature pages that a
 * documentation agent writes as markdown-with-frontmatter under the site's
 * own `src/content/features/*.md`. The extractor parses each file's YAML
 * frontmatter into a FeatureDoc (summary, status, the entities it
 * `implements`, how to run it, tradeoffs, note callouts) and leaves the body
 * in place for the Features page to render. The prose is version-controlled
 * and diffable; only the *facts* other extractors emit are machine-derived.
 *
 * Files are keyed by filename slug; the never-remove merge rule applies as
 * everywhere else.
 */

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { globSync } from './glob.mjs';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource } from './merge.mjs';
import { applyMetadata } from './metadata.mjs';

/** Splits a `---`-delimited YAML frontmatter block from the markdown body. */
export function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, body: raw };
  return { data: parse(m[1]) ?? {}, body: m[2] ?? '' };
}

function normNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((n) => ({ kind: n?.kind ?? 'note', body: n?.body ?? '' }))
    .filter((n) => n.body);
}

export async function extract({ config, outputPaths }) {
  const opts = config.extractors.features;
  if (!opts?.enabled) return { skipped: true };

  const dir = join(outputPaths.contentDir, opts.dir ?? 'features');
  const files = globSync('*.md', { cwd: dir });

  // Parse each authored file into a raw record. Missing summary/order/status
  // are left UNDEFINED here (not defaulted to ''/999/'stable') so the
  // deterministic metadata layer below can derive them from the entity's own
  // content; any authored value is passed through untouched and always wins.
  const parsed = files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8');
    const { data, body } = splitFrontmatter(raw);
    const slug = basename(f, '.md');
    const impl = data.implements ?? {};
    return {
      slug,
      title: data.title ?? slug,
      // Authored values pass through; absent ones stay undefined for derivation.
      summary: data.summary,
      order: typeof data.order === 'number' ? data.order : undefined,
      status: data.status,
      implements: {
        workflows: impl.workflows ?? [],
        skills: impl.skills ?? [],
        dependencies: impl.dependencies ?? [],
        integrations: impl.integrations ?? [],
      },
      runWith: data.runWith ?? [],
      tradeoffs: data.tradeoffs ?? [],
      notes: normNotes(data.notes),
      contentFile: `features/${slug}.md`,
      // Kept only to feed deterministic summary derivation; stripped below so
      // it never lands in the generated sidecar / public FeatureDoc type.
      body,
      _sourceHash: hashSource(raw),
    };
  });

  // Deterministically fill any MISSING metadata (summary from the body's
  // first paragraph, a stable order, a sensible default status) so a new
  // feature file with no frontmatter still appears correctly — while any
  // authored summary/order/status above overrides the derived value.
  const incoming = applyMetadata(parsed, { defaultStatus: opts.defaultStatus })
    .map(({ body, ...entry }) => entry) // drop the transient body field
    .sort((a, b) => a.order - b.order);

  const sidecarPath = join(outputPaths.dataDir, 'features.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'features.ts'),
    `import type { FeatureDoc } from '../types';\nimport data from './features.generated.json';\n\nexport const features = (data as unknown as FeatureDoc[]).slice().sort((a, b) => a.order - b.order);\n\nexport function getFeature(slug: string) {\n  return features.find((f) => f.slug === slug);\n}\n`
  );

  return { kind: 'features', ...result };
}
