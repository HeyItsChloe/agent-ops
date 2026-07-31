#!/usr/bin/env node
/**
 * Enable GitHub Pages "Source: GitHub Actions" for a repo (agent-ops issue #8,
 * subtask 1b).
 *
 * Why this exists
 * ---------------
 * `deploy-docs.yml` and `wiki-generate-reusable.yml` publish the docs site to
 * GitHub Pages via `actions/deploy-pages`, but that only works once a repo's
 * Pages *build type* is set to `workflow` (the UI's Settings -> Pages ->
 * Build and deployment -> Source: "GitHub Actions"). Historically that was a
 * one-time **manual** toggle documented in deploy-docs.yml's header, so a
 * brand-new consuming repo could not deploy until a human clicked it. This
 * script removes that manual step: it idempotently sets the Pages build type
 * to `workflow` through the GitHub REST API, so onboarding a repo is a single
 * scripted call.
 *
 * It is idempotent:
 *   - If Pages is already configured with build_type=workflow, it exits 0
 *     without making a change.
 *   - If Pages exists but with a different build_type (e.g. legacy branch
 *     source), it PUTs build_type=workflow to switch it.
 *   - If Pages is not enabled at all, it POSTs to create it with
 *     build_type=workflow.
 *
 * Auth: uses a token from --token, GITHUB_TOKEN, or GH_TOKEN. The token needs
 * the `pages` write permission (Actions' default GITHUB_TOKEN with
 * `permissions: pages: write` works when run inside a workflow; a GitHub App
 * installation token or a PAT with repo/pages scope works from a setup
 * context). No PAT is hardcoded and none is required in CI — see the
 * onboarding note at the bottom of this file.
 *
 * Usage:
 *   node scripts/setup/enable-pages.mjs --owner <owner> --repo <repo> [--token <tok>]
 *   node scripts/setup/enable-pages.mjs --slug <owner>/<repo>
 *   GITHUB_TOKEN=... node scripts/setup/enable-pages.mjs --slug HeyItsChloe/agent-ops
 *
 * Exit codes: 0 on success (created, updated, or already-correct); 1 on error.
 */

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TARGET_BUILD_TYPE = 'workflow';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

/** Resolves owner/repo from --owner/--repo or --slug (owner/repo). */
export function resolveTarget(args) {
  let owner = args.owner;
  let repo = args.repo;
  if ((!owner || !repo) && typeof args.slug === 'string' && args.slug.includes('/')) {
    const [o, r] = args.slug.split('/');
    owner = owner || o;
    repo = repo || r;
  }
  if (!owner || !repo) {
    throw new Error('owner and repo are required (pass --owner X --repo Y or --slug owner/repo).');
  }
  return { owner, repo };
}

function resolveToken(args) {
  const token = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error('No token found. Pass --token or set GITHUB_TOKEN / GH_TOKEN.');
  }
  return token;
}

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-ops-enable-pages',
  };
}

/**
 * Idempotently ensure the repo's Pages build type is `workflow`.
 *
 * @param {{owner:string, repo:string, token:string, fetchImpl?:Function, log?:Function}} opts
 * @returns {Promise<{action:'unchanged'|'updated'|'created', buildType:string}>}
 */
export async function enablePagesWorkflow({ owner, repo, token, fetchImpl, log = () => {} }) {
  const doFetch = fetchImpl || fetch;
  const base = `${API}/repos/${owner}/${repo}/pages`;
  const headers = ghHeaders(token);

  // 1. Read current Pages config.
  const getRes = await doFetch(base, { method: 'GET', headers });

  if (getRes.status === 200) {
    const current = await getRes.json();
    if (current.build_type === TARGET_BUILD_TYPE) {
      log(`[enable-pages] ${owner}/${repo}: already build_type=${TARGET_BUILD_TYPE} — no change.`);
      return { action: 'unchanged', buildType: TARGET_BUILD_TYPE };
    }
    // 2a. Exists but wrong build type -> switch it (PUT).
    const putRes = await doFetch(base, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ build_type: TARGET_BUILD_TYPE }),
    });
    if (!putRes.ok) {
      throw new Error(`PUT pages failed (${putRes.status}): ${await safeText(putRes)}`);
    }
    log(`[enable-pages] ${owner}/${repo}: switched build_type ${current.build_type} -> ${TARGET_BUILD_TYPE}.`);
    return { action: 'updated', buildType: TARGET_BUILD_TYPE };
  }

  if (getRes.status === 404) {
    // 2b. Pages not enabled -> create it with the workflow build type (POST).
    const postRes = await doFetch(base, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ build_type: TARGET_BUILD_TYPE }),
    });
    if (!postRes.ok) {
      throw new Error(`POST pages failed (${postRes.status}): ${await safeText(postRes)}`);
    }
    log(`[enable-pages] ${owner}/${repo}: enabled Pages with build_type=${TARGET_BUILD_TYPE}.`);
    return { action: 'created', buildType: TARGET_BUILD_TYPE };
  }

  throw new Error(`GET pages failed (${getRes.status}): ${await safeText(getRes)}`);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const { owner, repo } = resolveTarget(args);
    const token = resolveToken(args);
    const result = await enablePagesWorkflow({ owner, repo, token, log: console.log });
    console.log(`[enable-pages] done: ${result.action} (build_type=${result.buildType}).`);
  })().catch((err) => {
    console.error('[enable-pages] FAILED:', err.message);
    process.exit(1);
  });
}
