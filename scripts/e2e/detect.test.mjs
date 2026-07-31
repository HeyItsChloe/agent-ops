import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFromInputs } from './detect.mjs';
import {
  buildTestPlan,
  endpointsFromInventory,
  slugFromPath,
  specPathFor,
  fallbackSpec,
  buildPrompt,
} from './generate.mjs';
import { renderCaller, renderCoverageManifest, defaultInstallCommand, defaultTestCommand } from './scaffold-caller.mjs';

// ── detect.mjs ─────────────────────────────────────────────────────────────

test('detects a Vite + React TS frontend', () => {
  const r = detectFromInputs({
    packageJson: {
      dependencies: { react: '^18', 'react-dom': '^18' },
      devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4', typescript: '^5' },
      scripts: { dev: 'vite', build: 'vite build' },
    },
    files: { 'tsconfig.json': true, 'package-lock.json': true },
  });
  assert.equal(r.language, 'ts');
  assert.equal(r.framework, 'vite');
  assert.equal(r.appType, 'frontend');
  assert.equal(r.packageManager, 'npm');
  assert.equal(r.startCommand, 'npm run dev');
  assert.equal(r.baseUrl, 'http://localhost:5173');
  assert.equal(r.testFramework, 'playwright');
  assert.equal(r.needsEmulator, false);
});

test('detects Next.js as full-stack (both) with pnpm', () => {
  const r = detectFromInputs({
    packageJson: {
      dependencies: { next: '^14', react: '^18' },
      scripts: { dev: 'next dev', start: 'next start' },
    },
    files: { 'pnpm-lock.yaml': true },
  });
  assert.equal(r.framework, 'next');
  assert.equal(r.appType, 'both');
  assert.equal(r.packageManager, 'pnpm');
  assert.equal(r.startCommand, 'pnpm start');
});

test('prefers Nest over Express and marks backend', () => {
  const r = detectFromInputs({
    packageJson: {
      dependencies: { '@nestjs/core': '^10', express: '^4' },
      scripts: { start: 'nest start' },
    },
    files: { 'yarn.lock': true },
  });
  assert.equal(r.framework, 'nest');
  assert.equal(r.appType, 'backend');
  assert.equal(r.packageManager, 'yarn');
  assert.equal(r.startCommand, 'yarn start');
  assert.equal(r.testFramework, 'jest'); // backend default
});

test('plain Express backend with jest installed picks jest', () => {
  const r = detectFromInputs({
    packageJson: {
      dependencies: { express: '^4' },
      devDependencies: { jest: '^29' },
      scripts: { start: 'node server.js' },
    },
    files: { 'package-lock.json': true },
  });
  assert.equal(r.framework, 'express');
  assert.equal(r.appType, 'backend');
  assert.equal(r.testFramework, 'jest');
});

test('Angular default base url and start', () => {
  const r = detectFromInputs({
    packageJson: { dependencies: { '@angular/core': '^17' }, scripts: {} },
    files: { 'tsconfig.json': true },
  });
  assert.equal(r.framework, 'angular');
  assert.equal(r.baseUrl, 'http://localhost:4200');
  assert.equal(r.startCommand, 'npm run start');
});

test('detects Android/Gradle → emulator + espresso', () => {
  const r = detectFromInputs({ files: { 'build.gradle.kts': true, 'settings.gradle.kts': true } });
  assert.equal(r.framework, 'android');
  assert.equal(r.needsEmulator, true);
  assert.equal(r.testFramework, 'espresso');
  assert.equal(r.packageManager, 'gradle');
});

test('detects FastAPI backend from requirements text', () => {
  const r = detectFromInputs({
    files: { 'requirements.txt': true },
    pyProject: 'fastapi==0.110\nuvicorn==0.29',
  });
  assert.equal(r.language, 'python');
  assert.equal(r.framework, 'fastapi');
  assert.equal(r.appType, 'backend');
  assert.equal(r.baseUrl, 'http://localhost:8000');
  assert.match(r.startCommand, /uvicorn/);
});

test('detects Django from manage.py marker', () => {
  const r = detectFromInputs({ files: { 'manage.py': true, 'requirements.txt': true }, pyProject: 'Django==5.0' });
  assert.equal(r.framework, 'django');
  assert.match(r.startCommand, /manage\.py runserver/);
});

test('unknown repo falls back sanely', () => {
  const r = detectFromInputs({});
  assert.equal(r.framework, 'unknown');
  assert.equal(r.testFramework, 'playwright');
  assert.equal(r.needsEmulator, false);
});

test('bun lockfile detected over npm', () => {
  const r = detectFromInputs({
    packageJson: { dependencies: { react: '^18' }, scripts: { dev: 'vite' } },
    files: { 'bun.lockb': true },
  });
  assert.equal(r.packageManager, 'bun');
  assert.equal(r.startCommand, 'bun run dev');
});

// ── generate.mjs pure logic ─────────────────────────────────────────────────

test('slugFromPath normalizes routes and params', () => {
  assert.equal(slugFromPath('/'), 'root');
  assert.equal(slugFromPath('/users/:id'), 'users-id');
  assert.equal(slugFromPath('/api/v1/items?q=1'), 'api-v1-items');
  assert.equal(slugFromPath('/posts/{postId}'), 'posts-postid');
});

test('endpointsFromInventory reads a plain list', () => {
  const eps = endpointsFromInventory({ endpoints: [{ method: 'post', path: '/login' }, '/health'] });
  assert.deepEqual(eps, [
    { method: 'POST', path: '/login', name: undefined },
    { method: 'GET', path: '/health' },
  ]);
});

