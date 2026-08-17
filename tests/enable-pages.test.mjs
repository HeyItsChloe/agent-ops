/**
 * Unit tests for the Pages enablement helper (agent-ops issue #8, subtask 1b).
 * Run with: node --test tests/enable-pages.test.mjs
 *
 * Uses an injected fetch mock so no network / real token is needed. Verifies
 * the three idempotent branches: already-correct (no write), wrong build type
 * (PUT), and not-enabled (POST).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveTarget, enablePagesWorkflow } from '../scripts/setup/enable-pages.mjs';

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    const key = `${opts.method || 'GET'} pages`;
    const handler = routes[key] || routes[opts.method || 'GET'];
    if (!handler) throw new Error(`no mock for ${opts.method} ${url}`);
    return handler;
  };
  impl.calls = calls;
  return impl;
}

function res(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody ?? {}),
  };
}

test('parseArgs parses --owner/--repo/--token', () => {
  const a = parseArgs(['--owner', 'HeyItsChloe', '--repo', 'agent-ops', '--token', 'x']);
  assert.deepEqual(a, { owner: 'HeyItsChloe', repo: 'agent-ops', token: 'x' });
});

test('resolveTarget supports --slug owner/repo', () => {
  assert.deepEqual(resolveTarget({ slug: 'HeyItsChloe/agent-ops' }), {
    owner: 'HeyItsChloe',
    repo: 'agent-ops',
  });
});

test('resolveTarget throws when owner/repo missing', () => {
  assert.throws(() => resolveTarget({}), /owner and repo are required/);
});

test('already build_type=workflow -> unchanged, no write', async () => {
  const fetchImpl = mockFetch({ GET: res(200, { build_type: 'workflow' }) });
  const out = await enablePagesWorkflow({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  assert.equal(out.action, 'unchanged');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'GET');
});

test('wrong build_type -> PUT (updated)', async () => {
  let step = 0;
  const fetchImpl = async (url, opts = {}) => {
    step++;
    if (step === 1) return res(200, { build_type: 'legacy' });
    // PUT
    assert.equal(opts.method, 'PUT');
    assert.match(opts.body, /"build_type":"workflow"/);
    return res(200, { build_type: 'workflow' });
  };
  const out = await enablePagesWorkflow({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  assert.equal(out.action, 'updated');
});

test('pages not enabled (404) -> POST (created)', async () => {
  let step = 0;
  const fetchImpl = async (url, opts = {}) => {
    step++;
    if (step === 1) return res(404, { message: 'Not Found' });
    assert.equal(opts.method, 'POST');
    assert.match(opts.body, /"build_type":"workflow"/);
    return res(201, { build_type: 'workflow' });
  };
  const out = await enablePagesWorkflow({ owner: 'o', repo: 'r', token: 't', fetchImpl });
  assert.equal(out.action, 'created');
});

test('unexpected status throws', async () => {
  const fetchImpl = async () => res(500, { message: 'boom' });
  await assert.rejects(
    () => enablePagesWorkflow({ owner: 'o', repo: 'r', token: 't', fetchImpl }),
    /GET pages failed \(500\)/
  );
});
