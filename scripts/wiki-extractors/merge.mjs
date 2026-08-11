/**
 * Shared idempotent merge helper used by every extractor in this directory.
 *
 * Design (issue #286 "additive not recreated" requirement):
 *   - Each extractor's target data file has a JSON "source of truth" sidecar
 *     (`<name>.generated.json`) plus a thin, deterministically-regenerated
 *     TypeScript wrapper (`<name>.ts`) that imports the JSON and re-exports
 *     it typed (`... as EndpointGroup[]`). The wrapper is boilerplate and
 *     always fully rewritten; the JSON is the only thing this module's
 *     merge logic actually reasons about, because diffing/merging plain
 *     JSON arrays is trivial and robust, whereas hand-rolling a JS/TS AST
 *     merge (to safely patch literal object arrays in a real .ts file
 *     in-place) is not something we can get right without adding a real
 *     parser dependency. This keeps the merge step itself dependency-free
 *     and easy to verify.
 *   - mergeEntries() never removes an existing entry, even if its source
 *     has since disappeared (e.g. a route was deleted) - stale entries are
 *     left exactly as they were. This is deliberate per the issue: docs
 *     content is additive, not regenerated from scratch every run.
 *   - An existing entry is only replaced when its *content* actually
 *     differs from the freshly-extracted version (structural deep-equal on
 *     the JSON-serializable object, independent of key order) - otherwise
 *     it is left byte-for-byte alone, so unrelated runs produce zero diff.
 *   - New entries (by key) are appended at the end, in extractor-provided
 *     order, so unrelated re-runs don't reorder unrelated content.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

/**
 * Authored-prose overlay (issue #286, approach A — generalized to all kinds).
 *
 * Facts are machine-extracted; prose (summaries, descriptions, curated lists)
 * is authored — automatically drafted by scripts/wiki-author.mjs into a
 * committed `wiki-content/authored/<kind>.yaml` manifest, then overlaid here
 * onto the fact-extracted entries by slug. Applied on every run after merge, so
 * authored prose always takes effect and always survives re-extraction. The
 * generator itself calls no LLM — wiki-author does the drafting; this only
 * reads committed content.
 */
export function readAuthoredItems(repoRoot, kind) {
  const path = join(repoRoot, 'wiki-content', 'authored', `${kind}.yaml`);
  if (!existsSync(path)) return new Map();
  const doc = parseYaml(readFileSync(path, 'utf8')) ?? {};
  const items = Array.isArray(doc) ? doc : doc.items ?? [];
  return new Map(items.filter((it) => it && it.slug).map((it) => [it.slug, it]));
}

/** Overlays the listed prose fields from an authored manifest onto entries, by slug. */
export function overlayAuthored(entries, authoredMap, fields) {
  if (!authoredMap || authoredMap.size === 0) return entries;
  for (const e of entries) {
    const a = authoredMap.get(e.slug);
    if (!a) continue;
    for (const f of fields) {
      if (a[f] !== undefined && a[f] !== null && a[f] !== '') e[f] = a[f];
    }
  }
  return entries;
}

/**
 * Every extractor should stamp each entry it emits with `_sourceHash`, a
 * hash of the exact source text the entry was derived from (a matched
 * route-registration line + its controller function body, a whole workflow
 * YAML file's bytes, a matched Kotlin @GET/@POST block, ...). mergeEntries()
 * below then keys "has this entry's source actually changed" off that hash
 * instead of a full structural diff of the entry object - which is what
 * makes hand-editing a stored entry between generator runs safe (a human
 * edit changes the entry's *content* but not its *source*, so the next run
 * correctly leaves it alone instead of clobbering the edit with a fresh,
 * unedited re-extraction). `_sourceHash` is metadata only - it's not part
 * of any of the public TypeScript types in src/types, and the generated .ts
 * wrappers cast straight past it (`as unknown as X[]`).
 */
export function hashSource(text) {
  return createHash('sha1').update(text).digest('hex');
}

