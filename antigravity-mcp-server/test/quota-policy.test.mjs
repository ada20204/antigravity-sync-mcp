import test from 'node:test';
import assert from 'node:assert/strict';

import { selectModelWithQuotaPolicy } from '../build/dist/quota-policy.js';

test('selectModelWithQuotaPolicy defaults to fast chain when no inputs provided', () => {
  const result = selectModelWithQuotaPolicy({});

  assert.equal(result.mode, 'fast');
  assert.equal(result.selectedModel, 'gemini-3-flash');
  assert.equal(result.staleQuota, true);
  assert.deepEqual(result.skipped, []);
});

test('selectModelWithQuotaPolicy prioritizes requested model when quota is stale', () => {
  const now = Date.now();
  const result = selectModelWithQuotaPolicy({
    mode: 'plan',
    requestedModel: 'gemini-3-pro-high',
    quota: { timestamp: now - 11 * 60 * 1000, models: [] },
    nowMs: now,
  });

  assert.equal(result.mode, 'plan');
  assert.equal(result.selectedModel, 'gemini-3-pro-high');
  assert.equal(result.staleQuota, true);
});

test('selectModelWithQuotaPolicy skips exhausted models when quota is fresh', () => {
  const now = Date.now();
  // Fast chain: gemini-3-flash → sonnet-4.6 → gemini-3-pro-low → …
  // Mark flash and sonnet-4.6 exhausted; pro-low has quota → pro-low wins.
  const result = selectModelWithQuotaPolicy({
    mode: 'fast',
    quota: {
      timestamp: now,
      models: [
        { modelId: 'gemini-3-flash', remainingFraction: 0 },
        { label: 'Claude Sonnet 4.6 (Thinking)', modelId: 'MODEL_PLACEHOLDER_M35', remainingFraction: 0 },
        { modelId: 'gemini-3-pro-low', remainingFraction: 0.4 },
      ],
    },
    nowMs: now,
  });

  assert.equal(result.staleQuota, false);
  assert.equal(result.selectedModel, 'gemini-3-pro-low');
  assert.deepEqual(result.skipped, [
    { model: 'gemini-3-flash', reason: 'quota_exhausted' },
    { model: 'sonnet-4.6', reason: 'quota_exhausted' },
  ]);
});

test('selectModelWithQuotaPolicy matches real registry label "Gemini 3.1 Pro (High)"', () => {
  const now = Date.now();
  const result = selectModelWithQuotaPolicy({
    mode: 'fast',
    requestedModel: 'gemini-3-pro-high',
    quota: {
      timestamp: now,
      models: [
        { modelId: 'MODEL_PLACEHOLDER_M37', label: 'Gemini 3.1 Pro (High)', remainingFraction: 0 },
      ],
    },
    nowMs: now,
  });

  // gemini-3-pro-high is exhausted via real label match → skip, fall back to next in chain
  assert.equal(result.staleQuota, false);
  assert.ok(result.skipped.some((s) => s.model === 'gemini-3-pro-high'), 'expected gemini-3-pro-high to be skipped');
});

test('selectModelWithQuotaPolicy matches real registry label "Gemini 3.1 Pro (Low)"', () => {
  const now = Date.now();
  const result = selectModelWithQuotaPolicy({
    mode: 'fast',
    quota: {
      timestamp: now,
      models: [
        { modelId: 'MODEL_PLACEHOLDER_M18', label: 'Gemini 3 Flash', remainingFraction: 0 },
        { modelId: 'MODEL_PLACEHOLDER_M35', label: 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 0 },
        { modelId: 'MODEL_PLACEHOLDER_M36', label: 'Gemini 3.1 Pro (Low)', remainingFraction: 0.8 },
      ],
    },
    nowMs: now,
  });

  assert.equal(result.selectedModel, 'gemini-3-pro-low');
});

test('selectModelWithQuotaPolicy resolves "sonnet-4.6" user input', () => {
  const now = Date.now();
  const result = selectModelWithQuotaPolicy({
    mode: 'fast',
    requestedModel: 'sonnet-4.6',
    quota: { timestamp: now, models: [] },
    nowMs: now,
  });

  // With quota unknown for all, the first candidate (sonnet-4.6 after reorder) is selected.
  assert.equal(result.selectedModel, 'sonnet-4.6');
});

test('selectModelWithQuotaPolicy matches real registry full snapshot', () => {
  // Reproduces real registry data; all have quota except opus-4.6 which is 0.2 remaining.
  const now = Date.now();
  const result = selectModelWithQuotaPolicy({
    mode: 'plan',
    quota: {
      timestamp: now,
      models: [
        { modelId: 'MODEL_PLACEHOLDER_M18', label: 'Gemini 3 Flash', remainingFraction: 1 },
        { modelId: 'MODEL_PLACEHOLDER_M35', label: 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 0.2 },
        { modelId: 'MODEL_PLACEHOLDER_M26', label: 'Claude Opus 4.6 (Thinking)', remainingFraction: 0.2 },
        { modelId: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', label: 'GPT-OSS 120B (Medium)', remainingFraction: 0.2 },
        { modelId: 'MODEL_PLACEHOLDER_M37', label: 'Gemini 3.1 Pro (High)', remainingFraction: 1 },
        { modelId: 'MODEL_PLACEHOLDER_M36', label: 'Gemini 3.1 Pro (Low)', remainingFraction: 1 },
      ],
    },
    nowMs: now,
  });

  // Plan chain: opus-4.6 → gemini-3-pro-high → sonnet-4.6 → …
  // opus-4.6 has 0.2 remaining → ok → selected.
  assert.equal(result.selectedModel, 'opus-4.6');
  assert.equal(result.staleQuota, false);
});
