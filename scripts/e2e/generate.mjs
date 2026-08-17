#!/usr/bin/env node
/**
 * scripts/e2e/generate.mjs — automatic E2E test generation for the reusable
 * pipeline (agent-ops issue #10, subtask 3b).
 *
 * Given detection output (from detect.mjs) plus a route/endpoint inventory,
 * generate framework-appropriate E2E specs:
 *   - Playwright (first-class), Cypress, Jest (supertest-style API), Mocha.
 *   - Frontend journeys come from routes/nav; backend journeys from an
 *     OpenAPI/Swagger doc or a plain endpoint list.
 *
 * Model use mirrors scripts/wiki-author.mjs exactly:
 *   - Everything goes through the LiteLLM gateway alias
 *     (LITELLM_PROXY_URL / LITELLM_VIRTUAL_KEY). No provider SDK/keys here.
 *   - No-op (exit 0) when those env vars are unset, so a normal pipeline run
 *     without generation configured is completely unaffected.
 *   - Never overwrites an existing authored spec — committed tests win. A
 *     deterministic fallback template is emitted when the model is unavailable
 *     but generation was still explicitly requested with --allow-fallback,
 *     so the repair loop always has something runnable to iterate on.
 *
 * The inventory-building and spec-path/planning logic is written as pure,
 * exported functions (buildTestPlan, specPathFor, fallbackSpec) so it is
 * unit-testable via `node --test` without a live gateway.
 *
 * Usage:
 *   node scripts/e2e/generate.mjs --repo-root <dir> \
 *       --detection <detect.json | -> reads stdin if "-"> \
 *       --inventory <inventory.json> \
 *       [--framework playwright|cypress|jest|mocha] \
 *       [--model documentation] [--allow-fallback] \
 *       [--failure-log <path>]   # repair loop: prior run's failing output
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const PROXY = process.env.LITELLM_PROXY_URL;
const KEY = process.env.LITELLM_VIRTUAL_KEY;

const SYSTEM = `You are an expert E2E test author. Output ONLY the contents of a single test file for the requested framework — no markdown fences, no prose. Cover the provided user journeys with realistic assertions (navigation, visible text, status codes for APIs). Never invent routes, selectors, or endpoints beyond the provided inventory. Keep tests deterministic and independent.`;

// ── Pure planning core ─────────────────────────────────────────────────────

/**
 * Turn a detection result + inventory into a flat list of journeys to cover.
 * @param {object} detection detect.mjs output
 * @param {object} inventory { routes?: [{path,name?}], endpoints?: [{method,path,name?}], openapi?: object }
 * @returns {{ frontend: object[], backend: object[] }}
 */
export function buildTestPlan(detection = {}, inventory = {}) {
  const frontend = [];
  const backend = [];

  const appType = detection.appType || 'frontend';

  if (appType === 'frontend' || appType === 'both') {
    for (const r of inventory.routes || []) {
      const path = typeof r === 'string' ? r : r.path;
      if (!path) continue;
      frontend.push({
        kind: 'frontend',
        name: (typeof r === 'object' && r.name) || slugFromPath(path),
        path,
      });
    }
  }

  if (appType === 'backend' || appType === 'both') {
    const eps = endpointsFromInventory(inventory);
    for (const ep of eps) {
      backend.push({
        kind: 'backend',
        name: ep.name || `${ep.method.toLowerCase()}-${slugFromPath(ep.path)}`,
        method: ep.method.toUpperCase(),
        path: ep.path,
      });
    }
  }

  return { frontend, backend };
}

/**
 * Normalize endpoints from either a plain list or an OpenAPI/Swagger doc.
 * @returns {{method:string, path:string, name?:string}[]}
 */
