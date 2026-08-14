import { useParams } from 'react-router-dom';
import { Layout } from '../components/Layout/Layout';
import { Breadcrumbs } from '../components/Layout/Breadcrumbs';
import { automation, getAutomation } from '../data/automation';
import { CodeBlock } from '../components/ui/CodeBlock';
import { PipelineCard, categoryMeta } from '../components/PipelineCard';
import type { AutomationDoc } from '../types';

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="bg-background-elevated px-4 py-3">
      <div className="text-2xl font-extrabold tabular-nums tracking-tight text-white">{n}</div>
      <div className="mt-0.5 text-[0.66rem] font-bold uppercase tracking-wider text-content-muted">{label}</div>
    </div>
  );
}

// Categories that exist as tokens but that this repo's registry doesn't use -
// shown as a muted "available for app repos" hint, mirroring the extractor's
// derivation set.
const ALL_CATEGORIES = ['dev', 'ci', 'e2e', 'email', 'crawler', 'docs', 'deploy', 'sync', 'jobsearch'];

/** The card matrix shown at /automation (no :pipeline param). */
function Matrix() {
  const present = Array.from(new Set(automation.map((a) => a.category)));
  const execModels = Array.from(new Set(automation.map((a) => a.executionKind)));
  const inProcess = automation.filter((a) => a.executionKind === 'in-process').length;
  const absent = ALL_CATEGORIES.filter((c) => !present.includes(c));

  return (
    <Layout>
      <Breadcrumbs items={[{ title: 'Automation', href: '/automation' }, { title: 'All pipelines' }]} />
      <h1 className="mt-4 text-heading-lg font-bold text-white">Automation</h1>
      <p className="mt-2 prose-body">
        Every pipeline registered in <code className="font-mono text-content-secondary">orchestrator/src/registry/pipelines.yaml</code>, grouped by
        capability. Select any card to open its detail page.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-surface-border bg-surface-border sm:grid-cols-4">
        <Stat n={automation.length} label="Pipelines" />
        <Stat n={present.length} label="Categories" />
        <Stat n={execModels.length} label="Execution models" />
        <Stat n={inProcess} label="In-process" />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-surface-border bg-surface px-4 py-3">
        <span className="text-[0.66rem] font-bold uppercase tracking-widest text-content-muted">Category</span>
        {present.map((c) => {
          const { label, color } = categoryMeta(c);
          return (
            <span key={c} className="inline-flex items-center gap-1.5 text-[0.74rem] font-bold uppercase tracking-wide" style={{ color }}>
              <span className="h-[0.55em] w-[0.55em] rounded-sm" style={{ background: color }} />
              {label}
            </span>
          );
        })}
        {absent.length > 0 && (
          <span className="font-mono text-xs text-content-muted">+ {absent.join(' · ')} — available for app repos</span>
        )}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {automation.map((p) => (
          <PipelineCard key={p.slug} pipeline={p} />
        ))}
      </div>
    </Layout>
  );
}

/** The existing per-pipeline detail view (unchanged). */
function Detail({ pipeline }: { pipeline: AutomationDoc }) {
  return (
    <Layout>
      <Breadcrumbs items={[{ title: 'Automation', href: '/automation' }, { title: pipeline.name }]} />
      <h1 className="mt-4 text-heading-lg font-bold text-white">{pipeline.name}</h1>
      <p className="mt-2 prose-body">{pipeline.description}</p>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-content-muted">Handler</div>
          <div className="mt-1 font-mono text-content">{pipeline.handler}</div>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-content-muted">Execution</div>
          <div className="mt-1 font-mono text-content">
            {pipeline.executionKind}
            {pipeline.workflow ? ` (${pipeline.workflow})` : ''}
          </div>
        </div>
      </div>

      {pipeline.triggers.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-content-muted">Triggers</div>
          <ul className="list-disc list-inside space-y-1 prose-body">
            {pipeline.triggers.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-content-muted">Params</div>
        <CodeBlock code={JSON.stringify(pipeline.params, null, 2)} language="json" />
      </div>
    </Layout>
  );
}

export function Automation() {
  const { pipeline: slug } = useParams();

  // Detail route (/automation/:pipeline) — unchanged.
  if (slug) {
    const pipeline = getAutomation(slug);
    if (!pipeline) {
      return (
        <Layout>
          <p className="prose-body">Pipeline "{slug}" not found.</p>
        </Layout>
      );
    }
    return <Detail pipeline={pipeline} />;
  }

  // Index route (/automation) — the new card matrix.
  if (automation.length === 0) {
    return (
      <Layout>
        <p className="prose-body">No automation pipelines have been extracted yet. Run the wiki generator to populate this page.</p>
      </Layout>
    );
  }
  return <Matrix />;
}
