/**
 * Extracts EndpointGroup[] from an Express backend (BusyBuddy_v2's
 * web/backend/routes/**\/index.js layout - one router file per feature,
 * mounted under a prefix by a top-level routes/index.js). Deterministic
 * port of .agents/agents/busybuddy-api-spec-generator.md's prose playbook.
 *
 * Writes src/data/endpoints.generated.json + src/data/endpoints.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { globSync } from './glob.mjs';
import { mergeGroupedEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource } from './merge.mjs';

const METHOD_RE = /router\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z0-9_$]+)/g;
// Routes mounted directly on the Express `app` (agent-ops's orchestrator in
// src/index.ts), rather than the router-per-feature + mount-file layout the
// METHOD_RE path handles. Handlers here are middleware/factory *calls*
// (`extensionAuth(...)`, `handleGenerateAnswer({...})`), not bare identifiers,
// so this path derives the title from the route path and auth from the
// middleware named in the statement instead of resolving a controller.
const APP_METHOD_RE = /\bapp\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const MOUNT_RE = /router\.use\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
const IMPORT_RE = /import\s+([A-Za-z0-9_$]+)\s+from\s+["'`](\.[^"'`]+)["'`]/g;

function titleCaseFromSlug(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function slugFromMethodPath(method, routePath) {
  const cleaned = routePath
    .replace(/^\//, '')
    .replace(/:([A-Za-z0-9_]+)\??/g, '$1')
    .replace(/\//g, '-')
    .replace(/-+$/, '');
  return cleaned ? `${method.toLowerCase()}-${cleaned}` : method.toLowerCase();
}

function extractParamsFromPath(routePath) {
  const params = [];
  const re = /:([A-Za-z0-9_]+)(\?)?/g;
  let m;
  while ((m = re.exec(routePath))) {
    params.push({ name: m[1], type: 'string', required: !m[2], description: '', in: 'path' });
  }
  return params;
}

/** Balances braces from `openBraceIndex` (which must point at the function's opening '{') and returns the substring up to (and including) its matching close - so param extraction never leaks into the next handler in the file. */
function sliceFunctionBody(src, openBraceIndex) {
  if (src[openBraceIndex] !== '{') return src.slice(openBraceIndex, openBraceIndex + 4000);
  let depth = 0;
  let inString = null;
  for (let i = openBraceIndex; i < src.length; i++) {
    const ch = src[i];
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
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIndex, i + 1);
    }
  }
  return src.slice(openBraceIndex); // unterminated - fall back to rest of file
}

/** Finds a handler function's full body text (braces-balanced) in a controller file, or '' if not found. */
function findHandlerBody(controllerSrc, handlerName) {
  if (!controllerSrc) return '';
  const fnRe = new RegExp(
    `(?:export\\s+)?(?:const|function)\\s+${handlerName}\\s*=?\\s*(?:async\\s*)?(?:function)?\\s*\\(([^)]*)\\)\\s*(?:=>)?\\s*{`,
    'm'
  );
  const match = fnRe.exec(controllerSrc);
  if (!match) return '';
  return sliceFunctionBody(controllerSrc, match.index + match[0].length - 1); // from the opening '{' matched by fnRe
}

/** Best-effort: scans a controller function body (already isolated by findHandlerBody) for req.body/req.query destructuring. */
function extractParamsFromBody(body) {
  if (!body) return [];
  const params = [];
  const seen = new Set();

  const bodyDestructure = /const\s*{\s*([^}]+)\s*}\s*=\s*req\.body/.exec(body);
  if (bodyDestructure) {
    for (const raw of bodyDestructure[1].split(',')) {
      const name = raw.split(':')[0].split('=')[0].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        params.push({ name, type: 'string', required: true, description: '', in: 'body' });
      }
    }
  }
  const queryDestructure = /const\s*{\s*([^}]+)\s*}\s*=\s*req\.query/.exec(body);
  if (queryDestructure) {
    for (const raw of queryDestructure[1].split(',')) {
      const name = raw.split(':')[0].split('=')[0].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        params.push({ name, type: 'string', required: false, description: '', in: 'query' });
      }
    }
  }
  return params;
}