export function endpointsFromInventory(inventory = {}) {
  if (Array.isArray(inventory.endpoints) && inventory.endpoints.length) {
    return inventory.endpoints.map((e) =>
      typeof e === 'string'
        ? { method: 'GET', path: e }
        : { method: (e.method || 'GET').toUpperCase(), path: e.path, name: e.name },
    );
  }
  const openapi = inventory.openapi;
  if (openapi && openapi.paths && typeof openapi.paths === 'object') {
    const out = [];
    for (const [path, methods] of Object.entries(openapi.paths)) {
      if (!methods || typeof methods !== 'object') continue;
      for (const method of Object.keys(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;
        const op = methods[method] || {};
        out.push({
          method: method.toUpperCase(),
          path,
          name: op.operationId || op.summary || undefined,
        });
      }
    }
    return out;
  }
  return [];
}

export function slugFromPath(path) {
  const s = String(path)
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/[{}:]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || 'root';
}

/**
 * Where a generated spec for a given framework lives, relative to repo root.
 */
export function specPathFor(framework, workingDir = '.') {
  const wd = workingDir === '.' || !workingDir ? '' : workingDir.replace(/\/$/, '') + '/';
  switch (framework) {
    case 'cypress':
      return `${wd}cypress/e2e/generated.cy.js`;
    case 'jest':
      return `${wd}tests/generated.api.test.js`;
    case 'mocha':
      return `${wd}test/generated.api.test.js`;
    case 'playwright':
    default:
      return `${wd}tests/e2e/generated.spec.ts`;
  }
}

/**
 * Deterministic, dependency-free fallback spec so the repair loop always has
 * a runnable artifact even when the gateway is unavailable. Each generated
 * test title embeds the flow name so check-flow-coverage.mjs can match it.
 */
export function fallbackSpec(framework, plan, detection = {}) {
  const baseUrl = detection.baseUrl || 'http://localhost:3000';
  switch (framework) {
    case 'cypress':
      return cypressFallback(plan, baseUrl);
    case 'jest':
      return jestFallback(plan, baseUrl);
    case 'mocha':
      return mochaFallback(plan, baseUrl);
    case 'playwright':
    default:
      return playwrightFallback(plan, baseUrl);
  }
}

function playwrightFallback(plan, baseUrl) {
  const lines = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// AUTO-GENERATED by scripts/e2e/generate.mjs (agent-ops issue #10).`,
    `// Regenerated by the repair loop; safe to replace with authored specs.`,
    `const BASE_URL = process.env.E2E_BASE_URL || ${JSON.stringify(baseUrl)};`,
    ``,
  ];
  for (const j of plan.frontend) {
    lines.push(
      `test('flow: ${j.name}', async ({ page }) => {`,
      `  const res = await page.goto(BASE_URL + ${JSON.stringify(j.path)});`,
      `  expect(res && res.status()).toBeLessThan(400);`,
      `  await expect(page.locator('body')).toBeVisible();`,
      `});`,
      ``,
    );
  }
  for (const j of plan.backend) {
    lines.push(
      `test('flow: ${j.name}', async ({ request }) => {`,
      `  const res = await request.fetch(BASE_URL + ${JSON.stringify(j.path)}, { method: ${JSON.stringify(j.method)} });`,
      `  expect(res.status()).toBeLessThan(500);`,
      `});`,
      ``,
    );
  }
  return lines.join('\n');
}

function cypressFallback(plan, baseUrl) {
  const lines = [
    `// AUTO-GENERATED by scripts/e2e/generate.mjs (agent-ops issue #10).`,
    `const BASE_URL = Cypress.env('E2E_BASE_URL') || ${JSON.stringify(baseUrl)};`,
    ``,
  ];
  for (const j of plan.frontend) {
    lines.push(
      `describe('flow: ${j.name}', () => {`,
      `  it('loads ${j.path}', () => {`,
      `    cy.visit(BASE_URL + ${JSON.stringify(j.path)});`,
      `    cy.get('body').should('be.visible');`,
      `  });`,
      `});`,
      ``,
    );
  }
  for (const j of plan.backend) {
    lines.push(
      `describe('flow: ${j.name}', () => {`,
      `  it('${j.method} ${j.path}', () => {`,
      `    cy.request({ method: ${JSON.stringify(j.method)}, url: BASE_URL + ${JSON.stringify(j.path)}, failOnStatusCode: false })`,
      `      .its('status').should('be.lessThan', 500);`,
      `  });`,
      `});`,
      ``,
    );
  }
  return lines.join('\n');
}

function jestFallback(plan, baseUrl) {
  const lines = [
    `// AUTO-GENERATED by scripts/e2e/generate.mjs (agent-ops issue #10).`,
    `const BASE_URL = process.env.E2E_BASE_URL || ${JSON.stringify(baseUrl)};`,
    ``,
  ];
  const journeys = [...plan.backend, ...plan.frontend];
  for (const j of journeys) {
    const method = j.method || 'GET';
    lines.push(
      `test('flow: ${j.name}', async () => {`,
      `  const res = await fetch(BASE_URL + ${JSON.stringify(j.path)}, { method: ${JSON.stringify(method)} });`,
      `  expect(res.status).toBeLessThan(500);`,
      `});`,
      ``,
    );
  }
  return lines.join('\n');
}

