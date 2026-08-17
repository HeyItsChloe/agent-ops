// Wraps runOutreachPipeline behind the generic PipelineHandler interface
// (pipeline-orchestrator's engine), so the outreach pipeline registers
// exactly like job-search-pipeline and dev-ticket-pipeline. This deployment's
// own private pipeline — the scrape→dedup→store→generate→draft→notify flow
// lives in jobs/outreach/run.ts; this file is only the engine adapter +
// input/params validation.
import { z } from "zod";
import type { PipelineHandler, PipelineHandlerContext, PipelineResult } from "@heyitschloe/pipeline-orchestrator";
import { runOutreachPipeline, type OutreachPipelineDeps, type OutreachRunRequest } from "../jobs/outreach/run.js";
import type { OutreachSkillConfig, OutreachSkillName, OutreachVertical } from "../jobs/outreach/types.js";
import { DEFAULT_VERTICAL } from "../jobs/outreach/types.js";

const SkillNameSchema = z.enum(["outreach-email", "follow-up-email", "partnership-email"]);

const SenderIdentitySchema = z.object({
  name: z.string(),
  company: z.string(),
  role: z.string().optional(),
  email: z.string(),
  signature: z.string().optional(),
});

// The registry `params` shape for this pipeline (validated by the engine
// against this schema before the handler trusts it).
export const OutreachParamsSchema = z.object({
  model_profile: z.string(),
  vertical_label: z.string().default(DEFAULT_VERTICAL.label),
  search_terms: z.array(z.string()).default(DEFAULT_VERTICAL.searchTerms),
  target_per_run: z.number().int().positive().default(25),
  skill: SkillNameSchema.default("outreach-email"),
  tone: z.string().default("warm, concise, professional"),
  cta: z.string().default("a brief 15-minute intro call"),
  sender: SenderIdentitySchema,
  variables: z.record(z.string()).optional(),
});

// Per-call overrides callers can pass in ctx.job.input (all optional — the
// registry defaults win when omitted).
const InputSchema = z.object({
  vertical_label: z.string().optional(),
  search_terms: z.array(z.string()).optional(),
  target_per_run: z.number().int().positive().optional(),
  skill: SkillNameSchema.optional(),
  tone: z.string().optional(),
  cta: z.string().optional(),
  variables: z.record(z.string()).optional(),
});

export function createOutreachPipelineHandler(deps: OutreachPipelineDeps): PipelineHandler {
  return {
    name: "outreach-pipeline",
    paramsSchema: OutreachParamsSchema,
    async run(ctx: PipelineHandlerContext): Promise<PipelineResult> {
      const params = OutreachParamsSchema.safeParse(ctx.pipeline.params);
      if (!params.success) {
        return { status: "error", message: `invalid params: ${JSON.stringify(params.error.flatten())}` };
      }
      const input = InputSchema.safeParse(ctx.job.input ?? {});
      if (!input.success) {
        return { status: "error", message: `invalid input: ${JSON.stringify(input.error.flatten())}` };
      }

      const p = params.data;
      const i = input.data;

      const vertical: OutreachVertical = {
        label: i.vertical_label ?? p.vertical_label,
        searchTerms: i.search_terms ?? p.search_terms,
      };
      const skill: OutreachSkillName = i.skill ?? p.skill;
      const skillConfig: OutreachSkillConfig = {
        skill,
        tone: i.tone ?? p.tone,
        cta: i.cta ?? p.cta,
        sender: p.sender,
        variables: { ...(p.variables ?? {}), ...(i.variables ?? {}) },
      };

      const request: OutreachRunRequest = {
        vertical,
        target: i.target_per_run ?? p.target_per_run,
        skillConfig,
        correlationId: ctx.job.correlationId,
        requestedBy: ctx.job.requestedBy,
      };

      try {
        const summary = await runOutreachPipeline(deps, request);
        const message = `outreach: collected ${summary.companiesCollected}, drafted ${summary.draftsCreated}, ${summary.failures.length} failure(s)`;
        return { status: "complete", message, data: summary };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
