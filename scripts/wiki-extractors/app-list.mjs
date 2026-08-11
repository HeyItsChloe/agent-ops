/**
 * Extracts AppDoc[] from a frontend "app list" source file - BusyBuddy_v2's
 * web/frontend/pages/DashboardHome.jsx `widgetConfig` (per-app id/title/
 * description/icon/color) + `planFeatures` (plan -> included app ids)
 * pattern. Best-effort regex extraction (not a full JS/JSX parser) since
 * this source shape is a plain literal array/object, not arbitrary code.
 *
 * Writes src/data/apps.generated.json + src/data/apps.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource, readAuthoredItems, overlayAuthored } from './merge.mjs';

/** Extracts the source text of `const <name> = <literal>` by balancing brackets from the first opening bracket found. */
function extractLiteral(src, exportName) {
  const declRe = new RegExp(`(?:const|let|var)\\s+${exportName}\\s*=\\s*`);
  const m = declRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  const openChar = src[i];
  const closeChar = openChar === '[' ? ']' : openChar === '{' ? '}' : null;
  if (!closeChar) return null;
  let depth = 0;
  let inString = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (inString) {
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

/** Splits a top-level array literal's source into its object-entry source strings. */
function splitTopLevelObjects(arrayLiteralSrc) {
  const entries = [];
  let depth = 0;
  let start = -1;
  let inString = null;
  for (let i = 0; i < arrayLiteralSrc.length; i++) {
    const ch = arrayLiteralSrc[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        entries.push(arrayLiteralSrc.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

function field(objSrc, name) {
  const re = new RegExp(`${name}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`);
  const m = re.exec(objSrc);
  return m ? m[1] : undefined;
}

function identifierField(objSrc, name) {
  const re = new RegExp(`${name}\\s*:\\s*([A-Za-z0-9_$]+)`);
  const m = re.exec(objSrc);
  return m ? m[1] : undefined;
}

function parsePlanFeatures(planFeaturesSrc) {
  // planFeaturesSrc is a `{ Plan: [...], ... }` object literal source.
  const planMap = {};
  const planRe = /([A-Za-z0-9_]+)\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = planRe.exec(planFeaturesSrc))) {
    const [, plan, idsRaw] = m;
    const ids = [...idsRaw.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
    planMap[plan] = ids;
  }
  return planMap;
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.appList;
  if (!opts?.enabled) return { skipped: true };

  const abs = resolve(repoRoot, opts.sourceFile);
  if (!existsSync(abs)) {
    throw new Error(`appList.sourceFile not found: ${abs}`);
  }
  const src = readFileSync(abs, 'utf8');

  const widgetLiteral = extractLiteral(src, opts.widgetConfigExport ?? 'widgetConfig');
  if (!widgetLiteral) {
    throw new Error(`Could not find "${opts.widgetConfigExport ?? 'widgetConfig'}" array literal in ${opts.sourceFile}`);
  }
  const planLiteral = opts.planFeaturesExport ? extractLiteral(src, opts.planFeaturesExport) : null;
  const planMap = planLiteral ? parsePlanFeatures(planLiteral) : {};

  const idToPlans = {};
  for (const [plan, ids] of Object.entries(planMap)) {
    for (const id of ids) {
      idToPlans[id] ??= [];
      idToPlans[id].push(plan);
    }
  }

  const incoming = splitTopLevelObjects(widgetLiteral).map((objSrc) => {
    const id = field(objSrc, 'id') ?? field(objSrc, 'slug') ?? 'unknown';
    return {
      slug: id,
      name: field(objSrc, 'title') ?? field(objSrc, 'name') ?? id,
      color: field(objSrc, 'color') ?? '#5169DD',
      icon: identifierField(objSrc, 'icon'),
      tagline: field(objSrc, 'description') ?? field(objSrc, 'tagline') ?? '',
      plans: idToPlans[id] ?? [],
      overview: field(objSrc, 'description') ?? '',
      keyFeatures: [],
      configuration: [],
      storefrontBehavior: '',
      // Hashes the matched widgetConfig object's own source text plus its
      // resolved plans list (so a planFeatures-only change is also
      // detected as a source change even though objSrc itself is unchanged).
      _sourceHash: hashSource(`${objSrc}::${(idToPlans[id] ?? []).join(',')}`),
    };
  });

  const sidecarPath = join(outputPaths.dataDir, 'apps.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });
  overlayAuthored(result.merged, readAuthoredItems(repoRoot, 'apps'), ['overview', 'keyFeatures', 'configuration', 'storefrontBehavior']);

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'apps.ts'),
    `import type { AppDoc } from '../types';\nimport data from './apps.generated.json';\n\nexport const apps = data as unknown as AppDoc[];\n\nexport function getApp(slug: string) {\n  return apps.find((a) => a.slug === slug);\n}\n`
  );

  return { kind: 'appList', ...result, appCount: incoming.length };
}
