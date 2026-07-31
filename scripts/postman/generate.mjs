#!/usr/bin/env node
/**
 * Postman Collection (v2.1) generator (agent-ops issue #12).
 *
 * Produces a schema-valid Postman v2.1 collection for an API from one of two
 * config-driven sources:
 *
 *   1. `spec`       - an OpenAPI/Swagger document (json/yaml), converted with
 *                     the maintained `openapi-to-postmanv2` library. Preferred
 *                     whenever a spec exists; we never hand-roll OpenAPI->Postman.
 *
 *   2. `extractors` - the endpoint inventory the wiki generator already emits
 *                     (scripts/wiki-extractors/endpoints-express.mjs /
 *                     endpoints-kotlin.mjs write `endpoints.generated.json`,
 *                     an EndpointGroup[]). Used when a repo has no OpenAPI spec
 *                     but does inventory its routes for the wiki - so the two
 *                     stay in sync from a single source of truth.
 *
 * DETERMINISM: openapi-to-postmanv2 stamps fresh random UUIDs on every run and
 * does not guarantee stable ordering, which would make the committed collection
 * churn on every CI run even when the API is unchanged. We therefore normalize
 * the generated collection into a canonical form:
 *   - every `id`/`_postman_id` is replaced with a deterministic id derived from
 *     the item's stable identity (method + url + name path), via sha1;
 *   - items within each folder are sorted by (method, url, name);
 *   - top-level `info._postman_id` is derived from the collection name.
 * The result is byte-stable for an unchanged API, so `git diff` is empty unless
 * an endpoint actually changed - which is exactly how the workflow detects
 * "new/changed endpoints" (a non-empty diff) and commits back.
 *
 * Usage:
 *   node scripts/postman/generate.mjs \
 *     --repo-root /path/to/target-repo \
 *     [--source spec|extractors] \
 *     [--spec-path openapi.json]           # relative to --repo-root, source=spec
 *     [--endpoint-source docs/src/data/endpoints.generated.json] # source=extractors
 *     [--output postman/collection.json]   # relative to --repo-root
 *     [--name "My API"]                    # collection name override
 *
 * Environment variable equivalents (used by the reusable workflow):
 *   PM_REPO_ROOT, PM_SOURCE, PM_SPEC_PATH, PM_ENDPOINT_SOURCE, PM_OUTPUT, PM_NAME
 *
 * Config file: if --repo-root contains `postman.config.json`, its keys
 * (source, specPath, endpointSource, output, name) are used as defaults; CLI
 * flags and env vars override them. This keeps per-repo settings versioned in
 * the target repo, matching the wiki generator's wiki.config.yaml convention.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import openApiToPostman from 'openapi-to-postmanv2';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// arg / config plumbing
// ---------------------------------------------------------------------------

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

/** Merge (lowest->highest precedence): postman.config.json < env < CLI flags. */
export function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args['repo-root'] || env.PM_REPO_ROOT || process.cwd());

  let fileConfig = {};
  const configPath = join(repoRoot, 'postman.config.json');
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${configPath}: ${err.message}`);
    }
  }

  const source =
    args.source || env.PM_SOURCE || fileConfig.source || (specPathCandidate() ? 'spec' : 'extractors');

  function specPathCandidate() {
    return args['spec-path'] || env.PM_SPEC_PATH || fileConfig.specPath;
  }

  return {
    repoRoot,
    source,
    specPath: args['spec-path'] || env.PM_SPEC_PATH || fileConfig.specPath || null,
    endpointSource:
      args['endpoint-source'] ||
      env.PM_ENDPOINT_SOURCE ||
      fileConfig.endpointSource ||
      'docs/src/data/endpoints.generated.json',
    output: args.output || env.PM_OUTPUT || fileConfig.output || 'postman/collection.json',
    name: args.name || env.PM_NAME || fileConfig.name || null,
  };
}

// ---------------------------------------------------------------------------
// determinism helpers
// ---------------------------------------------------------------------------

function deterministicId(...parts) {
  return createHash('sha1').update(parts.join('::')).digest('hex').slice(0, 32);
}

/** Render a request item's canonical url string for sorting/id purposes. */
function urlString(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (typeof url.raw === 'string') return url.raw;
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const path = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
  return `${host}/${path}`;
}

function itemSortKey(item) {
  const method = item.request?.method || (item.item ? '' : 'ZZZ');
  const url = urlString(item.request?.url);
  return `${method}\u0000${url}\u0000${item.name || ''}`;
}

/**
 * Walk the item tree, assigning deterministic ids keyed on each item's stable
 * identity path (folder names + method + url), and sort siblings. Mutates in
 * place and returns the array.
 */
function canonicalizeItems(items, prefix = '') {
  if (!Array.isArray(items)) return items;
  for (const item of items) {
    const idBasis =
      item.request != null
        ? `${prefix}/${item.name}\u0000${item.request.method}\u0000${urlString(item.request.url)}`
        : `${prefix}/${item.name}`;
    item.id = deterministicId(idBasis);
    // Response examples (openapi-to-postmanv2 stamps random UUIDs on each) get
    // deterministic ids keyed off the owning request's identity + response name.
    if (Array.isArray(item.response)) {
      item.response.forEach((resp, i) => {
        if (resp && typeof resp === 'object') {
          resp.id = deterministicId('response', idBasis, resp.name || '', String(i));
        }
      });
    }
    if (Array.isArray(item.item)) {
      canonicalizeItems(item.item, `${prefix}/${item.name}`);
    }
  }
  items.sort((a, b) => itemSortKey(a).localeCompare(itemSortKey(b)));
  return items;
}

/** Produce a byte-stable collection: canonical ids, sorted items, stable info id. */
export function canonicalizeCollection(collection, { name } = {}) {
  const c = collection.collection ? collection.collection : collection;
  c.info = c.info || {};
  if (name) c.info.name = name;
  c.info.schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  c.info._postman_id = deterministicId('collection', c.info.name || 'api');
  // drop any nondeterministic generator-stamped fields
  delete c.info._postman_exporter_id;
  if (Array.isArray(c.item)) canonicalizeItems(c.item);
  return c;
}

// ---------------------------------------------------------------------------
// source: OpenAPI/Swagger spec
// ---------------------------------------------------------------------------

function readSpec(specAbsPath) {
  const raw = readFileSync(specAbsPath, 'utf8');
  const ext = extname(specAbsPath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    // openapi-to-postmanv2 accepts a raw string; hand it the original YAML text.
    return { type: 'string', data: raw };
  }
  // json (or unknown -> assume json). Validate it parses so we fail loudly.
  JSON.parse(raw);
  return { type: 'string', data: raw };
}

function convertSpec(specAbsPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const input = readSpec(specAbsPath);
    openApiToPostman.convert(
      input,
      {
        // deterministic-friendly options: keep folder structure, no example
        // randomization beyond what we canonicalize away afterwards.
        folderStrategy: 'Tags',
        requestParametersResolution: 'Schema',
        exampleParametersResolution: 'Schema',
      },
      (err, result) => {
        if (err) return rejectPromise(err);
        if (!result || !result.result) {
          return rejectPromise(new Error(`OpenAPI conversion failed: ${result?.reason || 'unknown reason'}`));
        }
        const output = (result.output || []).find((o) => o.type === 'collection');
        if (!output) return rejectPromise(new Error('OpenAPI conversion produced no collection output.'));
        resolvePromise(output.data);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// source: endpoint-extractor inventory (EndpointGroup[])
// ---------------------------------------------------------------------------

function methodHasBody(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

/** Convert a path like /api/foo/:id (or {id}) into Postman url path segments + variables. */
function toPostmanUrl(path) {
  const clean = path.split('?')[0];
  const segments = clean.split('/').filter(Boolean);
  const variable = [];
  const pathSegments = segments.map((seg) => {
    let m = seg.match(/^:([A-Za-z0-9_]+)$/) || seg.match(/^\{([A-Za-z0-9_]+)\}$/);
    if (m) {
      variable.push({ key: m[1], value: `<${m[1]}>` });
      return `:${m[1]}`;
    }
    return seg;
  });
  return {
    raw: `{{baseUrl}}/${pathSegments.join('/')}`,
    host: ['{{baseUrl}}'],
    path: pathSegments,
    ...(variable.length ? { variable } : {}),
  };
}

function endpointToItem(ep) {
  const method = (ep.method || 'GET').toUpperCase();
  const url = toPostmanUrl(ep.path || '/');
  const params = Array.isArray(ep.params) ? ep.params : [];

  const queryParams = params.filter((p) => p.in === 'query');
  if (queryParams.length) {
    url.query = queryParams.map((p) => ({
      key: p.name,
      value: '',
      description: p.required ? '(required) ' + (p.description || '') : p.description || '',
      disabled: !p.required,
    }));
    url.raw = `${url.raw}?${queryParams.map((p) => `${p.name}=`).join('&')}`;
  }

  const bodyParams = params.filter((p) => p.in === 'body');
  const request = {
    method,
    header: [],
    url,
    ...(ep.description ? { description: ep.description } : {}),
  };

  if (methodHasBody(method) && (bodyParams.length || ep.requestExample)) {
    let bodyObj = {};
    for (const p of bodyParams) bodyObj[p.name] = typeToPlaceholder(p.type);
    const bodyJson = bodyParams.length ? JSON.stringify(bodyObj, null, 2) : ep.requestExample || '{}';
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: bodyJson, options: { raw: { language: 'json' } } };
  }

  return {
    name: ep.title || `${method} ${ep.path}`,
    request,
    response: [],
  };
}

function typeToPlaceholder(type) {
  switch ((type || 'string').toLowerCase()) {
    case 'number':
    case 'int':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      if ((type || '').endsWith('[]')) return [];
      return '';
  }
}

function collectionFromEndpoints(groups, name) {
  const items = (Array.isArray(groups) ? groups : []).map((group) => ({
    name: group.title || group.slug || 'Endpoints',
    ...(group.description ? { description: group.description } : {}),
    item: (group.endpoints || []).map(endpointToItem),
  }));
  return {
    info: {
      name: name || 'API Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
    variable: [{ key: 'baseUrl', value: 'http://localhost', type: 'string' }],
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function generate(config) {
  let collection;
  let usedSource;

  if (config.source === 'spec') {
    if (!config.specPath) throw new Error('source=spec requires spec_path (--spec-path / PM_SPEC_PATH / postman.config.json specPath).');
    const specAbs = resolve(config.repoRoot, config.specPath);
    if (!existsSync(specAbs)) throw new Error(`OpenAPI/Swagger spec not found at ${specAbs}.`);
    collection = await convertSpec(specAbs);
    usedSource = `spec:${config.specPath}`;
  } else if (config.source === 'extractors') {
    const epAbs = resolve(config.repoRoot, config.endpointSource);
    if (!existsSync(epAbs)) {
      throw new Error(
        `endpoint source not found at ${epAbs}. Run the wiki endpoint extractor first, or set source=spec with a spec_path.`
      );
    }
    const groups = JSON.parse(readFileSync(epAbs, 'utf8'));
    collection = collectionFromEndpoints(groups, config.name || deriveName(config));
    usedSource = `extractors:${config.endpointSource}`;
  } else {
    throw new Error(`Unknown source "${config.source}" (expected "spec" or "extractors").`);
  }

  const canonical = canonicalizeCollection(collection, { name: config.name || undefined });
  const outputAbs = resolve(config.repoRoot, config.output);
  mkdirSync(dirname(outputAbs), { recursive: true });
  // trailing newline + 2-space indent, stable key order comes from our
  // canonicalization + object construction above.
  writeFileSync(outputAbs, JSON.stringify(canonical, null, 2) + '\n');

  return { collection: canonical, outputAbs, usedSource };
}

function deriveName(config) {
  return basename(config.repoRoot) + ' API';
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = resolveConfig();
  generate(config)
    .then(({ outputAbs, usedSource, collection }) => {
      const count = countRequests(collection.item);
      console.log(`[postman:generate] source=${usedSource}`);
      console.log(`[postman:generate] wrote ${outputAbs} (${count} request(s))`);
    })
    .catch((err) => {
      console.error(`[postman:generate] ERROR: ${err.message}`);
      process.exit(1);
    });
}

export function countRequests(items) {
  let n = 0;
  for (const item of items || []) {
    if (item.request) n++;
    if (Array.isArray(item.item)) n += countRequests(item.item);
  }
  return n;
}
