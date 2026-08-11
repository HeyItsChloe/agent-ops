import { Layout } from '../components/Layout/Layout';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { models } from '../data/models';

export function Models() {
  if (models.length === 0) {
    return (
      <Layout>
        <p className="prose-body">No model aliases have been extracted yet. Run the wiki generator to populate this page.</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <h1 className="text-heading-lg font-bold text-white">Model Gateway</h1>
      <p className="mt-2 prose-body">
        Every pipeline component addresses a model <strong>alias</strong> on the LiteLLM gateway, never a provider SDK.
        Repointing an alias is a one-line edit in <span className="font-mono">litellm/config.yaml</span>; nothing
        downstream changes.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {models.map((m) => (
          <Card key={m.slug} className="h-full">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-white">{m.alias}</span>
              {m.apiKeyEnv && <Badge>{m.apiKeyEnv}</Badge>}
            </div>
            <div className="mt-3 text-xs uppercase tracking-wider text-content-muted">Model</div>
            <div className="mt-1 font-mono text-sm text-content">{m.model || '—'}</div>
            {m.apiBase && (
              <>
                <div className="mt-3 text-xs uppercase tracking-wider text-content-muted">API base</div>
                <div className="mt-1 font-mono text-sm text-content">{m.apiBase}</div>
              </>
            )}
            {m.fallbacks.length > 0 && (
              <>
                <div className="mt-3 text-xs uppercase tracking-wider text-content-muted">Fallbacks</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {m.fallbacks.map((f) => (
                    <Badge key={f} tone="warning">{f}</Badge>
                  ))}
                </div>
              </>
            )}
          </Card>
        ))}
      </div>
    </Layout>
  );
}
