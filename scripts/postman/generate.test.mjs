/**
 * node --test suite for the Postman collection generator (agent-ops issue #12).
 *
 * Runs generate() on both source modes (an OpenAPI fixture and an
 * endpoint-extractor fixture) into a temp dir, then asserts each output is a
 * schema-valid Postman v2.1 collection and that generation is deterministic
 * (byte-identical across two runs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, canonicalizeCollection, countRequests } from './generate.mjs';
import { validateCollection } from './validate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '__fixtures__');

function freshRepo() {
  return mkdtempSync(join(tmpdir(), 'pm-gen-'));
}

test('spec source: generates a valid, deterministic Postman v2.1 collection', async () => {
  const repoRoot = freshRepo();
  cpSync(join(FIX, 'petstore.openapi.json'), join(repoRoot, 'openapi.json'));

  const config = {
    repoRoot,
    source: 'spec',
    specPath: 'openapi.json',
    endpointSource: '',
    output: 'postman/collection.json',
    name: 'Tiny Petstore',
  };

  const first = await generate(config);
  assert.ok(existsSync(first.outputAbs), 'collection file was written');

  const collection = JSON.parse(readFileSync(first.outputAbs, 'utf8'));
  const { valid, errors } = validateCollection(collection);
  assert.equal(valid, true, 'collection is schema-valid v2.1: ' + JSON.stringify(errors.slice(0, 5)));
  assert.equal(
    collection.info.schema,
    'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  );
  assert.ok(countRequests(collection.item) >= 3, 'at least 3 requests extracted from the spec');

  // determinism: a second run produces byte-identical output.
  const before = readFileSync(first.outputAbs, 'utf8');
  await generate(config);
  const after = readFileSync(first.outputAbs, 'utf8');
  assert.equal(after, before, 'generation is deterministic (byte-identical across runs)');
});

test('extractors source: generates a valid Postman v2.1 collection from endpoint inventory', async () => {
  const repoRoot = freshRepo();
  const dataDir = join(repoRoot, 'docs', 'src', 'data');
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(FIX, 'endpoints.generated.json'), join(dataDir, 'endpoints.generated.json'));

  const config = {
    repoRoot,
    source: 'extractors',
    specPath: null,
    endpointSource: 'docs/src/data/endpoints.generated.json',
    output: 'postman/collection.json',
    name: 'Orders API',
  };

  const { outputAbs } = await generate(config);
  const collection = JSON.parse(readFileSync(outputAbs, 'utf8'));

  const { valid, errors } = validateCollection(collection);
  assert.equal(valid, true, 'collection is schema-valid v2.1: ' + JSON.stringify(errors.slice(0, 5)));
  assert.equal(collection.info.name, 'Orders API');
  assert.equal(countRequests(collection.item), 3, 'all 3 endpoints became requests');

  // a POST endpoint with body params should carry a JSON body
  const flat = [];
  (function walk(items) {
    for (const it of items) {
      if (it.request) flat.push(it);
      if (it.item) walk(it.item);
    }
  })(collection.item);
  const post = flat.find((i) => i.request.method === 'POST');
  assert.ok(post, 'a POST request exists');
  assert.ok(post.request.body && post.request.body.mode === 'raw', 'POST has a raw body');
});

test('canonicalizeCollection assigns stable ids independent of input id noise', () => {
  const base = {
    info: { name: 'X' },
    item: [
      { name: 'B', request: { method: 'GET', url: { raw: '{{baseUrl}}/b' } }, id: 'random1' },
      { name: 'A', request: { method: 'GET', url: { raw: '{{baseUrl}}/a' } }, id: 'random2' },
    ],
  };
  const c1 = canonicalizeCollection(JSON.parse(JSON.stringify(base)));
  const c2 = canonicalizeCollection(JSON.parse(JSON.stringify(base)));
  assert.deepEqual(c1, c2, 'canonical form is stable');
  // sorted by method+url+name -> A before B
  assert.equal(c1.item[0].name, 'A');
  assert.equal(c1.item[1].name, 'B');
});
