/**
 * Unit tests for the deterministic wiki metadata layer (agent-ops issue #8,
 * subtask 1a). Run with: node --test tests/metadata.test.mjs
 *
 * These verify the core acceptance criterion: an entity with NO authored
 * frontmatter still gets a correct summary/order/status, while an entity WITH
 * authored values keeps them (authored always overrides derived).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstParagraph,
  clampSummary,
  deriveMetadata,
  assignOrders,
  applyMetadata,
  isAuthored,
} from '../scripts/wiki-extractors/metadata.mjs';

test('firstParagraph skips headings/comments and grabs one paragraph', () => {
  const body = [
    '## What it does',
    '',
    'The upstream sync keeps the fork in step with the canonical repo.',
    'It runs daily and opens a PR on conflict.',
    '',
    '## How it works',
    'irrelevant',
  ].join('\n');
  assert.equal(
    firstParagraph(body),
    'The upstream sync keeps the fork in step with the canonical repo. It runs daily and opens a PR on conflict.'
  );
});

test('firstParagraph strips inline markdown', () => {
  const body = '# Title\n\nUses **bold**, `code`, and [a link](https://x.y) inline.';
  assert.equal(firstParagraph(body), 'Uses bold, code, and a link inline.');
});

test('firstParagraph returns empty for heading-only / empty body', () => {
  assert.equal(firstParagraph('## Only a heading'), '');
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph(undefined), '');
});

test('clampSummary caps at word boundary with ellipsis', () => {
  const long = 'word '.repeat(60).trim(); // 300 chars
  const out = clampSummary(long, 40);
  assert.ok(out.length <= 41, `expected <=41, got ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('  '));
});

test('clampSummary leaves short strings unchanged', () => {
  assert.equal(clampSummary('short summary', 160), 'short summary');
});

test('isAuthored distinguishes present vs missing/empty', () => {
  assert.equal(isAuthored('hi'), true);
  assert.equal(isAuthored(0), true);
  assert.equal(isAuthored(3), true);
  assert.equal(isAuthored(''), false);
  assert.equal(isAuthored('   '), false);
  assert.equal(isAuthored(undefined), false);
  assert.equal(isAuthored(null), false);
});

test('deriveMetadata: NO frontmatter -> summary from body, default status', () => {
  const entity = {
    slug: 'upstream-sync',
    title: 'Upstream Sync',
    // no summary, no order, no status
    body: '## What it does\n\nDaily fork sync that opens a PR when a merge conflicts.',
  };
  const meta = deriveMetadata(entity);
  assert.equal(meta.summary, 'Daily fork sync that opens a PR when a merge conflicts.');
  assert.equal(meta.status, 'stable');
  assert.equal(meta.order, undefined); // resolved across the set by assignOrders
});

test('deriveMetadata: falls back to description then title', () => {
  const fromDesc = deriveMetadata({ slug: 'x', title: 'X', description: 'From description.' });
  assert.equal(fromDesc.summary, 'From description.');

  const fromTitle = deriveMetadata({ slug: 'y', title: 'Y Feature' });
  assert.equal(fromTitle.summary, 'Y Feature');
});

test('deriveMetadata: authored summary/status OVERRIDE derived', () => {
  const entity = {
    slug: 'wiki-generator',
    title: 'Wiki Generator',
    summary: 'Hand-authored summary wins.',
    status: 'beta',
    body: '## What it does\n\nThis body should be ignored for the summary.',
  };
  const meta = deriveMetadata(entity);
  assert.equal(meta.summary, 'Hand-authored summary wins.');
  assert.equal(meta.status, 'beta');
});

test('deriveMetadata: defaultStatus is overridable via ctx', () => {
  const meta = deriveMetadata({ slug: 'z', title: 'Z' }, { defaultStatus: 'experimental' });
  assert.equal(meta.status, 'experimental');
});

test('assignOrders: authored orders preserved, un-authored appended stably', () => {
  const entities = [
    { slug: 'b-feature', title: 'B Feature' }, // no order
    { slug: 'authored', title: 'Authored', order: 1 }, // authored
    { slug: 'a-feature', title: 'A Feature' }, // no order
  ];
  const out = assignOrders(entities);
  const bySlug = Object.fromEntries(out.map((e) => [e.slug, e.order]));
  assert.equal(bySlug['authored'], 1); // preserved
  // un-authored sorted by title (A before B), appended after max authored (1)
  assert.equal(bySlug['a-feature'], 2);
  assert.equal(bySlug['b-feature'], 3);
});

test('assignOrders: stable / idempotent across re-runs', () => {
  const entities = [
    { slug: 'c', title: 'C' },
    { slug: 'a', title: 'A' },
    { slug: 'b', title: 'B' },
  ];
  const first = assignOrders(entities).map((e) => [e.slug, e.order]);
  const second = assignOrders(entities).map((e) => [e.slug, e.order]);
  assert.deepEqual(first, second);
  // deterministic: A=1, B=2, C=3
  assert.deepEqual(Object.fromEntries(first), { a: 1, b: 2, c: 3 });
});

test('applyMetadata: mixed authored + unauthored set end-to-end', () => {
  const entities = [
    {
      slug: 'authored-feature',
      title: 'Authored Feature',
      summary: 'Authored.',
      order: 1,
      status: 'stable',
      body: 'ignored',
    },
    {
      slug: 'new-feature',
      title: 'New Feature',
      // fully un-authored metadata
      body: '## What it does\n\nA freshly added feature with no frontmatter at all.',
    },
  ];
  const out = applyMetadata(entities);
  const authored = out.find((e) => e.slug === 'authored-feature');
  const derived = out.find((e) => e.slug === 'new-feature');

  // authored untouched
  assert.equal(authored.summary, 'Authored.');
  assert.equal(authored.order, 1);
  assert.equal(authored.status, 'stable');

  // derived filled in
  assert.equal(derived.summary, 'A freshly added feature with no frontmatter at all.');
  assert.equal(derived.status, 'stable');
  assert.equal(derived.order, 2); // after the authored order 1
});
