import test from "node:test";
import assert from "node:assert/strict";

import {
  extractActiveModelId,
  summarizeQuota,
  formatQuotaReport,
  normalizeQuotaSnapshot,
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

test("normalizeQuotaSnapshot reads camelCase wire format", () => {
  const snap = normalizeQuotaSnapshot(
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: "Gemini 3 Flash",
              modelOrAlias: { model: "gemini-3-flash" },
              quotaInfo: { remainingFraction: 0.5, resetTime: "2026-06-05T00:00:00Z" },
            },
          ],
        },
      },
    },
    null
  );
  assert.equal(snap.models.length, 1);
  assert.equal(snap.models[0].modelId, "gemini-3-flash");
  assert.equal(snap.models[0].remainingFraction, 0.5);
  assert.equal(snap.models[0].resetTime, "2026-06-05T00:00:00Z");
});

test("normalizeQuotaSnapshot reads snake_case wire format (upstream >=v1.1.1)", () => {
  const snap = normalizeQuotaSnapshot(
    {
      userStatus: {
        cascade_model_config_data: {
          client_model_configs: [
            {
              label: "Gemini 3 Flash",
              model_or_alias: { model: "gemini-3-flash" },
              quota_info: { remaining_fraction: 0.5, reset_time: "2026-06-05T00:00:00Z" },
            },
          ],
        },
      },
    },
    null
  );
  // Without snake_case fallback this array would be empty → quota "unavailable".
  assert.equal(snap.models.length, 1);
  assert.equal(snap.models[0].modelId, "gemini-3-flash");
  assert.equal(snap.models[0].remainingFraction, 0.5);
  assert.equal(snap.models[0].resetTime, "2026-06-05T00:00:00Z");
});
