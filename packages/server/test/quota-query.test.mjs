import test from "node:test";
import assert from "node:assert/strict";

import {
  extractActiveModelId,
  summarizeQuota,
  formatQuotaReport,
} from "../build/dist/quota-query.js";

test("extractActiveModelId resolves nested selectedModel id", () => {
  const payload = {
    conversation: {
      metadata: {
        selectedModel: {
          modelId: "gemini-3-pro-high",
        },
      },
    },
  };
  const id = extractActiveModelId(payload);
  assert.equal(id, "gemini-3-pro-high");
});

test("summarizeQuota prioritizes active model when selected marker exists", () => {
  const summary = summarizeQuota({
    timestamp: Date.now(),
    models: [
      { modelId: "gemini-3-flash", remainingPercentage: 80, isSelected: false },
      { modelId: "opus-4.6", remainingPercentage: 30, isSelected: true },
    ],
    promptCredits: { remainingPercentage: 65 },
  });
  assert.ok(summary);
  assert.equal(summary.activeModelName, "opus-4.6");
  assert.equal(summary.activeModelRemaining, 30);
  assert.equal(summary.promptRemaining, 65);
  assert.equal(summary.minModelRemaining, 30);
});

test("formatQuotaReport renders source and tracked models", () => {
  const text = formatQuotaReport({
    source: "live_ls",
    targetDir: "/tmp/demo",
    quota: {
      timestamp: Date.now(),
      activeModelId: "gemini-3-flash",
      models: [{ modelId: "gemini-3-flash", remainingPercentage: 50, isSelected: true }],
      promptCredits: { remainingPercentage: 90 },
    },
  });
  assert.match(text, /source: live_ls/);
  assert.match(text, /targetDir: \/tmp\/demo/);
  assert.match(text, /models:/);
  assert.match(text, /gemini-3-flash/);
});
