// Bootstrap for this deployment: imports the generic engine from the public
// pipeline-orchestrator package, registers the shipped dev-ticket-pipeline
// handler (used for busybuddy-dev) alongside this repo's own private
// job-search-pipeline handler, and boots one server — see
// docs/docs-sites-review-handoff.md and the conversation that designed this
// split for why. Also mounts the two Chrome-extension routes
// (applications_lookup.ts, generate_answer.ts) directly on the Express app
// createServer() returns, since those are this deployment's own HTTP
// surface, not part of the generic engine's trigger layer.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer,
  createDevTicketPipelineHandler,
  sharedSecretAuth,
  extensionAuth,
  type GitHubAppConfig,
} from "@heyitschloe/pipeline-orchestrator";
import { createJobSearchPipelineHandler } from "./handlers/job_search_pipeline.js";
import { createOutreachPipelineHandler } from "./handlers/outreach_pipeline.js";
import { outreachDepsFromEnv } from "./jobs/outreach/run.js";
import { handleApplicantProfileLookup, handleApplicationsLookup } from "./triggers/applications_lookup.js";
import { handleGenerateAnswer } from "./triggers/generate_answer.js";
import { mountEmailRoutes } from "./integrations/email/route.js";
import type { ApplicantProfile } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

const githubApp: GitHubAppConfig = {
  appId: requireEnv("GH_APP_ID"),
  privateKey: requireEnv("GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
};

// Two installations of the same GitHub App (pipeline-orchestrator-management):
// one on the 11thandOrange org (dev-ticket-pipeline dispatch, e.g.
// BusyBuddy_v2), one on the heyitschloe personal account (job-search
// pipeline's own skill fetch, the-store append). Using the wrong one for
// either 404s at the token-minting step.
const devInstallationId = requireEnv("GH_APP_INSTALLATION_ID");
const personalInstallationId = requireEnv("GH_APP_INSTALLATION_ID_PERSONAL");

const liteLLM = { proxyUrl: requireEnv("LITELLM_PROXY_URL"), virtualKey: requireEnv("LITELLM_VIRTUAL_KEY") };

const apiSourcing = process.env.JSEARCH_API_KEY
  ? { jsearch: { baseUrl: process.env.JSEARCH_BASE_URL ?? "https://prod.api.market/api/v1/openwebninja/jobsearch", apiKey: process.env.JSEARCH_API_KEY } }
  : undefined;
const siteSessions = process.env.SITE_SESSIONS_DIR ? { sessionsDir: process.env.SITE_SESSIONS_DIR } : undefined;
const scrapeAnySourcing =
  process.env.SERPAPI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.JSEARCH_API_KEY
    ? {
        serpapi: process.env.SERPAPI_API_KEY ? { apiKey: process.env.SERPAPI_API_KEY } : undefined,
        claudeWebSearch: process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : undefined,
        jsearch: process.env.JSEARCH_API_KEY
          ? { baseUrl: process.env.JSEARCH_BASE_URL ?? "https://prod.api.market/api/v1/openwebninja/jobsearch", apiKey: process.env.JSEARCH_API_KEY }
          : undefined,
      }
    : undefined;
const theStore =
  process.env.THE_STORE_OWNER && process.env.THE_STORE_REPO
    ? {
        owner: process.env.THE_STORE_OWNER,
        repo: process.env.THE_STORE_REPO,
        branch: process.env.THE_STORE_BRANCH ?? "main",
        path: process.env.THE_STORE_PATH ?? "projects/job-applications/job-app-results.csv",
      }
    : undefined;
const applicantProfile: ApplicantProfile | undefined =
  process.env.APPLICANT_FIRST_NAME &&
  process.env.APPLICANT_LAST_NAME &&
  process.env.APPLICANT_EMAIL &&
  process.env.APPLICANT_PHONE &&
  process.env.APPLICANT_PROFESSIONAL_SUMMARY
    ? {
        firstName: process.env.APPLICANT_FIRST_NAME,
        lastName: process.env.APPLICANT_LAST_NAME,
        email: process.env.APPLICANT_EMAIL,
        phone: process.env.APPLICANT_PHONE,
        professionalSummary: process.env.APPLICANT_PROFESSIONAL_SUMMARY,
        resumeGdriveLink: process.env.APPLICANT_RESUME_GDRIVE_LINK,
        location: process.env.APPLICANT_LOCATION,
        linkedinUrl: process.env.APPLICANT_LINKEDIN_URL,
        portfolioUrl: process.env.APPLICANT_PORTFOLIO_URL,
        currentTitle: process.env.APPLICANT_CURRENT_TITLE,
        currentEmployer: process.env.APPLICANT_CURRENT_EMPLOYER,
        yearsExperience: process.env.APPLICANT_YEARS_EXPERIENCE,
        workAuthorization: process.env.APPLICANT_WORK_AUTHORIZATION,
        sponsorshipRequired: process.env.APPLICANT_SPONSORSHIP_REQUIRED,
        desiredSalary: process.env.APPLICANT_DESIRED_SALARY,
        availability: process.env.APPLICANT_AVAILABILITY,
      }
    : undefined;

const controlRepoOwner = process.env.CONTROL_REPO_OWNER ?? "HeyItsChloe";
const controlRepoName = process.env.CONTROL_REPO_NAME ?? "agent-ops";
const controlRepoBranch = process.env.CONTROL_REPO_BRANCH ?? "main";
const registryPath = process.env.REGISTRY_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "registry", "pipelines.yaml");
const sharedSecret = requireEnv("ORCHESTRATOR_SHARED_SECRET");
const extensionApiKey = process.env.EXTENSION_API_KEY;
const port = Number(process.env.PORT ?? 3000);

