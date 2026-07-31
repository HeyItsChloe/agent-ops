#!/usr/bin/env node
/**
 * Validate a generated Postman Collection against the official Postman
 * Collection Format v2.1 JSON Schema (agent-ops issue #12).
 *
 * The schema is vendored at scripts/postman/schema/collection-v2.1.0.json so
 * validation is offline + deterministic in CI (no network fetch at run time).
 * It is a JSON-Schema draft-04 document, so we compile it with ajv-draft-04.
 *
 * Exit code 0 = valid; nonzero = invalid (errors printed). This is what makes
 * the reusable workflow fail CI on a bad/broken generation.
 *
 * Usage:
 *   node scripts/postman/validate.mjs <path-to-collection.json>
 *   node scripts/postman/validate.mjs --repo-root <root> [--output postman/collection.json]
 */

import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv-draft-04';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema', 'collection-v2.1.0.json');

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    } else {
      positional.push(argv[i]);
    }
  }
  return { args, positional };
}

/**
 * Validate a parsed collection object. Returns { valid, errors }.
 * Reusable from tests without touching the filesystem/process exit.
 */
export function validateCollection(collection) {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(collection);
  return { valid: !!valid, errors: validate.errors || [] };
}

export function resolveCollectionPath(argv = process.argv.slice(2), env = process.env) {
  const { args, positional } = parseArgs(argv);
  if (positional.length) return resolve(positional[0]);
  const repoRoot = resolve(args['repo-root'] || env.PM_REPO_ROOT || process.cwd());
  const output = args.output || env.PM_OUTPUT || 'postman/collection.json';
  return resolve(repoRoot, output);
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const collectionPath = resolveCollectionPath();
  let collection;
  try {
    collection = JSON.parse(readFileSync(collectionPath, 'utf8'));
  } catch (err) {
    console.error(`[postman:validate] ERROR: cannot read/parse ${collectionPath}: ${err.message}`);
    process.exit(1);
  }
  const { valid, errors } = validateCollection(collection);
  if (valid) {
    console.log(`[postman:validate] OK - ${collectionPath} is a schema-valid Postman v2.1 collection.`);
    process.exit(0);
  }
  console.error(`[postman:validate] FAILED - ${collectionPath} is not a valid Postman v2.1 collection:`);
  for (const e of errors.slice(0, 25)) {
    console.error(`  - ${e.instancePath || '(root)'} ${e.message}`);
  }
  process.exit(1);
}
