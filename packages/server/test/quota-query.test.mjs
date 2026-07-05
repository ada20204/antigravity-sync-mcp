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
  // group-style body: "<group> — <pct>% left (<reset> / <window>)" then a member line
  assert.match(text, /% left/);
  assert.match(text, /gemini-3-flash \[active\]/);
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

test('groupQuotaModels groups by family and infers the binding window', async () => {
  const { groupQuotaModels } = await import('../build/dist/quota-query.js');
  const H = 60 * 60 * 1000;
  const groups = groupQuotaModels([
    { label: 'Gemini 3.5 Flash (High)', remainingPercentage: 0.3, resetTime: '2026-07-03T18:08:01Z', resetInMs: 8 * H },
    { label: 'Gemini 3.1 Pro (Low)', remainingPercentage: 0.3, resetTime: '2026-07-03T18:08:01Z', resetInMs: 8 * H },
    { label: 'Claude Sonnet 4.6 (Thinking)', remainingPercentage: 99.9, resetTime: '2026-07-03T13:24:36Z', resetInMs: 3 * H },
    { label: 'GPT-OSS 120B (Medium)', remainingPercentage: 99.9, resetTime: '2026-07-03T13:24:36Z', resetInMs: 3 * H },
  ]);

  const gemini = groups.find((g) => g.name === 'Gemini models');
  const claudeGpt = groups.find((g) => g.name === 'Claude/GPT models');
  assert.equal(groups.length, 2);
  assert.equal(gemini.remainingPercentage, 0.3);
  assert.equal(gemini.window, 'weekly limit');
  assert.equal(gemini.models.length, 2);
  assert.equal(claudeGpt.remainingPercentage, 99.9);
  assert.equal(claudeGpt.window, '5-hour limit');
});

test('groupQuotaModels skips null entries and falls back to unknown window', async () => {
  const { groupQuotaModels } = await import('../build/dist/quota-query.js');
  const groups = groupQuotaModels([
    null,
    { label: 'Gemini 3.5 Flash (High)', remainingPercentage: 42, resetTime: '' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].window, 'unknown');
  assert.equal(groups[0].remainingPercentage, 42);
  assert.equal(groups[0].models.length, 1);
});

test('renderQuotaBar clamps and rounds to the slot count', async () => {
  const { renderQuotaBar } = await import('../build/dist/quota-query.js');
  assert.equal(renderQuotaBar(99.9), '██████████');
  assert.equal(renderQuotaBar(0.3), '░░░░░░░░░░');
  assert.equal(renderQuotaBar(45), '█████░░░░░');
  assert.equal(renderQuotaBar(null), '░░░░░░░░░░');
  assert.equal(renderQuotaBar(NaN), '░░░░░░░░░░');
  assert.equal(renderQuotaBar(150), '██████████');
  assert.equal(renderQuotaBar(-5), '░░░░░░░░░░');
});

test('formatResetIn renders hours, minutes, zero and missing values', async () => {
  const { formatResetIn } = await import('../build/dist/quota-query.js');
  const H = 60 * 60 * 1000;
  assert.equal(formatResetIn(7 * H + 49 * 60 * 1000), '7h 49m');
  assert.equal(formatResetIn(2 * H + 5 * 60 * 1000), '2h 05m');
  assert.equal(formatResetIn(12 * 60 * 1000), '12m');
  assert.equal(formatResetIn(0), 'now');
  assert.equal(formatResetIn(-1000), 'now');
  assert.equal(formatResetIn(undefined), '');
  assert.equal(formatResetIn(NaN), '');
});
