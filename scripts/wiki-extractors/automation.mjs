/**
 * Extracts AutomationDoc[] from agent-ops's own orchestrator/src/registry/pipelines.yaml,
 * filtered to entries whose execution.owner/execution.repo match this repo
 * (config.extractors.automation.repoMatch, "owner/name" form).
 *
 * pipelinesYamlPath is resolved against `controlRepoRoot` (the agent-ops
 * checkout), not the target repo being documented - see
 * .github/workflows/wiki-generate-reusable.yml, which checks out both.
 *
 * Writes src/data/automation.generated.json + src/data/automation.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { mergeEntries, readJsonSidecar, writeJsonSidecar, writeGeneratedTsWrapper, hashSource, stableStringify } from './merge.mjs';

export async function extract({ config, outputPaths, controlRepoRoot }) {
  const opts = config.extractors.automation;
  if (!opts?.enabled) return { skipped: true };

  if (!controlRepoRoot) {
    throw new Error(
      'extractors.automation is enabled but no controlRepoRoot was provided to the driver (see --control-repo / WIKI_CONTROL_REPO).'
    );
  }
  const pipelinesPath = resolve(controlRepoRoot, opts.pipelinesYamlPath ?? 'orchestrator/src/registry/pipelines.yaml');
  if (!existsSync(pipelinesPath)) {
    throw new Error(`pipelines.yaml not found at ${pipelinesPath}`);
  }
  const pipelines = parse(readFileSync(pipelinesPath, 'utf8')) ?? [];
  const [wantOwner, wantRepo] = (opts.repoMatch ?? '').split('/');

  const incoming = pipelines
    .filter((p) => {
      // showAll: the control repo (agent-ops) documents every pipeline in its
      // own registry, regardless of which repo/runner each one acts on. App
      // repos leave this off and use repoMatch to show only their own.
      if (opts.showAll) return true;
      const exec = p.execution ?? {};
      if (exec.kind !== 'github-actions') return !opts.repoMatch; // in-process pipelines only included if no repo filter set
      return exec.owner === wantOwner && exec.repo === wantRepo;
    })
    .map((p) => {
      const triggers = [
        ...Object.entries(p.triggers?.labels ?? {}).map(([label, action]) => `label "${label}" -> ${action}`),
        ...Object.entries(p.triggers?.mentions ?? {}).map(([phrase, action]) => `comment "${phrase}" -> ${action}`),
        ...(p.triggers?.chat_tool ? [`chat tool: ${p.triggers.chat_tool}`] : []),
        ...(p.triggers?.http_kind ? [`http kind: ${p.triggers.http_kind}`] : []),
      ];
      return {
        slug: p.name,
        name: p.name,
        handler: p.handler,
        executionKind: p.execution?.kind ?? 'unknown',
        ...(p.execution?.workflow ? { workflow: p.execution.workflow } : {}),
        triggers,
        params: p.params ?? {},
        description: `Handler: ${p.handler}. Skill: ${p.skill_path ?? 'n/a'}.`,
        _sourceHash: hashSource(stableStringify(p)),
      };
    });

  const sidecarPath = join(outputPaths.dataDir, 'automation.generated.json');
  const existing = readJsonSidecar(sidecarPath, []);
  const result = mergeEntries(existing, incoming, { key: 'slug' });

  writeJsonSidecar(sidecarPath, result.merged);
  writeGeneratedTsWrapper(
    join(outputPaths.dataDir, 'automation.ts'),
    `import type { AutomationDoc } from '../types';\nimport data from './automation.generated.json';\n\nexport const automation = data as unknown as AutomationDoc[];\n\nexport function getAutomation(slug: string) {\n  return automation.find((a) => a.slug === slug);\n}\n`
  );

  return { kind: 'automation', ...result };
}