function detectAuth(routeFileRel, controllerSrc, publicRouteFiles) {
  if (publicRouteFiles.includes(routeFileRel)) {
    return { auth: 'app-proxy', authNote: 'Reachable through the app proxy without an authenticated session.' };
  }
  if (controllerSrc && /hmac|verifyWebhook|createHmac/i.test(controllerSrc)) {
    return { auth: 'none', authNote: 'HMAC-verified webhook - not user-callable directly.' };
  }
  if (controllerSrc && /x-api-key|apiKey/i.test(controllerSrc)) {
    return { auth: 'admin-api-key', authNote: 'Requires an x-api-key header.' };
  }
  return {
    auth: 'session',
    authNote: 'Requires an authenticated session. Supply a bearer/session token in the sandbox before sending.',
  };
}

/** Resolves each route file's mount prefix by reading the top-level mount file's router.use() calls. */
function resolveMountPrefixes(mountFilePath, routesRootDir) {
  if (!existsSync(mountFilePath)) return {};
  const src = readFileSync(mountFilePath, 'utf8');
  const importsByVar = {};
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    importsByVar[m[1]] = resolve(dirname(mountFilePath), m[2]);
  }
  const prefixByFile = {};
  MOUNT_RE.lastIndex = 0;
  while ((m = MOUNT_RE.exec(src))) {
    const [, prefix, varName] = m;
    const target = importsByVar[varName];
    if (!target) continue;
    // import paths omit the .js extension in some repos, and may point at a
    // directory (resolved to its index.js) - normalize both.
    const candidates = [target, `${target}.js`, join(target, 'index.js')];
    for (const c of candidates) {
      prefixByFile[c] = prefix;
    }
  }
  return prefixByFile;
}

