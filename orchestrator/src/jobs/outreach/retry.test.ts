// Retry/backoff tests with an injected synchronous sleep (no real timers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, RetryAfterError } from "./retry.js";

test("withRetry succeeds on first try without sleeping", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries up to `retries` times then throws the last error", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { retries: 3, sleep: async (ms) => void sleeps.push(ms) },
      ),
    /fail 4/,
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
  assert.equal(sleeps.length, 3);
});

test("withRetry honors RetryAfterError delay over exponential backoff", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new RetryAfterError("429", 5000);
      return "ok";
    },
    { retries: 2, sleep: async (ms) => void sleeps.push(ms), maxDelayMs: 30000 },
  );
  assert.equal(result, "ok");
  assert.deepEqual(sleeps, [5000]);
});
