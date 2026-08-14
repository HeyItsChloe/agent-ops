/**
 * Shared content-model types for the wiki-site template.
 *
 * These mirror BusyBuddy_v2's original hand-maintained docs/frontend/src/types
 * (endpoints/apps/workflows), generalized and extended with two new entity
 * kinds (AutomationDoc, TestSuiteDoc) called for by issue #286. Every
 * `scripts/wiki-extractors/*.mjs` module writes arrays typed against one of
 * these interfaces into `src/data/*.generated.json`, which the matching
 * `src/data/*.ts` wrapper re-exports `as` this type. Never hand-edit the
 * `*.generated.json` files - they are the extractors' idempotent merge
 * target (see scripts/wiki-extractors/merge.mjs).
 */

export interface NavChild {
  title: string;
  href: string;
}

export interface NavSection {
  title: string;
  href: string;
  children: NavChild[];
}

export interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
  in: 'query' | 'body' | 'path' | 'header';
}

export type AuthKind = 'session' | 'app-proxy' | 'admin-api-key' | 'partner-token' | 'bearer' | 'api-key' | 'none';

export interface EndpointDoc {
  slug: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  title: string;
  description: string;
  auth: AuthKind;
  authNote: string;
  params: ParamDoc[];
  requestExample?: string;
  responseExample: string;
  /**
   * Historically meant "callable without auth from the browser" (the old
   * CORS-limited sandbox). With the wiki-backend proxy in place every
   * endpoint is sandbox-testable given user-supplied auth, so this now just
   * means "the sandbox will attempt a real call instead of only showing the
   * mocked responseExample" - see Sandbox.tsx.
   */
  liveTestable: boolean;
  /** Source file this endpoint was extracted from, for traceability. */
  sourceFile?: string;
}

export interface EndpointGroup {
  slug: string;
  title: string;
  description: string;
  endpoints: EndpointDoc[];
}

export interface AppDoc {
  slug: string;
  name: string;
  color: string;
  icon?: string;
  tagline: string;
  plans: string[];
  overview: string;
  keyFeatures: string[];
  configuration: string[];
  storefrontBehavior: string;
}

export interface WorkflowStep {
  name: string;
  detail: string;
}

export interface WorkflowJob {
  name: string;
  runsOn: string;
  steps: WorkflowStep[];
}

export interface WorkflowDoc {
  slug: string;
  title: string;
  file: string;
  trigger: string;
  description: string;
  jobs: WorkflowJob[];
}

/** One entry per pipeline this repo participates in, sourced from agent-ops's pipelines.yaml. */
export interface AutomationDoc {
  slug: string;
  name: string;
  handler: string;
  /** Semantic capability category (dev, jobsearch, crawler, …) for the matrix. */
  category: string;
  executionKind: string;
  workflow?: string;
  triggers: string[];
  params: Record<string, unknown>;
  description: string;
  /** Authored (no registry source) — rendered only when present. */
  outputs?: string[];
}

/** Suite-level (not individual-test-level) coverage summary. */
export interface TestSuiteDoc {
  slug: string;
  name: string;
  framework: 'playwright' | 'gradle-instrumented' | 'vitest' | 'jest' | 'other';
  path: string;
  fileCount: number;
  description: string;
}

/** A verbatim-ingested markdown doc, registered into the nav. */
export interface MarkdownPageDoc {
  slug: string;
  title: string;
  sourcePath: string;
  contentFile: string;
  navSection: string;
}

export interface ChangelogEntry {
  date: string;
  added: string[];
  changed: string[];
  fixed: string[];
}

// ---------------------------------------------------------------------------
// Authored-content layer (agent-ops issue #286 extension). Facts are still
// extracted; the entities below carry the agent-authored narrative.
// ---------------------------------------------------------------------------

export type NoteKind = 'tip' | 'note' | 'warning' | 'important';

export interface NoteBlock {
  kind: NoteKind;
  body: string;
}

export interface FeatureImplements {
  workflows: string[];
  skills: string[];
  dependencies: string[];
  integrations: string[];
}

/** A hand-authored feature page (src/content/features/<slug>.md frontmatter). */
export interface FeatureDoc {
  slug: string;
  title: string;
  summary: string;
  order: number;
  status: string;
  implements: FeatureImplements;
  runWith: string[];
  tradeoffs: string[];
  notes: NoteBlock[];
  contentFile: string;
}

/** One SKILL.md, ingested from frontmatter (name/description/applies_to). */
export interface SkillDoc {
  slug: string;
  title: string;
  description: string;
  appliesTo: string;
  category: string;
  path: string;
}

/** One declared npm dependency from a package.json manifest. */
export interface DependencyDoc {
  slug: string;
  name: string;
  version: string;
  kind: 'dependency' | 'devDependency';
  component: string;
  packageFile: string;
}

/** A non-npm third party (GitHub App, LiteLLM, Cloud Run, APIs), authored in wiki.config.yaml. */
export interface IntegrationDoc {
  slug: string;
  name: string;
  kind: string;
  summary: string;
  auth: string;
  url: string;
  notes: NoteBlock[];
}

/** One LiteLLM gateway alias (litellm/config.yaml model_list), extracted. */
export interface ModelAliasDoc {
  slug: string;
  /** The alias pipeline components address (e.g. "planning"). */
  alias: string;
  /** The concrete provider model behind it (e.g. "gemini/gemini-2.5-flash"). */
  model: string;
  /** Env var holding the provider key (e.g. "GEMINI_API_KEY"), or '' if none. */
  apiKeyEnv: string;
  /** Custom api_base if set (e.g. a local Ollama), else ''. */
  apiBase: string;
  /** Aliases this one falls back to, from router_settings.fallbacks. */
  fallbacks: string[];
}

/** One environment variable from a .env.example, extracted. */
export interface EnvVarDoc {
  slug: string;
  name: string;
  /** True iff the code requires it (a requireEnv("NAME") call), not a guess. */
  required: boolean;
  description: string;
  component: string;
  defaultValue: string;
}