/** Builds endpoints from `app.<method>("path", ...middleware, handler)` calls. */
function endpointsFromAppFile(src, relFile, apiPrefix) {
  const endpoints = [];
  APP_METHOD_RE.lastIndex = 0;
  let m;
  while ((m = APP_METHOD_RE.exec(src))) {
    const [, methodLower, routePath] = m;
    const method = methodLower.toUpperCase();
    const stmt = src.slice(m.index, m.index + 600); // enough to see the middleware chain
    let auth = 'none';
    let authNote = 'No authentication middleware detected on this route.';
    if (/extensionAuth/.test(stmt)) {
      auth = 'api-key';
      authNote = 'Requires the Chrome-extension API key in the x-extension-api-key header.';
    } else if (/sharedSecretAuth/.test(stmt)) {
      auth = 'api-key';
      authNote = 'Requires the orchestrator shared secret.';
    }
    const lastSegment = routePath.split('/').filter((s) => s && !s.startsWith(':')).pop() ?? routePath;
    endpoints.push({
      slug: slugFromMethodPath(method, routePath),
      method,
      path: `${apiPrefix}${routePath}`.replace(/\/{2,}/g, '/'),
      title: titleCaseFromSlug(lastSegment),
      description: `Mounted on the Express app in ${relFile}.`,
      auth,
      authNote,
      _sourceHash: hashSource(`${relFile}::${stmt}`),
      params: extractParamsFromPath(routePath),
      responseExample: '{ }',
      liveTestable: false,
      sourceFile: relFile,
    });
  }
  return endpoints;
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.endpointsExpress;
  if (!opts?.enabled) return { skipped: true };

  const globs = opts.routesGlob ?? [];
  const routeFiles = globs.flatMap((g) => globSync(g, { cwd: repoRoot }));
  const mountFile = opts.mountFile ? resolve(repoRoot, opts.mountFile) : null;
  const prefixByFile = mountFile ? resolveMountPrefixes(mountFile, dirname(mountFile)) : {};
  const publicRouteFiles = opts.publicRouteFiles ?? [];
  const controllerDir = opts.controllerDir ? resolve(repoRoot, opts.controllerDir) : null;
  // BusyBuddy_v2-style apps mount routes/index.js's whole router under one
  // more prefix (`app.use("/api", router)`) in their top-level server file
  // (web/index.js), one level up from mountFile's own router.use() calls -
  // that outer prefix isn't visible from mountFile alone, so it's a config
  // value rather than something resolveMountPrefixes() can discover itself.
  const apiPrefix = opts.apiPrefix ?? '';

  const groupsBySlug = new Map();

  for (const relFile of routeFiles) {
    const abs = resolve(repoRoot, relFile);
    const src = readFileSync(abs, 'utf8');
    const prefix = prefixByFile[abs] ?? `/${basename(dirname(abs))}`;
    const groupSlug = basename(dirname(abs))
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();

    // Best-effort controller lookup: same feature-folder name under controllerDir.
    let controllerSrc = '';
    if (controllerDir) {
      const candidate = join(controllerDir, basename(dirname(abs)), 'index.js');
      if (existsSync(candidate)) controllerSrc = readFileSync(candidate, 'utf8');
    }

    const endpoints = [];
    METHOD_RE.lastIndex = 0;
    let m;
    while ((m = METHOD_RE.exec(src))) {
      const [, methodLower, routePath, handlerName] = m;
      const method = methodLower.toUpperCase();
      const fullPath = `${apiPrefix}${prefix}${routePath}`.replace(/\/{2,}/g, '/');
      const pathParams = extractParamsFromPath(routePath);
      const handlerBody = findHandlerBody(controllerSrc, handlerName);
      const bodyQueryParams = extractParamsFromBody(handlerBody);
      const { auth, authNote } = detectAuth(relFile, controllerSrc, publicRouteFiles);

      endpoints.push({
        slug: slugFromMethodPath(method, routePath),
        method,
        path: fullPath,
        title: titleCaseFromSlug(handlerName.replace(/^get|^post|^put|^patch|^delete/i, '') || handlerName),
        description: `Handled by ${handlerName}() in ${relative(repoRoot, controllerDir ? join(controllerDir, basename(dirname(abs)), 'index.js') : abs)}.`,
        auth,
        authNote,
        // Hashes the exact matched router-registration text plus the
        // resolved handler's body (if any) - see merge.mjs's hashSource
        // docstring for why this drives change-detection instead of a full
        // structural diff of the entry.
        _sourceHash: hashSource(`${relFile}::${apiPrefix}${prefix}::${m[0]}::${handlerBody}`),
        params: [...pathParams, ...bodyQueryParams],
        responseExample: '{ }',
        liveTestable: auth === 'app-proxy' || auth === 'none',
        sourceFile: relFile,
      });
    }

    if (endpoints.length === 0) continue;
    groupsBySlug.set(groupSlug, {
      slug: groupSlug,
      title: titleCaseFromSlug(groupSlug),
      description: `Mounted at ${prefix}. Extracted from ${relFile}.`,
      endpoints,
    });
  }

  // app.<method>() files (config: endpointsExpress.appFiles) - one group per
  // configured file, keyed by its declared group slug.
  for (const entry of opts.appFiles ?? []) {
    const abs = resolve(repoRoot, entry.file);
    if (!existsSync(abs)) continue;
    const endpoints = endpointsFromAppFile(readFileSync(abs, 'utf8'), entry.file, entry.apiPrefix ?? '');
    if (endpoints.length === 0) continue;
    const groupSlug = entry.group ?? basename(dirname(abs));
    groupsBySlug.set(groupSlug, {
      slug: groupSlug,
      title: entry.groupTitle ?? titleCaseFromSlug(groupSlug),
      description: entry.groupDescription ?? `Extracted from ${entry.file}.`,
      endpoints,
    });
  }

  const incoming = [...groupsBySlug.values()];
  const sidecarPath = join(outputPaths.dataDir, 'endpoints.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeGroupedEntries(existing, incoming, { childField: 'endpoints' });

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'endpoints.ts'),
    `import type { EndpointGroup } from '../types';\nimport data from './endpoints.generated.json';\n\nexport const endpointGroups = data as unknown as EndpointGroup[];\n\nexport function getGroup(slug: string) {\n  return endpointGroups.find((g) => g.slug === slug);\n}\n`
  );

  return { kind: 'endpointsExpress', ...result, groupCount: incoming.length };
}
