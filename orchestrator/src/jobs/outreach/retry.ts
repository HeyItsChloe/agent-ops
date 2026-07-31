// Per-stage retry with exponential backoff + jitter, plus explicit
// Retry-After honoring for 429s (issue #11's rate-limit requirement). Kept
// tiny and dependency-free — the orchestrator already avoids new SDKs, and
// this is the one primitive every stage of the pipeline wraps its network
// work in.

export interface RetryOptions {
  retries?: number; // number of *retries* after the first attempt (default 3)
  baseDelayMs?: number; // first backoff delay (default 500ms)
  maxDelayMs?: number; // cap on any single backoff (default 30s)
  // Hook so callers/tests can observe/wait without real timers in unit tests.
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

// An error carrying a server-provided Retry-After (seconds). Providers that
// see a 429 should throw this so backoff honors the server's own hint rather
// than the exponential schedule.
export class RetryAfterError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryAfterError";
    this.retryAfterMs = retryAfterMs;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, maxDelayMs);
  // Full jitter: pick a random point in [0, capped] to avoid thundering-herd
  // retries when many candidates fail against the same rate-limited host.
  return Math.floor(Math.random() * capped);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const delayMs =
        error instanceof RetryAfterError
          ? Math.min(error.retryAfterMs, maxDelayMs)
          : backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(attempt + 1, delayMs, error);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
