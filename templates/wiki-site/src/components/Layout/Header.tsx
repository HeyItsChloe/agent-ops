import { Link } from 'react-router-dom';
import { Github } from 'lucide-react';
import { wikiConfig } from '../../wiki.config.generated';

// The favicon doubles as the title-button icon, so both are per-repo and
// stay in sync. Prefix with Vite's base so it resolves on a project site
// (e.g. /agent-ops/) and on a custom-domain root alike.
const iconHref = import.meta.env.BASE_URL + (wikiConfig.favicon || '/favicon.svg').replace(/^\//, '');

// Minimal header: the site title (which IS the home link, with its icon) and
// a GitHub link. All section navigation lives in the sidebar - no tabs.
export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-surface-border bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-container-lg items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 text-xl font-bold shrink-0 truncate">
          <img src={iconHref} alt="" className="h-6 w-6 shrink-0 rounded" />
          <span className="text-brand">{wikiConfig.title}</span>
        </Link>
        {wikiConfig.githubUrl && (
          <a
            href={wikiConfig.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-button border border-surface-border bg-surface px-3 py-1.5 text-sm text-content-secondary hover:text-white hover:border-surface-border-hover transition-fast"
          >
            <Github size={15} />
            GitHub
          </a>
        )}
      </div>
    </header>
  );
}
