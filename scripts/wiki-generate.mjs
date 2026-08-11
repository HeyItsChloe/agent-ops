#!/usr/bin/env node
/**
 * Driver for the shared wiki generator (agent-ops issue #286).
 *
 * Reads a target repo's wiki.config.yaml and runs exactly the extractors it
 * declares under `extractors:`, then derives navigation.ts and a small
 * generated theme/config module from the same manifest. Nothing here is
 * hardcoded per-repo or per-extractor-kind: extractor modules are resolved
 * by convention (config key `fooBar` -> scripts/wiki-extractors/foo-bar.mjs,
 * exporting an `extract(ctx)` function), so adding a new extractor kind
 * later means adding one new module file + one new key in the target
 * repo's wiki.config.yaml - this file's core loop never changes.
 *
 * Usage:
 *   node scripts/wiki-generate.mjs \
 *     --repo-root /path/to/BusyBuddy_v2 \
 *     --control-repo /path/to/agent-ops \
 *     [--config /path/to/BusyBuddy_v2/wiki.config.yaml] \
 *     [--site-dir docs]
 *
 * Environment variable equivalents (used by the reusable workflow):
 *   WIKI_REPO_ROOT, WIKI_CONTROL_REPO, WIKI_CONFIG_PATH, WIKI_SITE_DIR
 */

import { existsSync, mkdirSync, cpSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWikiConfig, resolveOutputPaths } from './wiki-extractors/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

function camelToKebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Copies templates/wiki-site into the target repo's site dir, once, only for files that don't already exist there (bootstrap only - the generator never overwrites hand-customized site source on later runs, only src/data/*.generated.json, src/data/*.ts wrappers, and src/content/*.md, which extractors own directly). */
function bootstrapSiteIfMissing(controlRepoRoot, siteRoot) {
  const templateRoot = resolve(controlRepoRoot, 'templates/wiki-site');
  if (!existsSync(templateRoot)) {
    throw new Error(`wiki-site template not found at ${templateRoot} - is --control-repo pointed at an agent-ops checkout?`);
  }
  mkdirSync(siteRoot, { recursive: true });

  function copyMissing(srcDir, destDir) {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === 'wiki.config.example.yaml' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        copyMissing(srcPath, destPath);
      } else if (!existsSync(destPath)) {
        mkdirSync(dirname(destPath), { recursive: true });
        cpSync(srcPath, destPath);
      }
    }
  }
  copyMissing(templateRoot, siteRoot);
}

