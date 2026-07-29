import { wikiConfig } from '../wiki.config.generated';

/**
 * Applies wiki.config.yaml's literal theme/title/favicon values at runtime,
 * once, on load. Everything here comes straight from wiki.config.generated.ts
 * (itself a deterministic passthrough of wiki.config.yaml written by
 * scripts/wiki-generate.mjs) - never computed or invented.
 */
export function applyTheme() {
  const root = document.documentElement;
  root.style.setProperty('--wiki-accent', wikiConfig.theme.accent);
  root.style.setProperty('--wiki-accent-hover', wikiConfig.theme.accentHover);
  root.style.setProperty('--wiki-accent-muted', wikiConfig.theme.accentMuted);

  document.title = wikiConfig.title;

  // Prefix with Vite's base so the favicon resolves on a project site
  // (e.g. /agent-ops/) - a bare "/favicon.svg" would point at the domain
  // root and 404 there.
  const favicon = document.getElementById('wiki-favicon');
  if (favicon) favicon.setAttribute('href', import.meta.env.BASE_URL + (wikiConfig.favicon || '/favicon.svg').replace(/^\//, ''));
}