test('endpointsFromInventory reads OpenAPI paths', () => {
  const eps = endpointsFromInventory({
    openapi: {
      paths: {
        '/users': { get: { operationId: 'listUsers' }, post: {} },
        '/health': { get: {} },
      },
    },
  });
  assert.equal(eps.length, 3);
  assert.ok(eps.some((e) => e.method === 'GET' && e.path === '/users' && e.name === 'listUsers'));
  assert.ok(eps.some((e) => e.method === 'POST' && e.path === '/users'));
});

test('buildTestPlan splits frontend and backend for "both"', () => {
  const plan = buildTestPlan(
    { appType: 'both' },
    { routes: ['/', '/about'], endpoints: [{ method: 'GET', path: '/api/health' }] },
  );
  assert.equal(plan.frontend.length, 2);
  assert.equal(plan.backend.length, 1);
  assert.equal(plan.frontend[0].name, 'root');
});

test('buildTestPlan omits backend journeys for a frontend-only app', () => {
  const plan = buildTestPlan(
    { appType: 'frontend' },
    { routes: ['/'], endpoints: [{ method: 'GET', path: '/api/x' }] },
  );
  assert.equal(plan.backend.length, 0);
});

test('specPathFor returns framework-appropriate paths with working dir', () => {
  assert.equal(specPathFor('playwright', 'app'), 'app/tests/e2e/generated.spec.ts');
  assert.equal(specPathFor('cypress', '.'), 'cypress/e2e/generated.cy.js');
  assert.equal(specPathFor('jest'), 'tests/generated.api.test.js');
  assert.equal(specPathFor('mocha'), 'test/generated.api.test.js');
});

test('fallbackSpec (playwright) embeds flow names for coverage matching', () => {
  const plan = buildTestPlan({ appType: 'both' }, { routes: ['/'], endpoints: [{ method: 'GET', path: '/api/health' }] });
  const spec = fallbackSpec('playwright', plan, { baseUrl: 'http://localhost:3000' });
  assert.match(spec, /@playwright\/test/);
  assert.match(spec, /flow: root/);
  assert.match(spec, /flow: get-api-health/);
});

test('fallbackSpec (jest) covers backend endpoints', () => {
  const plan = buildTestPlan({ appType: 'backend' }, { endpoints: [{ method: 'POST', path: '/login' }] });
  const spec = fallbackSpec('jest', plan, {});
  assert.match(spec, /flow: post-login/);
  assert.match(spec, /fetch\(/);
});

test('buildPrompt appends failure log for the repair loop', () => {
  const plan = buildTestPlan({ appType: 'frontend' }, { routes: ['/'] });
  const p = buildPrompt('playwright', { baseUrl: 'x' }, plan, 'Error: selector not found');
  assert.match(p, /previous generated suite FAILED/);
  assert.match(p, /selector not found/);
});

// ── scaffold-caller.mjs pure logic ──────────────────────────────────────────

test('renderCaller produces a backwards-compatible install/test caller by default', () => {
  const y = renderCaller({
    detection: { framework: 'vite', testFramework: 'playwright', packageManager: 'npm', appType: 'frontend' },
    controlRepo: 'HeyItsChloe/agent-ops',
    workingDirectory: 'app',
  });
  assert.match(y, /uses: HeyItsChloe\/agent-ops\/\.github\/workflows\/e2e-pipeline-reusable\.yml@main/);
  assert.match(y, /install_command:/);
  assert.match(y, /test_command:/);
  assert.match(y, /needs_emulator: false/);
  assert.match(y, /control_repo:/);
  assert.doesNotMatch(y, /autogen: true/);
});

test('renderCaller autogen mode emits new opt-in inputs', () => {
  const y = renderCaller({
    detection: { framework: 'next', testFramework: 'playwright', appType: 'both', startCommand: 'npm run dev', baseUrl: 'http://localhost:3000' },
    autogen: true,
  });
  assert.match(y, /autogen: true/);
  assert.match(y, /test_framework:/);
  assert.match(y, /start_command:/);
  assert.match(y, /max_repair_attempts: 3/);
  assert.doesNotMatch(y, /install_command:/);
});

test('renderCaller emulator path adds emulator_api_level', () => {
  const y = renderCaller({ detection: { framework: 'android', needsEmulator: true, testFramework: 'espresso' } });
  assert.match(y, /needs_emulator: true/);
  assert.match(y, /emulator_api_level: 30/);
});

test('renderCoverageManifest lists unique flows', () => {
  const m = renderCoverageManifest(['a', 'b', 'a']);
  assert.match(m, /flows:/);
  assert.match(m, /- a/);
  assert.match(m, /- b/);
  assert.equal((m.match(/- a\b/g) || []).length, 1);
});

test('defaultInstallCommand / defaultTestCommand per framework', () => {
  assert.match(defaultInstallCommand({ packageManager: 'npm', testFramework: 'playwright' }), /npm ci.*playwright install/);
  assert.equal(defaultInstallCommand({ packageManager: 'pip' }), 'pip install -r requirements.txt');
  assert.equal(defaultInstallCommand({ needsEmulator: true }), '');
  assert.equal(defaultTestCommand({ testFramework: 'cypress' }), 'npx cypress run');
  assert.equal(defaultTestCommand({ testFramework: 'playwright' }), 'npx playwright test');
  assert.equal(defaultTestCommand({ needsEmulator: true }), './gradlew connectedDebugAndroidTest');
});
