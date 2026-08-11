/**
 * Kotlin DTO resolver (agent-ops issue #286 extension).
 *
 * Builds a registry of `data class` definitions from a repo's model source and
 * turns a type reference into a realistic example JSON skeleton. This is what
 * lets the endpoints extractor emit real request/response bodies (e.g. the
 * fields of a ShareMessageJson request) instead of empty-object placeholders.
 * Fully deterministic — no LLM, no network. Every value is derived from the
 * declared field name/type in source.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from './glob.mjs';

const DATA_CLASS_RE = /data class\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:\{|:|$|\n\s*\n)/g;

/** Splits a constructor param list on top-level commas (generics-aware). */
function splitParams(src) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  if (start < src.length) out.push(src.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Parses one `val \`name\`: Type = default` param into { name, type }. */
function parseField(param) {
  const m = /(?:val|var)?\s*`?([A-Za-z0-9_]+)`?\s*:\s*([^=]+?)\s*(?:=[\s\S]*)?$/.exec(param);
  if (!m) return null;
  return { name: m[1], type: m[2].trim() };
}

/** Registry of type name -> [{ name, type }]. Built once per extract run. */
export function buildDtoRegistry(repoRoot, globs) {
  const registry = new Map();
  const files = (globs ?? []).flatMap((g) => globSync(g, { cwd: repoRoot }));
  for (const rel of files) {
    let src;
    try {
      src = readFileSync(resolve(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    DATA_CLASS_RE.lastIndex = 0;
    let m;
    while ((m = DATA_CLASS_RE.exec(src))) {
      const [, name, body] = m;
      if (registry.has(name)) continue;
      const fields = splitParams(body).map(parseField).filter(Boolean);
      if (fields.length) registry.set(name, fields);
    }
  }
  return registry;
}

/** Unwraps Retrofit/collection wrappers: Response<X> / Call<X> -> X (kept flag for List). */
export function unwrapType(type) {
  let t = (type ?? '').trim().replace(/\?+$/, '');
  const wrappers = ['Response', 'Call', 'Result', 'ApiResponse'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of wrappers) {
      const re = new RegExp(`^${w}<([\\s\\S]+)>$`);
      const mm = re.exec(t);
      if (mm) {
        t = mm[1].trim().replace(/\?+$/, '');
        changed = true;
      }
    }
  }
  return t;
}

const PRIMITIVE_SAMPLE = {
  String: 'string',
  Int: 0,
  Long: 0,
  Short: 0,
  Byte: 0,
  Double: 0,
  Float: 0,
  Boolean: false,
  Char: 'c',
  Any: {},
  Unit: null,
};

/** Produces an example value for a Kotlin type using the DTO registry. */
export function exampleForType(type, registry, depth = 0, seen = new Set()) {
  let t = (type ?? '').trim().replace(/\?+$/, '');
  if (!t || depth > 4) return null;

  const listM = /^(?:List|Array|Set|Collection|MutableList)<([\s\S]+)>$/.exec(t);
  if (listM) return [exampleForType(listM[1], registry, depth + 1, seen)].filter((v) => v !== undefined);

  const mapM = /^(?:Map|HashMap|MutableMap)<\s*([^,]+),\s*([\s\S]+)>$/.exec(t);
  if (mapM) return { key: exampleForType(mapM[2], registry, depth + 1, seen) };

  if (Object.prototype.hasOwnProperty.call(PRIMITIVE_SAMPLE, t)) return PRIMITIVE_SAMPLE[t];

  if (registry.has(t)) {
    if (seen.has(t)) return {}; // cycle guard
    const nextSeen = new Set(seen).add(t);
    const obj = {};
    for (const f of registry.get(t)) {
      obj[f.name] = exampleForType(f.type, registry, depth + 1, nextSeen);
    }
    return obj;
  }

  // Unknown/opaque type (enum, platform type, unresolved) — leave a typed hint.
  return null;
}

/** Convenience: JSON string (2-space) for a type, or a placeholder if unresolved. */
export function exampleJson(type, registry) {
  const resolved = unwrapType(type);
  const val = exampleForType(resolved, registry);
  if (val === null || (typeof val === 'object' && Object.keys(val).length === 0 && !Array.isArray(val))) {
    return `{ /* ${resolved || type || 'unknown'} */ }`;
  }
  return JSON.stringify(val, null, 2);
}
