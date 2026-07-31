/**
 * Deterministic wiki metadata derivation (agent-ops issue #8, subtask 1a).
 *
 * Problem this solves
 * -------------------
 * The `features` extractor (features.mjs) reads `summary`, `order`, and
 * `status` straight out of each page's hand-authored YAML frontmatter and
 * falls back to fixed placeholders (`summary: ''`, `order: 999`,
 * `status: 'stable'`) when a field is absent. That means a *new* feature
 * page can never appear in the wiki with a sensible summary/order/status
 * unless a human first writes the frontmatter (or someone remembers to flip
 * `author_content: true` so the LLM authoring path drafts it). This module
 * removes that manual step: it derives every required piece of metadata
 * deterministically from the entity's own content, with **no LLM and no
 * network**, so a page shows up correctly with zero hand authoring — while
 * any field the human *did* author still wins.
 *
 * Contract
 * --------
 * `deriveMetadata(entity, ctx)` returns `{ summary, order, status }` where:
 *   - Each field is taken from the entity's authored frontmatter when that
 *     field is *explicitly present and non-empty*; otherwise it is derived.
 *   - `summary` derivation order: authored `summary` -> entity `description`
 *     -> first non-heading paragraph of the markdown body -> the title.
 *     Always trimmed and length-capped (default 160 chars, matching the
 *     wiki-author frontmatter contract) on a word boundary.
 *   - `order` derivation: authored numeric `order` wins. Otherwise a stable
 *     order is assigned from the entity's position in a caller-provided
 *     deterministic sort (see `assignOrders`), starting after any explicitly
 *     authored orders so authored pages keep their intended placement.
 *   - `status` derivation: authored `status` wins; otherwise a sensible
 *     default ('stable') — overridable via `ctx.defaultStatus`.
 *
 * `assignOrders(entities, ctx)` returns a new array of the same entities,
 * each with a resolved numeric `order`, applying the rule above across the
 * whole set so ordering is stable and collision-free:
 *   - Entities with an authored numeric order keep it.
 *   - Entities without one are sorted deterministically (by authored/derived
 *     title, then slug) and appended after the highest authored order, in
 *     steps of 1, so re-runs are byte-stable and don't reshuffle authored
 *     pages.
 *
 * Everything here is pure and dependency-free so it is trivial to unit-test
 * (see tests/metadata.test.mjs) and safe to call from any extractor.
 */

const DEFAULT_SUMMARY_MAX = 160;
const DEFAULT_STATUS = 'stable';

/** True when a frontmatter value counts as "authored" (present + meaningful). */
export function isAuthored(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/**
 * First non-empty, non-heading paragraph of a markdown body. Skips ATX
 * headings (`## ...`), HTML comments, and blank lines; stops at the first
 * blank line after content starts, so we grab one paragraph, not the whole
 * document. Inline markdown emphasis/links are stripped to plain text.
 */
export function firstParagraph(body) {
  if (!body || typeof body !== 'string') return '';
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const collected = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (collected.length === 0) {
      // Still looking for the start of the first real paragraph.
      if (line === '') continue;
      if (line.startsWith('#')) continue; // heading
      if (line.startsWith('<!--')) continue; // html comment
      if (line.startsWith('---')) continue; // stray hr / frontmatter fence
      collected.push(line);
    } else {
      if (line === '') break; // paragraph ended
      if (line.startsWith('#')) break; // next heading ends it
      collected.push(line);
    }
  }
  return stripInlineMarkdown(collected.join(' ')).trim();
}

/** Strips common inline markdown so a derived summary reads as plain prose. */
export function stripInlineMarkdown(text) {
  return String(text)
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim a string to at most `max` chars on a word boundary, appending an
 * ellipsis when truncated. Deterministic and pure.
 */
export function clampSummary(text, max = DEFAULT_SUMMARY_MAX) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:]+$/, '') + '…';
}

/**
 * Derive a single entity's summary/order/status without mutating input.
 * Authored (frontmatter) values always override derived ones.
 *
 * @param {object} entity - { slug, title, summary?, order?, status?, description?, body? }
 * @param {object} [ctx]  - { summaryMax?, defaultStatus? }
 * @returns {{ summary: string, order: number|undefined, status: string }}
 */
export function deriveMetadata(entity = {}, ctx = {}) {
  const summaryMax = ctx.summaryMax ?? DEFAULT_SUMMARY_MAX;
  const defaultStatus = ctx.defaultStatus ?? DEFAULT_STATUS;

  // --- summary ---
  let summary;
  if (isAuthored(entity.summary)) {
    summary = clampSummary(entity.summary, summaryMax);
  } else if (isAuthored(entity.description)) {
    summary = clampSummary(entity.description, summaryMax);
  } else {
    const para = firstParagraph(entity.body);
    if (para) {
      summary = clampSummary(para, summaryMax);
    } else if (isAuthored(entity.title)) {
      summary = clampSummary(entity.title, summaryMax);
    } else {
      summary = clampSummary(entity.slug ?? '', summaryMax);
    }
  }

  // --- order --- (authored numeric wins; otherwise left undefined here and
  // resolved across the whole set by assignOrders()).
  const order = isAuthored(entity.order) && typeof entity.order === 'number' ? entity.order : undefined;

  // --- status ---
  const status = isAuthored(entity.status) ? String(entity.status) : defaultStatus;

  return { summary, order, status };
}

/**
 * Resolve a stable numeric `order` for every entity in a set.
 *
 * Authored orders are preserved verbatim. Un-authored entities are sorted
 * deterministically (title, then slug) and appended after the highest
 * authored order, so:
 *   - authored pages keep their intended placement,
 *   - un-authored pages get a stable, collision-free order,
 *   - re-running the generator produces zero churn.
 *
 * @param {object[]} entities - each may carry an authored numeric `order`.
 * @param {object} [ctx]
 * @returns {object[]} new array; each entity gets a resolved numeric `order`.
 */
export function assignOrders(entities = [], ctx = {}) {
  const withAuthored = [];
  const withoutAuthored = [];
  for (const e of entities) {
    if (isAuthored(e.order) && typeof e.order === 'number') withAuthored.push(e);
    else withoutAuthored.push(e);
  }

  const maxAuthored = withAuthored.reduce((m, e) => Math.max(m, e.order), 0);

  const sortedUnauthored = withoutAuthored
    .slice()
    .sort((a, b) => {
      const at = String(a.title ?? a.slug ?? '');
      const bt = String(b.title ?? b.slug ?? '');
      if (at !== bt) return at.localeCompare(bt);
      return String(a.slug ?? '').localeCompare(String(b.slug ?? ''));
    });

  let next = maxAuthored + 1;
  const derivedOrderBySlug = new Map();
  for (const e of sortedUnauthored) {
    derivedOrderBySlug.set(e.slug, next++);
  }

  return entities.map((e) => {
    if (isAuthored(e.order) && typeof e.order === 'number') return { ...e, order: e.order };
    return { ...e, order: derivedOrderBySlug.get(e.slug) };
  });
}

/**
 * Convenience: apply full deterministic metadata (summary/status per entity
 * + stable order across the set) to a list of raw entities. Authored fields
 * always override. Returns a new array; inputs are not mutated.
 *
 * @param {object[]} entities
 * @param {object} [ctx]
 * @returns {object[]}
 */
export function applyMetadata(entities = [], ctx = {}) {
  const perEntity = entities.map((e) => {
    const { summary, status } = deriveMetadata(e, ctx);
    return { ...e, summary, status };
  });
  return assignOrders(perEntity, ctx);
}
