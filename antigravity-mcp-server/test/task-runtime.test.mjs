import test from "node:test";
import assert from "node:assert/strict";

import {
  createAskTask,
  transitionAskTask,
  withRetry,
  withTimeout,
  RetryableError,
  isTaskTerminal,
} from "../build/dist/task-runtime.js";

test("task state transitions append history and terminal detection works", () => {
  const task = createAskTask("hello");
  assert.equal(task.status, "queued");
  assert.equal(isTaskTerminal(task.status), false);

  transitionAskTask(task, "discovering");
  transitionAskTask(task, "running");
  transitionAskTask(task, "completed");

  assert.equal(task.status, "completed");
  assert.equal(isTaskTerminal(task.status), true);
  assert.equal(task.history.length >= 4, true); // queued + 3 transitions
});

test("withTimeout rejects on timeout", async () => {
  await assert.rejects(
    withTimeout(
      new Promise((resolve) => setTimeout(() => resolve("late"), 40)),
      5,
      "unit-timeout"
    ),
    /timed out/i
  );
});

test("withRetry retries retryable errors and then succeeds", async () => {
  let attempts = 0;
  const out = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new RetryableError("transient");
      }
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }
  );

  assert.equal(out, "ok");
  assert.equal(attempts, 3);
});

test("withRetry does not retry non-retryable errors", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new Error("fatal");
      },
      { maxAttempts: 4, baseDelayMs: 1, jitterMs: 0 }
    ),
    /fatal/
  );

  assert.equal(attempts, 1);
});
