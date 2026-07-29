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
import { sidebarSections, sectionKeyForPath } from '../../data/navigation';
import { cn } from '../../lib/cn';

// Full multi-section navigation tree. The header carries no tabs, so this is
// the primary navigator: every category header gets an icon, a background
// highlight, and white text (active = brand), and each section is
// collapsible; the section for the current route auto-expands and collapse
// state persists.
const STORAGE_KEY = 'wiki-sidebar-collapsed';

// Icon per section key, with sensible defaults for the app-repo section kinds
// and the common markdown navSections. Unknown sections fall back to a doc icon.
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

// Shared look for the 9 category headers (Overview + each section): icon +
// white text on a subtle highlight; active row uses the brand highlight.
function headerClass(active: boolean) {
  return cn(
    'flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-fast',
    active ? 'bg-brand-muted text-brand' : 'bg-surface text-white hover:bg-surface-hover'
  );
}

export function Sidebar() {
  const location = useLocation();
  const activeKey = sectionKeyForPath(location.pathname);
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
  const onOverview = location.pathname === '/';

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-surface-border bg-background">
      <nav className="flex-1 p-4 sticky top-16 self-start space-y-1.5">
        <Link to="/" className={headerClass(onOverview)}>
          <Home size={16} className="shrink-0" />
          Overview
        </Link>

        {Object.entries(sidebarSections).map(([key, section]) => {
          const hasChildren = section.children.length > 0;
          const isActive = key === activeKey;
          const isOpen = isActive || !collapsed[key];
          const Icon = SECTION_ICONS[key] ?? FileText;
          return (
            <div key={key}>
              <div className="flex items-center gap-1">
                <Link to={section.href} className={headerClass(isActive)}>
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{section.title}</span>
                </Link>
                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                    className={cn('shrink-0 rounded-lg p-1.5 transition-fast', isActive ? 'text-brand' : 'text-content-muted hover:text-white')}
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
