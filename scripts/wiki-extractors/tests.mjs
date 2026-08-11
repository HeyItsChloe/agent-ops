/**
 * Extracts TestSuiteDoc[] - suite-level (not individual-test-level) coverage
 * summaries, per config.extractors.tests.suites (each entry names a
 * framework + glob, e.g. Playwright `*.spec.ts` or Gradle instrumented
 * tests). We only count matching files and note the suite; we do not parse
 * individual `test(...)`/`@Test` cases, per the issue's "suite-level only"
 * scope.
 *
 * Writes src/data/tests.generated.json + src/data/tests.ts.
 */

import { join } from 'node:path';
import { globSync } from './glob.mjs';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource, readAuthoredItems, overlayAuthored } from './merge.mjs';

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.tests;
  if (!opts?.enabled) return { skipped: true };

  const incoming = (opts.suites ?? []).map((suite) => {
    const files = globSync(suite.glob, { cwd: repoRoot }).sort();
    return {
      slug: slugify(suite.name),
      name: suite.name,
      framework: suite.framework,
      path: suite.glob,
      fileCount: files.length,
      description: suite.description ?? `${files.length} file(s) matching ${suite.glob}.`,
      // Includes the actual matched file list (not just the glob/config),
      // so a suite's source is considered "changed" when test files are
      // added/removed even though wiki.config.yaml itself didn't change.
      _sourceHash: hashSource(`${suite.name}::${suite.framework}::${suite.glob}::${files.join(',')}`),
    };
  });

  const sidecarPath = join(outputPaths.dataDir, 'tests.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });
  overlayAuthored(result.merged, readAuthoredItems(repoRoot, 'tests'), ['description']);

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'tests.ts'),
    `import type { TestSuiteDoc } from '../types';\nimport data from './tests.generated.json';\n\nexport const testSuites = data as unknown as TestSuiteDoc[];\n\nexport function getTestSuite(slug: string) {\n  return testSuites.find((t) => t.slug === slug);\n}\n`
  );

  return { kind: 'tests', ...result };
}
