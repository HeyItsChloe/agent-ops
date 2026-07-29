import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  Home,
  Sparkles,
  Workflow,
  Puzzle,
  Package,
  History,
  Map,
  GitPullRequest,
  Server,
  BookOpen,
  Code,
  LayoutGrid,
  Zap,
  FlaskConical,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import { sidebarSections } from '../../data/navigation';
import { cn } from '../../lib/cn';

// Full multi-section navigation tree. The header carries no tabs, so this is
// the primary navigator: every category header gets an icon; the active row
// is a filled brand pill, inactive rows are just underlined with white text;
// each section is collapsible and collapse state persists.
const STORAGE_KEY = 'wiki-sidebar-collapsed';

const SECTION_ICONS: Record<string, LucideIcon> = {
  features: Sparkles,
  'ci-cd': Workflow,
  skills: Puzzle,
  dependencies: Package,
  changelog: History,
  roadmap: Map,
  contributing: GitPullRequest,
  orchestrator: Server,
  docs: BookOpen,
  api: Code,
  apps: LayoutGrid,
  automation: Zap,
  tests: FlaskConical,
};

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

// Whole-row look: active = filled brand pill; inactive = underline only.
function rowClass(active: boolean) {
  return cn('flex items-center transition-fast', active ? 'rounded-lg bg-brand-muted' : 'border-b border-surface-border');
}
function labelClass(active: boolean) {
  return cn(
    'flex flex-1 items-center gap-2 px-3 py-2 text-sm font-semibold transition-fast',
    active ? 'text-brand' : 'text-white hover:text-brand'
  );
}

export function Sidebar() {
  const location = useLocation();
  // A section is active only when the first path segment actually names it -
  // no fallback to the first section, so the Overview page ("/") highlights
  // nothing but Overview.
  const seg = location.pathname.split('/').filter(Boolean)[0] ?? '';
  const activeKey = seg in sidebarSections ? seg : '';
  const onOverview = location.pathname === '/';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const isChildActive = (href: string) => location.pathname === href;

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-surface-border bg-background">
      <nav className="flex-1 p-4 sticky top-16 self-start space-y-1">
        <div className={rowClass(onOverview)}>
          <Link to="/" className={labelClass(onOverview)}>
            <Home size={16} className="shrink-0" />
            Overview
          </Link>
        </div>

        {Object.entries(sidebarSections).map(([key, section]) => {
          const hasChildren = section.children.length > 0;
          const isActive = key === activeKey;
          const isOpen = isActive || !collapsed[key];
          const Icon = SECTION_ICONS[key] ?? FileText;
          return (
            <div key={key}>
              <div className={rowClass(isActive)}>
                <Link to={section.href} className={labelClass(isActive)}>
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{section.title}</span>
                </Link>
                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                    className={cn('shrink-0 self-stretch px-2 transition-fast', isActive ? 'text-brand' : 'text-content-muted hover:text-white')}
                  >
                    <ChevronRight size={14} className={cn('transition-fast', isOpen && 'rotate-90')} />
                  </button>
                )}
              </div>
              {hasChildren && isOpen && (
                <div className="mt-0.5 space-y-0.5 pl-4">
                  {section.children.map((item) => (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={cn(
                        'block rounded-lg px-3 py-1.5 text-sm transition-fast',
                        isChildActive(item.href)
                          ? 'bg-brand-muted text-brand font-medium'
                          : 'text-content-secondary hover:text-white hover:bg-surface-hover'
                      )}
                    >
                      {item.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
