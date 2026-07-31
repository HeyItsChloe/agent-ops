#!/usr/bin/env node
/**
 * scripts/e2e/detect.mjs — repository language / framework detection for the
 * reusable E2E pipeline (agent-ops issue #10, subtask 3a).
 *
 * Given a repo root, infer everything the generator + caller-scaffolder need
 * to onboard a brand-new repository without hand-written config:
 *
 *   {
 *     language:       'ts' | 'js' | 'python' | 'kotlin' | 'unknown'
 *     framework:      'next' | 'vite' | 'react' | 'vue' | 'angular' |
 *                     'svelte' | 'express' | 'fastify' | 'nest' | 'koa' |
 *                     'flask' | 'fastapi' | 'django' | 'android' | 'unknown'
 *     packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'pip' | 'gradle' | 'unknown'
 *     appType:        'frontend' | 'backend' | 'both'
 *     startCommand:   string | null   // how to boot the app under test
 *     baseUrl:        string          // where the app is reachable once started
 *     testFramework:  'playwright' | 'cypress' | 'jest' | 'mocha' | 'espresso'
 *     needsEmulator:  boolean
 *   }
 *
 * The detection logic is written as pure functions over already-read file
 * contents (see detectFromInputs) so it is unit-testable via `node --test`
 * without touching the filesystem. The filesystem read + CLI wrapper sit on
 * top of that pure core.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Framework signature tables ───────────────────────────────────────────
// Each entry: dependency (or devDependency) name -> canonical framework id.
// First match wins in the order listed, so more specific meta-frameworks
// (Next over React, Nest over Express) are checked before their bases.

const FRONTEND_FRAMEWORKS = [
  ['next', 'next'],
  ['nuxt', 'vue'],
  ['@angular/core', 'angular'],
  ['@sveltejs/kit', 'svelte'],
  ['svelte', 'svelte'],
  ['vue', 'vue'],
  ['@vitejs/plugin-react', 'vite'],
  ['vite', 'vite'],
  ['react-scripts', 'react'],
  ['react-dom', 'react'],
  ['react', 'react'],
];

const BACKEND_FRAMEWORKS = [
  ['@nestjs/core', 'nest'],
  ['fastify', 'fastify'],
  ['koa', 'koa'],
  ['express', 'express'],
  ['hapi', 'express'],
];

const PY_BACKEND_FRAMEWORKS = [
  ['fastapi', 'fastapi'],
  ['django', 'django'],
  ['flask', 'flask'],
];

const DEFAULT_BASE_URLS = {
  next: 'http://localhost:3000',
  nest: 'http://localhost:3000',
  vite: 'http://localhost:5173',
  react: 'http://localhost:3000',
  vue: 'http://localhost:5173',
  angular: 'http://localhost:4200',
  svelte: 'http://localhost:5173',
  express: 'http://localhost:3000',
  fastify: 'http://localhost:3000',
  koa: 'http://localhost:3000',
  flask: 'http://localhost:5000',
  fastapi: 'http://localhost:8000',
  django: 'http://localhost:8000',
};

const FRONTEND_IDS = new Set([
  'next',
  'vite',
  'react',
  'vue',
  'angular',
  'svelte',
]);
const BACKEND_IDS = new Set([
  'express',
  'fastify',
  'nest',
  'koa',
  'flask',
  'fastapi',
  'django',
]);

// ── Pure detection core ────────────────────────────────────────────────────

/**
 * @param {object} inputs
 * @param {object|null} inputs.packageJson  parsed package.json (or null)
 * @param {object} [inputs.files]           map of marker filename -> boolean present
 * @param {string} [inputs.pyProject]       pyproject.toml / requirements.txt text
 * @returns {object} detection result (see module header)
 */
export function detectFromInputs({ packageJson = null, files = {}, pyProject = '' } = {}) {
  const has = (name) => Boolean(files[name]);

  // 1. Android / Gradle short-circuit — instrumented tests, not a "run a
  //    command" web problem (matches e2e-pipeline-reusable.yml needs_emulator).
  if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) {
    return finalize({
      language: 'kotlin',
      framework: 'android',
      packageManager: 'gradle',
      appType: 'frontend',
      startCommand: null,
      baseUrl: '',
      testFramework: 'espresso',
      needsEmulator: true,
    });
  }

  // 2. Node / JS-TS repos.
  if (packageJson && typeof packageJson === 'object') {
    return detectNode(packageJson, files);
  }

  // 3. Python repos.
  if (pyProject || has('requirements.txt') || has('pyproject.toml') || has('manage.py')) {
    return detectPython(pyProject, files);
  }

  return finalize({
    language: 'unknown',
    framework: 'unknown',
    packageManager: 'unknown',
    appType: 'frontend',
    startCommand: null,
    baseUrl: 'http://localhost:3000',
    testFramework: 'playwright',
    needsEmulator: false,
  });
}

