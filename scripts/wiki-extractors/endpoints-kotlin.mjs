/**
 * Extracts EndpointGroup[] from Kotlin Retrofit interfaces (OrderMate's
 * app/src/main/java/com/orderMate/networkManager layout). Deterministic
 * port of ordermate's .agents/agents/api-spec-generator.md prose playbook.
 *
 * Writes src/data/endpoints.generated.json + src/data/endpoints.ts (shares
 * the same output target/shape as endpoints-express.mjs, since a repo only
 * ever enables one of the two backend-language extractors).
 */

import { readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { globSync } from './glob.mjs';
import { mergeGroupedEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource } from './merge.mjs';
import { buildDtoRegistry, exampleJson, unwrapType } from './dto-resolve.mjs';

// Matches an @GET/@POST/@PUT/@DELETE/@PATCH annotation, the following
// `suspend fun name(` signature, and captures the parameter list up to the
// matching close-paren so we can pull @Path/@Query/@Body annotations out of
// it. Kotlin function signatures for Retrofit calls are short enough that a
// bounded, non-greedy multi-line match works reliably in practice.
const ENDPOINT_RE =
  /@(GET|POST|PUT|DELETE|PATCH)\(\s*"([^"]+)"\s*\)\s*\n\s*suspend fun\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*:\s*([^\n{]+)/g;

const PATH_PARAM_RE = /@Path\(\s*"([^"]+)"\s*\)\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>?,\s]+?)(?:,|$)/g;
const QUERY_PARAM_RE = /@Query\(\s*"([^"]+)"\s*\)\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>?,\s]+?)(?:,|$)/g;
const BODY_PARAM_RE = /@Body\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>?,\s]+?)(?:,|$)/g;

const KOTLIN_TO_TS = { String: 'string', Int: 'number', Long: 'number', Double: 'number', Boolean: 'boolean' };

function mapType(kotlinType) {
  const trimmed = kotlinType.trim().replace(/\?$/, '');
  if (trimmed.startsWith('List<')) return `${mapType(trimmed.slice(5, -1))}[]`;
  return KOTLIN_TO_TS[trimmed] ?? trimmed;
}

function titleCaseFromCamel(name) {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced[0].toUpperCase() + spaced.slice(1);
}

function slugFromCamel(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

function groupSlugFromPath(path) {
  // e.g. v3/merchants/{mId}/orders -> "orders" (last static segment).
  const segments = path.split('/').filter((s) => s && !s.startsWith('{'));
  return segments[segments.length - 1] ?? 'general';
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.endpointsKotlin;
  if (!opts?.enabled) return { skipped: true };

  const globs = opts.interfaceGlob ?? [];
  const files = globs.flatMap((g) => globSync(g, { cwd: repoRoot }));

  // DTO registry for real request/response example bodies. Defaults to the
  // whole app source tree; narrow with endpointsKotlin.modelGlobs if needed.
  const modelGlobs = opts.modelGlobs ?? ['app/src/main/**/*.kt'];
  const dtoRegistry = buildDtoRegistry(repoRoot, modelGlobs);

  const groupsBySlug = new Map();

  for (const relFile of files) {
    const abs = resolve(repoRoot, relFile);
    const src = readFileSync(abs, 'utf8');

    ENDPOINT_RE.lastIndex = 0;
    let m;
    while ((m = ENDPOINT_RE.exec(src))) {
      const [, httpMethod, path, fnName, paramList, returnTypeRaw] = m;
      const returnType = (returnTypeRaw ?? '').trim();
      const params = [];

      PATH_PARAM_RE.lastIndex = 0;
      let pm;
      while ((pm = PATH_PARAM_RE.exec(paramList))) {
        params.push({ name: pm[1], type: mapType(pm[3]), required: !pm[3].includes('?'), description: '', in: 'path' });
      }
      QUERY_PARAM_RE.lastIndex = 0;
      while ((pm = QUERY_PARAM_RE.exec(paramList))) {
        params.push({ name: pm[1], type: mapType(pm[3]), required: !pm[3].includes('?'), description: '', in: 'query' });
      }
      let bodyExample;
      BODY_PARAM_RE.lastIndex = 0;
      while ((pm = BODY_PARAM_RE.exec(paramList))) {
        params.push({ name: pm[1], type: mapType(pm[2]), required: !pm[2].includes('?'), description: '', in: 'body' });
        // Resolve the real request DTO into an example body instead of a stub.
        bodyExample = exampleJson(pm[2].trim(), dtoRegistry);
      }

      // Real response example from the (unwrapped) return type; '{ }' only when
      // the type is opaque (e.g. Response<Any>) and can't be resolved.
      const responseExample = exampleJson(returnType, dtoRegistry);
      const returnClean = unwrapType(returnType);
      const returnNote =
        returnClean && !['Any', 'Unit', 'Void', 'ResponseBody'].includes(returnClean) ? ` Returns ${returnClean}.` : '';

      const routePath = `/${path.replace(/{([A-Za-z0-9_]+)}/g, ':$1')}`.replace(/\/{2,}/g, '/');
      const groupSlug = groupSlugFromPath(path);
      const endpoint = {
        slug: slugFromCamel(fnName),
        method: httpMethod,
        path: routePath,
        title: titleCaseFromCamel(fnName),
        description: `${httpMethod} ${routePath} — ${titleCaseFromCamel(fnName)}.${returnNote}`,
        auth: 'bearer',
        authNote: 'Requires a Clover/OrderMate API bearer token. Supply it in the sandbox before sending.',
        params,
        ...(bodyExample ? { requestExample: bodyExample } : {}),
        responseExample,
        liveTestable: true,
        sourceFile: relFile,
        _sourceHash: hashSource(`${relFile}::${m[0]}`),
      };

      if (!groupsBySlug.has(groupSlug)) {
        groupsBySlug.set(groupSlug, {
          slug: groupSlug,
          title: titleCaseFromCamel(groupSlug),
          description: `${titleCaseFromCamel(groupSlug)} endpoints (${basename(abs)}).`,
          endpoints: [],
        });
      }
      groupsBySlug.get(groupSlug).endpoints.push(endpoint);
    }
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

  return { kind: 'endpointsKotlin', ...result, groupCount: incoming.length };
}