const personalPipelineDeps = {
  githubApp,
  installationId: personalInstallationId,
  controlRepoOwner,
  controlRepoName,
  branch: controlRepoBranch,
  liteLLM,
  apiSourcing,
  scrapingSourcing: siteSessions,
  scrapeAllSourcing: siteSessions,
  scrapeAnySourcing,
  theStore,
  applicantProfile,
};

// Outreach pipeline deps — reuses the same personal installation (the-store
// append + skill fetch) and LiteLLM gateway as the job-search pipeline.
// Optional integrations (the-store, Gmail, Discord) resolve to undefined
// when unset, fail-open, matching the_store.ts's posture.
const outreachDeps = outreachDepsFromEnv(githubApp, personalInstallationId, liteLLM);

const app = createServer(
  {
    port,
    sharedSecret,
    githubWebhookSecret: requireEnv("GH_WEBHOOK_SECRET"),
    githubApp,
    installationId: devInstallationId,
    allowedMentionAuthors: (process.env.ALLOWED_MENTION_AUTHORS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    registryPath,
    scaffold: { controlRepoOwner, controlRepoName, branch: controlRepoBranch },
  },
  [
    createDevTicketPipelineHandler({ githubApp, installationId: devInstallationId }),
    createJobSearchPipelineHandler(personalPipelineDeps),
    createOutreachPipelineHandler(outreachDeps),
  ],
);

// The Chrome extension's endpoints — mounted only when EXTENSION_API_KEY is
// actually configured, rather than existing 401-locked.
if (extensionApiKey) {
  app.get("/personal-projects/:project/applications", extensionAuth(extensionApiKey), handleApplicationsLookup({ githubApp, installationId: personalInstallationId, theStore }));
  app.get("/personal-projects/:project/applicant-profile", extensionAuth(extensionApiKey), handleApplicantProfileLookup({ applicantProfile }));
  app.post("/personal-projects/:project/generate-answer", extensionAuth(extensionApiKey), handleGenerateAnswer({ liteLLM, applicantProfile }));
}

// The shared email pipeline's REST surface (Epic 6, ticket #19) — POST
// /email, guarded by the same ORCHESTRATOR_SHARED_SECRET as the engine's own
// endpoints. Always mounted: each provider reads its own credentials at send
// time and returns a not-ok EmailResult if they're unset, rather than the
// route existing only when configured.
mountEmailRoutes(app, sharedSecret);

app.listen(port, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", message: "agent-ops orchestrator listening", port }));
});

// Re-exported so sharedSecretAuth stays a used import if a future route is
// added here directly rather than through the engine.
export { sharedSecretAuth };