function detectNode(pkg, files) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const language = files['tsconfig.json'] || deps.typescript ? 'ts' : 'js';

  const frontend = matchFramework(deps, FRONTEND_FRAMEWORKS);
  const backend = matchFramework(deps, BACKEND_FRAMEWORKS);

  let framework = 'unknown';
  let appType = 'frontend';
  if (frontend && backend) {
    framework = frontend; // meta-framework (e.g. Next) fronts the API too
    appType = 'both';
  } else if (frontend) {
    framework = frontend;
    appType = FRONTEND_IDS.has(frontend) ? 'frontend' : 'both';
  } else if (backend) {
    framework = backend;
    appType = 'backend';
  }

  // Next.js is the common full-stack case: frontend routes + API routes.
  if (framework === 'next') appType = 'both';

  const packageManager = detectNodePackageManager(files);
  const startCommand = pickStartScript(scripts, packageManager, framework);
  const baseUrl = DEFAULT_BASE_URLS[framework] || 'http://localhost:3000';

  const testFramework = pickTestFramework(deps, appType);

  return finalize({
    language,
    framework,
    packageManager,
    appType,
    startCommand,
    baseUrl,
    testFramework,
    needsEmulator: false,
  });
}

function detectPython(pyText, files) {
  const text = (pyText || '').toLowerCase();
  let framework = 'unknown';
  for (const [dep, id] of PY_BACKEND_FRAMEWORKS) {
    if (text.includes(dep)) {
      framework = id;
      break;
    }
  }
  if (framework === 'unknown' && files['manage.py']) framework = 'django';

  const baseUrl = DEFAULT_BASE_URLS[framework] || 'http://localhost:8000';
  const startCommand = pythonStartCommand(framework);

  return finalize({
    language: 'python',
    framework,
    packageManager: 'pip',
    appType: 'backend',
    startCommand,
    // Python backends are API targets — default to an API-level test runner,
    // but Playwright can still hit HTTP endpoints, so keep it available.
    baseUrl,
    testFramework: 'jest',
    needsEmulator: false,
  });
}

function matchFramework(deps, table) {
  for (const [dep, id] of table) {
    if (deps[dep]) return id;
  }
  return null;
}

function detectNodePackageManager(files) {
  if (files['bun.lockb']) return 'bun';
  if (files['pnpm-lock.yaml']) return 'pnpm';
  if (files['yarn.lock']) return 'yarn';
  if (files['package-lock.json']) return 'npm';
  return 'npm';
}

function runnerFor(pm) {
  switch (pm) {
    case 'yarn':
      return 'yarn';
    case 'pnpm':
      return 'pnpm';
    case 'bun':
      return 'bun run';
    default:
      return 'npm run';
  }
}

function pickStartScript(scripts, pm, framework) {
  const runner = runnerFor(pm);
  // Prefer an explicit start/dev/serve/preview script if present.
  for (const name of ['start', 'dev', 'serve', 'preview']) {
    if (scripts[name]) return `${runner} ${name}`;
  }
  // Fall back to framework CLIs.
  switch (framework) {
    case 'next':
      return `${runner} dev`;
    case 'vite':
    case 'react':
    case 'vue':
    case 'svelte':
      return `${runner} dev`;
    case 'angular':
      return `${runner} start`;
    default:
      return null;
  }
}

function pickTestFramework(deps, appType) {
  if (deps.playwright || deps['@playwright/test']) return 'playwright';
  if (deps.cypress) return 'cypress';
  // Backend-only repos with no browser framework installed → API tests.
  if (appType === 'backend') {
    if (deps.mocha) return 'mocha';
    if (deps.jest || deps['ts-jest']) return 'jest';
    return 'jest';
  }
  if (deps.jest) return 'jest';
  if (deps.mocha) return 'mocha';
  // Default for un-onboarded frontends: Playwright (issue #10 "Playwright first").
  return 'playwright';
}

function pythonStartCommand(framework) {
  switch (framework) {
    case 'fastapi':
      return 'uvicorn main:app --host 0.0.0.0 --port 8000';
    case 'flask':
      return 'flask run --host 0.0.0.0 --port 5000';
    case 'django':
      return 'python manage.py runserver 0.0.0.0:8000';
    default:
      return null;
  }
}

function finalize(result) {
  // Normalize appType against framework id sets so a caller can trust it.
  if (result.appType == null) {
    if (FRONTEND_IDS.has(result.framework)) result.appType = 'frontend';
    else if (BACKEND_IDS.has(result.framework)) result.appType = 'backend';
    else result.appType = 'frontend';
  }
  return result;
}

// ── Filesystem wrapper ───────────────────────────────────────────────────

const MARKER_FILES = [
  'tsconfig.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'requirements.txt',
  'pyproject.toml',
  'manage.py',
];

/**
 * Read the marker files under `root` and run the pure detector.
 * @param {string} root repo root directory
 */
export function detectRepo(root = '.') {
  const files = {};
  for (const name of MARKER_FILES) files[name] = existsSync(join(root, name));

  let packageJson = null;
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      packageJson = null;
    }
  }

  let pyProject = '';
  for (const name of ['pyproject.toml', 'requirements.txt']) {
    const p = join(root, name);
    if (existsSync(p)) pyProject += `\n${readFileSync(p, 'utf8')}`;
  }

  return detectFromInputs({ packageJson, files, pyProject });
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

function isMain() {
  // ESM main-module check without import.meta.url string juggling in tests.
  return (
    process.argv[1] &&
    (process.argv[1].endsWith('detect.mjs') || process.argv[1].endsWith('e2e/detect.mjs'))
  );
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const root = args['repo-root'] || args._[0] || '.';
  const result = detectRepo(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
