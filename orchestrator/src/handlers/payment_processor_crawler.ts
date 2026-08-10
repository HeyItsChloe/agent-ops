// Wraps the payment-processor crawler (src/crawler/pipeline.ts) behind the
// generic PipelineHandler interface, registering it exactly like the
// job-search-pipeline handler so POST /trigger can invoke it. Same pattern:
// a paramsSchema the engine validates the registry `params` bag against, an
// InputSchema for per-call overrides, and a run() that builds the crawler
// request and returns a PipelineResult.
import { z } from "zod";
import type { PipelineHandler, PipelineHandlerContext, PipelineResult } from "@heyitschloe/pipeline-orchestrator";
import { runCrawler, type CrawlerDeps } from "../crawler/pipeline.js";
import { CrawlerConfigSchema } from "../crawler/types.js";

// The registry `params` for this pipeline ARE the crawler config — so the
// handler's paramsSchema is just the crawler config schema. The engine treats
// params as opaque; this is where we make it concrete and validated.
export const PaymentProcessorCrawlerParamsSchema = CrawlerConfigSchema;

// Per-call overrides callers may pass in ctx.job.input (chat/curl), each
// falling back to the registry default when omitted — same override posture
// as the job-search handler's InputSchema.
const InputSchema = z
  .object({
    seeds: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    maxPages: z.number().int().positive().optional(),
    maxDomains: z.number().int().positive().optional(),
    perHostDelayMs: z.number().int().nonnegative().optional(),
    dryRun: z.boolean().optional(),
    searchProvider: z.enum(["serpapi", "claude_web_search", "jsearch"]).optional(),
  })
  .default({});

export function createPaymentProcessorCrawlerHandler(deps: CrawlerDeps): PipelineHandler {
  return {
    name: "payment-processor-crawler",
    paramsSchema: PaymentProcessorCrawlerParamsSchema,
    async run(ctx: PipelineHandlerContext): Promise<PipelineResult> {
      const input = InputSchema.safeParse(ctx.job.input ?? {});
      if (!input.success) {
        return { status: "error", message: `invalid input: ${JSON.stringify(input.error.flatten())}` };
      }

      // Merge registry defaults with per-call overrides, then re-validate the
      // merged shape so downstream code always sees a fully-defaulted config.
      const merged = CrawlerConfigSchema.safeParse({ ...(ctx.pipeline.params as object), ...stripUndefined(input.data) });
      if (!merged.success) {
        return { status: "error", message: `invalid crawler config: ${JSON.stringify(merged.error.flatten())}` };
      }

      // observationDate is captured ONCE per run here and threaded through so
      // provenance stamping stays pure/reproducible (Ticket 32).
      const result = await runCrawler(merged.data, deps, {
        correlationId: ctx.job.correlationId,
        requestedBy: ctx.job.requestedBy,
        observationDate: new Date().toISOString(),
      });

      // Do NOT persist here — the-store is Epic 8. Return the records + a
      // one-line summary message for the caller to surface.
      const s = result.summary;
      const message = `crawler ${s.dryRun ? "dry run" : "run"}: discovered ${s.discovered}, fetched ${s.fetched}, failed ${s.failed}, ${s.records} processor record(s)`;
      return { status: "complete", message, data: result };
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
