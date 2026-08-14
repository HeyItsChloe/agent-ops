import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';
import type { AutomationDoc } from '../types';

// Category → label + CSS colour var. The card reads the colour through the
// `--cat` custom property it sets inline, so any category renders correctly
// without a per-category Tailwind class explosion.
const CATEGORY: Record<string, { label: string; varName: string }> = {
  dev: { label: 'Dev / Agent', varName: '--cat-dev' },
  ci: { label: 'CI', varName: '--cat-ci' },
  e2e: { label: 'E2E', varName: '--cat-e2e' },
  email: { label: 'Email', varName: '--cat-email' },
  crawler: { label: 'Crawler', varName: '--cat-crawler' },
  docs: { label: 'Docs', varName: '--cat-docs' },
  deploy: { label: 'Deploy', varName: '--cat-deploy' },
  sync: { label: 'Sync', varName: '--cat-sync' },
  jobsearch: { label: 'Job search', varName: '--cat-jobsearch' },
};

export function categoryMeta(category: string) {
  const m = CATEGORY[category];
  return { label: m?.label ?? category, color: m ? `var(${m.varName})` : '#71717a' };
}

/** A param → compact token label: `key: value` for primitives, `key[n]` for
 * arrays, `key` for objects, with the value truncated. Keys are the source of
 * truth (extracted); values are shown for readability only. */
function paramToken(key: string, value: unknown): string {
  if (Array.isArray(value)) return `${key}[${value.length}]`;
  if (value !== null && typeof value === 'object') return key;
  const v = String(value);
  return `${key}: ${v.length > 20 ? v.slice(0, 19) + '…' : v}`;
}

const EXEC_CLASS: Record<string, string> = {
  'in-process': 'text-status-success border-status-success/40',
  'github-actions': 'text-status-warning border-status-warning/40',
};

export function PipelineCard({ pipeline: p }: { pipeline: AutomationDoc }) {
  const { label, color } = categoryMeta(p.category);
  const paramKeys = Object.keys(p.params ?? {});

  return (
    <Link
      to={`/automation/${p.slug}`}
      style={{ '--cat': color, borderLeftColor: color } as CSSProperties}
      className="group flex flex-col gap-3.5 rounded-card border border-l-4 border-surface-border bg-surface p-[1.1rem] transition-fast hover:-translate-y-0.5 hover:border-surface-border-hover hover:bg-surface-hover"
    >
      <div className="flex flex-col gap-2">
        <span
          className="self-start inline-flex items-center rounded-full px-2 py-[0.18rem] text-[0.64rem] font-extrabold uppercase tracking-wider"
          style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
        >
          {label}
        </span>
        <h3 className="text-[1.05rem] font-semibold leading-tight text-white">{p.name}</h3>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-content-muted">
          <span className={cn('rounded border bg-background-elevated px-1.5 py-0.5 text-[0.68rem]', EXEC_CLASS[p.executionKind] ?? 'border-surface-border text-content-secondary')}>
            {p.executionKind}
          </span>
          {p.workflow && <span>{p.workflow}</span>}
        </div>
      </div>

      {p.triggers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[0.62rem] font-extrabold uppercase tracking-wider text-content-muted">Trigger</div>
          <ul className="flex flex-col gap-1">
            {p.triggers.map((t) => (
              <li key={t} className="flex gap-1.5 text-sm text-content-secondary">
                <span style={{ color }} aria-hidden>▸</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {paramKeys.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[0.62rem] font-extrabold uppercase tracking-wider text-content-muted">Params</div>
          <div className="flex flex-wrap gap-1.5">
            {paramKeys.map((k) => (
              <span key={k} className="rounded border border-surface-border bg-background-elevated px-1.5 py-0.5 font-mono text-xs text-content-secondary">
                {paramToken(k, (p.params as Record<string, unknown>)[k])}
              </span>
            ))}
          </div>
        </div>
      )}

      {p.outputs && p.outputs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[0.62rem] font-extrabold uppercase tracking-wider text-content-muted">
            Outputs
            <span className="rounded bg-brand-muted px-1 font-mono text-[0.56rem] font-semibold normal-case tracking-normal text-brand">authored</span>
          </div>
          <ul className="list-disc pl-4 text-sm text-content-secondary marker:text-[color:var(--cat)]">
            {p.outputs.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-0.5 text-xs font-bold text-content-muted transition-fast group-hover:text-[color:var(--cat)]">
        View pipeline
        <span className="transition-fast group-hover:translate-x-0.5" aria-hidden>→</span>
        <span className="ml-auto font-mono text-[0.7rem] font-medium text-content-muted">/automation/{p.slug}</span>
      </div>
    </Link>
  );
}
