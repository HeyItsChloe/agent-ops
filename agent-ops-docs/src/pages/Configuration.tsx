import { Layout } from '../components/Layout/Layout';
import { Badge } from '../components/ui/Badge';
import { envVars } from '../data/env';

export function Configuration() {
  if (envVars.length === 0) {
    return (
      <Layout>
        <p className="prose-body">No environment variables have been extracted yet. Run the wiki generator to populate this page.</p>
      </Layout>
    );
  }

  const byComponent = envVars.reduce<Record<string, typeof envVars>>((acc, v) => {
    (acc[v.component] ??= []).push(v);
    return acc;
  }, {});

  return (
    <Layout>
      <h1 className="text-heading-lg font-bold text-white">Configuration</h1>
      <p className="mt-2 prose-body">
        Environment variables each service reads, extracted from its <span className="font-mono">.env.example</span>.
        A variable is marked <strong>required</strong> only when the code actually requires it
        (a <span className="font-mono">requireEnv()</span> call); everything else is optional and feature-gated by
        presence.
      </p>

      {Object.entries(byComponent).map(([component, list]) => (
        <div key={component} className="mt-8">
          <div className="mb-3 font-mono text-xs uppercase tracking-wider text-content-muted">{component}</div>
          <div className="space-y-3">
            {list.map((v) => (
              <div key={v.slug} className="rounded-card border border-surface-border bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-white">{v.name}</span>
                  {v.required ? <Badge tone="error">required</Badge> : <Badge>optional</Badge>}
                  {v.defaultValue && <span className="font-mono text-xs text-content-muted">= {v.defaultValue}</span>}
                </div>
                {v.description && <p className="mt-2 whitespace-pre-line text-sm text-content-secondary">{v.description}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </Layout>
  );
}