function mochaFallback(plan, baseUrl) {
  const lines = [
    `// AUTO-GENERATED by scripts/e2e/generate.mjs (agent-ops issue #10).`,
    `const assert = require('node:assert');`,
    `const BASE_URL = process.env.E2E_BASE_URL || ${JSON.stringify(baseUrl)};`,
    ``,
    `describe('generated e2e', () => {`,
  ];
  const journeys = [...plan.backend, ...plan.frontend];
  for (const j of journeys) {
    const method = j.method || 'GET';
    lines.push(
      `  it('flow: ${j.name}', async () => {`,
      `    const res = await fetch(BASE_URL + ${JSON.stringify(j.path)}, { method: ${JSON.stringify(method)} });`,
      `    assert.ok(res.status < 500);`,
      `  });`,
    );
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}

/**
 * Build the user prompt sent to the gateway. Pure so it can be asserted in tests.
 */
export function buildPrompt(framework, detection, plan, failureLog = '') {
  const journeys = [
    ...plan.frontend.map((j) => `- [frontend] ${j.name}: navigate ${j.path}`),
    ...plan.backend.map((j) => `- [backend] ${j.name}: ${j.method} ${j.path}`),
  ].join('\n');
  let prompt =
    `Framework: ${framework}\n` +
    `Detection: ${JSON.stringify(detection)}\n` +
    `Base URL env var: E2E_BASE_URL (fallback ${detection.baseUrl || 'http://localhost:3000'}).\n` +
    `Each test title MUST start with "flow: <name>" using exactly these names so the coverage checker can match them.\n\n` +
    `User journeys to cover:\n${journeys}\n`;
  if (failureLog && failureLog.trim()) {
    prompt +=
      `\nThe previous generated suite FAILED. Fix the issues shown below and regenerate the full file.\n` +
      `Failing output (truncated):\n${failureLog.slice(0, 6000)}\n`;
  }
  return prompt;
}

// ── Gateway call (same shape as wiki-author.mjs) ─────────────────────────────

async function chat(model, user) {
  const res = await fetch(`${PROXY.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function stripFences(s) {
  return s
    .replace(/^\s*```[a-zA-Z]*\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[k] = v;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function readJsonMaybe(p, fallback) {
  if (!p) return fallback;
  if (p === '-') {
    try {
      return JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      return fallback;
    }
  }
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args['repo-root'] || '.');
  const detection = readJsonMaybe(args.detection, {});
  const inventory = readJsonMaybe(args.inventory, {});
  const framework = args.framework || detection.testFramework || 'playwright';
  const model = args.model || process.env.E2E_GEN_MODEL || 'documentation';
  const allowFallback = Boolean(args['allow-fallback']);
  const failureLog = args['failure-log'] && existsSync(args['failure-log'])
    ? readFileSync(args['failure-log'], 'utf8')
    : '';
  const workingDir = args['working-directory'] || '.';

  const plan = buildTestPlan(detection, inventory);
  const relPath = specPathFor(framework, workingDir);
  const dest = join(repoRoot, relPath);

  if (existsSync(dest) && !args.force) {
    console.log(`[e2e-generate] ${relPath}: already exists — leaving authored/prior spec as-is.`);
    return;
  }

  let content;
  if (PROXY && KEY) {
    console.log(`[e2e-generate] generating ${framework} spec via alias "${model}"...`);
    try {
      content = stripFences(await chat(model, buildPrompt(framework, detection, plan, failureLog)));
    } catch (err) {
      console.error(`[e2e-generate] gateway call failed: ${err.message}`);
      if (!allowFallback) throw err;
    }
  } else {
    console.log('[e2e-generate] LITELLM_PROXY_URL/LITELLM_VIRTUAL_KEY not set — no model available.');
  }

  if (!content || !content.trim()) {
    if (!allowFallback) {
      console.log('[e2e-generate] no model output and --allow-fallback not set — skipping (no-op).');
      return;
    }
    console.log('[e2e-generate] emitting deterministic fallback spec.');
    content = fallbackSpec(framework, plan, detection);
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content.trim() + '\n', 'utf8');
  console.log(`[e2e-generate] wrote ${relPath} (${plan.frontend.length} frontend + ${plan.backend.length} backend journeys).`);
}

function isMain() {
  return process.argv[1] && process.argv[1].endsWith('generate.mjs');
}

if (isMain()) {
  main().catch((err) => {
    console.error('[e2e-generate] FAILED:', err);
    process.exit(1);
  });
}