/** Derives src/data/navigation.ts from whichever data kinds this repo's config actually enabled - never hand-maintained per repo. */
function slugifySection(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function writeNavigation(config, outputPaths) {
  const sections = [];
  const e = config.extractors;

  if (e.features?.enabled) {
    sections.push({ key: 'features', title: 'Features', href: '/features', dataImport: "import { features } from './features';", childrenExpr: 'features.map((f) => ({ title: f.title, href: `/features/${f.slug}` }))' });
  }
  if (e.endpointsExpress?.enabled || e.endpointsKotlin?.enabled) {
    sections.push({ key: 'api', title: 'API Reference', href: '/api', dataImport: "import { endpointGroups } from './endpoints';", childrenExpr: 'endpointGroups.map((g) => ({ title: g.title, href: `/api/${g.slug}` }))' });
  }
  if (e.appList?.enabled) {
    sections.push({ key: 'apps', title: 'App List', href: '/apps', dataImport: "import { apps } from './apps';", childrenExpr: 'apps.map((a) => ({ title: a.name, href: `/apps/${a.slug}` }))' });
  }
  if (e.workflows?.enabled) {
    sections.push({ key: 'ci-cd', title: 'CI/CD', href: '/ci-cd', dataImport: "import { workflows } from './workflows';", childrenExpr: 'workflows.map((w) => ({ title: w.title, href: `/ci-cd/${w.slug}` }))' });
  }
  if (e.automation?.enabled) {
    sections.push({ key: 'automation', title: 'Automation', href: '/automation', dataImport: "import { automation } from './automation';", childrenExpr: 'automation.map((a) => ({ title: a.name, href: `/automation/${a.slug}` }))' });
  }
  if (e.skills?.enabled) {
    sections.push({ key: 'skills', title: 'Skills', href: '/skills', dataImport: "import { skills } from './skills';", childrenExpr: 'skills.map((s) => ({ title: s.title, href: `/skills/${s.slug}` }))' });
  }
  if (e.tests?.enabled) {
    sections.push({ key: 'tests', title: 'Test Coverage', href: '/tests', dataImport: "import { testSuites } from './tests';", childrenExpr: 'testSuites.map((t) => ({ title: t.name, href: `/tests/${t.slug}` }))' });
  }
  if (e.dependencies?.enabled || e.integrations?.enabled) {
    sections.push({ key: 'dependencies', title: 'Dependencies & Integrations', href: '/dependencies', dataImport: null, childrenExpr: '[]' });
  }
  if (e.models?.enabled) {
    sections.push({ key: 'models', title: 'Model Gateway', href: '/models', dataImport: null, childrenExpr: '[]' });
  }
  if (e.env?.enabled) {
    sections.push({ key: 'configuration', title: 'Configuration', href: '/configuration', dataImport: null, childrenExpr: '[]' });
  }

  // Markdown: one section per distinct navSection (read from the extracted
  // pages sidecar), keyed by a slug of the navSection - so a repo's roadmap/
  // docs land at /roadmap, contributing at /contributing, etc., instead of a
  // single generic "Docs" bucket.
  if (e.markdown?.enabled) {
    const pagesPath = join(outputPaths.dataDir, 'pages.generated.json');
    const pages = existsSync(pagesPath) ? JSON.parse(readFileSync(pagesPath, 'utf8')) : [];
    const seen = new Map(); // navSection title -> key
    for (const p of pages) {
      const nav = p.navSection || 'Docs';
      if (!seen.has(nav)) seen.set(nav, slugifySection(nav));
    }
    for (const [title, key] of seen) {
      sections.push({
        key,
        title,
        href: `/${key}`,
        dataImport: "import { markdownPages } from './pages';",
        childrenExpr: `markdownPages.filter((p) => p.navSection === ${JSON.stringify(title)}).map((p) => ({ title: p.title, href: \`/${key}/\${p.slug}\` }))`,
      });
    }
  }

  if (e.changelog?.enabled) {
    sections.push({ key: 'changelog', title: 'Changelog', href: '/changelog', dataImport: null, childrenExpr: '[]' });
  }

  const importLines = ["import type { NavSection } from '../types';"];
  const seenImports = new Set();
  for (const s of sections) {
    if (s.dataImport && !seenImports.has(s.dataImport)) {
      seenImports.add(s.dataImport);
      importLines.push(s.dataImport);
    }
  }

  const body = [
    importLines.join('\n'),
    '',
    '// No "Home" entry: the site title in the header is the home link.',
    'export const topNav: { title: string; href: string }[] = [',
    ...sections.map((s) => `  { title: ${JSON.stringify(s.title)}, href: '${s.href}' },`),
    '];',
    '',
    'export const sidebarSections: Record<string, NavSection> = {',
    ...sections.map((s) => `  '${s.key}': { title: ${JSON.stringify(s.title)}, href: '${s.href}', children: ${s.childrenExpr} },`),
    '};',
    '',
    'export function sectionKeyForPath(pathname: string): string {',
    "  const seg = pathname.split('/').filter(Boolean)[0] ?? '';",
    '  return Object.keys(sidebarSections).includes(seg) ? seg : Object.keys(sidebarSections)[0];',
    '}',
    '',
  ].join('\n');

  const banner = '// AUTO-GENERATED by scripts/wiki-generate.mjs from wiki.config.yaml\'s enabled extractors - do not hand-edit.\n\n';
  writeFileSync(join(outputPaths.dataDir, 'navigation.ts'), banner + body, 'utf8');
}

/** Writes the deterministic, literal-values-only theme/config module App.tsx reads at runtime. */
function writeSiteConfig(config, siteRoot) {
  const site = config.site ?? {};
  const backend = config.backend ?? {};
  const literal = {
    title: site.title,
    description: site.description ?? '',
    theme: {
      accent: site.theme?.accent ?? '#5169DD',
      accentHover: site.theme?.accentHover ?? site.theme?.accent ?? '#5169DD',
      accentMuted: site.theme?.accentMuted ?? 'rgba(81, 105, 221, 0.1)',
    },
    favicon: site.favicon ?? '/favicon.svg',
    githubUrl: site.githubUrl ?? '',
    proxyBaseUrl: backend.proxyBaseUrl ?? '',
    targetApiBaseUrl: backend.targetApiBaseUrl ?? '',
  };
  const body =
    '// AUTO-GENERATED by scripts/wiki-generate.mjs from wiki.config.yaml - do not hand-edit.\n' +
    '// Every value here is a literal copied from wiki.config.yaml - never LLM-generated.\n\n' +
    `export const wikiConfig = ${JSON.stringify(literal, null, 2)} as const;\n`;
  mkdirSync(join(siteRoot, 'src'), { recursive: true });
  writeFileSync(join(siteRoot, 'src', 'wiki.config.generated.ts'), body, 'utf8');

  if (site.customDomain) {
    const cnamePath = join(siteRoot, 'public', 'CNAME');
    mkdirSync(join(siteRoot, 'public'), { recursive: true });
    const existing = existsSync(cnamePath) ? readFileSync(cnamePath, 'utf8').trim() : null;
    if (existing !== site.customDomain) writeFileSync(cnamePath, site.customDomain + '\n', 'utf8');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args['repo-root'] ?? process.env.WIKI_REPO_ROOT ?? '.');
  const controlRepoRoot = resolve(args['control-repo'] ?? process.env.WIKI_CONTROL_REPO ?? __dirname + '/..');
  const configPath = resolve(args.config ?? process.env.WIKI_CONFIG_PATH ?? join(repoRoot, 'wiki.config.yaml'));
  const siteDir = args['site-dir'] ?? process.env.WIKI_SITE_DIR ?? 'docs';
  const siteRoot = resolve(repoRoot, siteDir);

  console.log(`[wiki-generate] repo-root=${repoRoot}`);
  console.log(`[wiki-generate] control-repo=${controlRepoRoot}`);
  console.log(`[wiki-generate] config=${configPath}`);
  console.log(`[wiki-generate] site-root=${siteRoot}`);

  const config = loadWikiConfig(configPath);
  bootstrapSiteIfMissing(controlRepoRoot, siteRoot);

  const outputPaths = resolveOutputPaths(config, siteRoot);
  mkdirSync(outputPaths.dataDir, { recursive: true });
  mkdirSync(outputPaths.contentDir, { recursive: true });

  const results = [];
  for (const key of Object.keys(config.extractors ?? {})) {
    const modulePath = resolve(__dirname, 'wiki-extractors', `${camelToKebab(key)}.mjs`);
    if (!existsSync(modulePath)) {
      console.warn(`[wiki-generate] WARN: no extractor module for "${key}" (expected ${modulePath}) - skipping.`);
      continue;
    }
    const mod = await import(`file://${modulePath}`);
    if (typeof mod.extract !== 'function') {
      console.warn(`[wiki-generate] WARN: ${modulePath} does not export extract() - skipping.`);
      continue;
    }
    console.log(`[wiki-generate] running extractor "${key}"...`);
    const result = await mod.extract({ repoRoot, siteRoot, config, outputPaths, controlRepoRoot });
    results.push({ key, ...result });
    if (result?.skipped) {
      console.log(`  disabled, skipped.`);
    } else {
      console.log(
        `  added=${result.added?.length ?? 0} updated=${result.updated?.length ?? 0} unchanged=${result.unchanged?.length ?? 0} stale=${result.stale?.length ?? 0}`
      );
    }
  }

  writeNavigation(config, outputPaths);
  writeSiteConfig(config, siteRoot);

  console.log('[wiki-generate] done.');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('[wiki-generate] FAILED:', err);
  process.exit(1);
});
