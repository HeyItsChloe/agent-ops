/**
 * Model-gateway extractor (agent-ops).
 *
 * Reads the LiteLLM gateway config (litellm/config.yaml) and emits one
 * ModelAliasDoc per `model_list` entry: the alias name every pipeline
 * component addresses, the concrete provider model behind it, the env var
 * holding its key, an optional api_base, and any fallbacks declared under
 * router_settings.fallbacks. Keeps the alias -> model routing in the docs
 * accurate instead of relying on the authored integrations summary.
 *
 * Every value is copied verbatim from the config - never rewritten.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource, stableStringify } from './merge.mjs';

/** "os.environ/GEMINI_API_KEY" -> "GEMINI_API_KEY"; anything else -> ''. */
function envFromApiKey(apiKey) {
  if (typeof apiKey !== 'string') return '';
  const m = /^os\.environ\/(.+)$/.exec(apiKey.trim());
  return m ? m[1] : '';
}

export async function extract({ repoRoot, config, outputPaths }) {
  const opts = config.extractors.models;
  if (!opts?.enabled) return { skipped: true };

  const cfgPath = resolve(repoRoot, opts.configPath ?? 'litellm/config.yaml');
  if (!existsSync(cfgPath)) {
    throw new Error(`extractors.models is enabled but no gateway config at ${cfgPath}`);
  }
  const gateway = parse(readFileSync(cfgPath, 'utf8')) ?? {};
  const modelList = Array.isArray(gateway.model_list) ? gateway.model_list : [];

  // router_settings.fallbacks: [{ implementation: ["implementation-fallback"] }, ...]
  const fallbackMap = {};
  for (const f of gateway.router_settings?.fallbacks ?? []) {
    for (const [alias, targets] of Object.entries(f ?? {})) {
      fallbackMap[alias] = [].concat(targets ?? []);
    }
  }

  const seen = new Map();
  const incoming = modelList.map((entry) => {
    const alias = entry.model_name ?? 'unknown';
    // model_name can legitimately repeat (alternate providers behind one
    // alias); keep slugs unique so the merge key doesn't collide.
    const n = (seen.get(alias) ?? 0) + 1;
    seen.set(alias, n);
    const slug = n === 1 ? alias : `${alias}-${n}`;
    const params = entry.litellm_params ?? {};
    const doc = {
      slug,
      alias,
      model: params.model ?? '',
      apiKeyEnv: envFromApiKey(params.api_key),
      apiBase: params.api_base ?? '',
      fallbacks: fallbackMap[alias] ?? [],
    };
    return { ...doc, _sourceHash: hashSource(stableStringify(doc)) };
  });

  const sidecarPath = join(outputPaths.dataDir, 'models.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'models.ts'),
    `import type { ModelAliasDoc } from '../types';\nimport data from './models.generated.json';\n\nexport const models = data as unknown as ModelAliasDoc[];\n`
  );

  return { kind: 'models', ...result };
}