/** Deterministic stringify: recursively sorts object keys so key-order
 * differences never register as a content change. */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Merge freshly-extracted entries into a previously-persisted array.
 *
 * @param {any[]} existing - array read from the `.generated.json` sidecar (empty array if the file didn't exist yet).
 * @param {any[]} incoming - freshly-extracted entries for this run.
 * @param {{ key?: string }} [opts] - `key` is the field used to identify "the same entry" across runs (default: 'slug').
 * @returns {{ merged: any[], added: string[], updated: string[], unchanged: string[], stale: string[] }}
 */
export function mergeEntries(existing, incoming, opts = {}) {
  const keyField = opts.key ?? 'slug';
  const existingByKey = new Map(existing.map((e) => [e[keyField], e]));
  const incomingKeys = new Set(incoming.map((e) => e[keyField]));

  const added = [];
  const updated = [];
  const unchanged = [];
  const merged = existing.map((e) => e); // preserve original order/objects by default

  for (const inc of incoming) {
    const k = inc[keyField];
    if (!existingByKey.has(k)) {
      merged.push(inc);
      added.push(k);
      continue;
    }
    const prev = existingByKey.get(k);
    // Prefer comparing by _sourceHash (has the underlying source actually
    // changed?) over a full structural diff (has the *entry* changed?) -
    // see the module docstring above. Falls back to a structural diff for
    // extractors/entries that don't set _sourceHash.
    const same =
      prev._sourceHash !== undefined && inc._sourceHash !== undefined
        ? prev._sourceHash === inc._sourceHash
        : stableStringify(prev) === stableStringify(inc);
    if (same) {
      unchanged.push(k);
      continue;
    }
    const idx = merged.findIndex((e) => e[keyField] === k);
    merged[idx] = inc;
    updated.push(k);
  }

  const stale = existing.map((e) => e[keyField]).filter((k) => !incomingKeys.has(k));

  return { merged, added, updated, unchanged, stale };
}

/**
 * Merge nested "group" structures (e.g. EndpointGroup[] each holding an
 * `endpoints` array) where the additive/never-remove rule must apply at the
 * leaf-entry level (endpoints), not just at the group level. Groups
 * themselves follow the same add/update/never-remove rule via `key`; each
 * group's `childField` array is merged with mergeEntries() using `childKey`.
 */
export function mergeGroupedEntries(existing, incoming, { key = 'slug', childField, childKey = 'slug' } = {}) {
  const existingByKey = new Map(existing.map((g) => [g[key], g]));
  const incomingKeys = new Set(incoming.map((g) => g[key]));
  const merged = existing.map((g) => g);
  const report = { added: [], updated: [], unchanged: [], stale: [] };

  for (const incGroup of incoming) {
    const k = incGroup[key];
    if (!existingByKey.has(k)) {
      merged.push(incGroup);
      report.added.push(k);
      continue;
    }
    const prevGroup = existingByKey.get(k);
    const childResult = mergeEntries(prevGroup[childField] ?? [], incGroup[childField] ?? [], { key: childKey });
    const mergedGroup = { ...incGroup, [childField]: childResult.merged };
    // Group metadata (title/description) is taken from the fresh extraction
    // (cheap to keep accurate), only the child array follows the strict
    // additive rule.
    const idx = merged.findIndex((g) => g[key] === k);
    merged[idx] = mergedGroup;
    if (
      childResult.added.length ||
      childResult.updated.length ||
      stableStringify({ ...prevGroup, [childField]: undefined }) !== stableStringify({ ...incGroup, [childField]: undefined })
    ) {
      report.updated.push(k);
    } else {
      report.unchanged.push(k);
    }
    report.added.push(...childResult.added.map((c) => `${k}/${c}`));
    report.updated.push(...childResult.updated.map((c) => `${k}/${c}`));
  }

  report.stale = existing.map((g) => g[key]).filter((k) => !incomingKeys.has(k));

  return { merged, ...report };
}

/** Reads a JSON sidecar, returning `fallback` (default: []) if it doesn't exist yet. */
export function readJsonSidecar(path, fallback = []) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse existing sidecar ${path} as JSON: ${err.message}`);
  }
}

/** Writes the JSON sidecar (stable 2-space formatting) creating parent dirs as needed. */
export function writeJsonSidecar(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Writes the thin, always-fully-regenerated TypeScript wrapper around a
 * JSON sidecar. `body` is the full file body (imports + exports); this
 * just prepends the standard "do not hand edit" banner.
 */
export function writeGeneratedTsWrapper(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const banner =
    '// AUTO-GENERATED by scripts/wiki-generate.mjs - do not hand-edit.\n' +
    '// Source of truth is the adjacent .generated.json sidecar, which IS safe\n' +
    '// (and expected) to be hand-edited between generator runs - the merge\n' +
    '// logic in scripts/wiki-extractors/merge.mjs never overwrites or removes\n' +
    '// entries whose extracted source content has not changed.\n\n';
  writeFileSync(path, banner + body, 'utf8');
}
