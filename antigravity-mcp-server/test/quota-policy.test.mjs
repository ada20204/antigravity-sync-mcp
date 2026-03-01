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
  const result = selectModelWithQuotaPolicy({
    mode: 'fast',
    quota: {
      timestamp: now,
      models: [
        { modelId: 'gemini-3-flash', remainingFraction: 0 },
        { modelId: 'gemini-3-pro-low', remainingFraction: 0.4 },
      ],
    },
    nowMs: now,
  });

  assert.equal(result.staleQuota, false);
  assert.equal(result.selectedModel, 'gemini-3-pro-low');
  assert.deepEqual(result.skipped, [{ model: 'gemini-3-flash', reason: 'quota_exhausted' }]);
});
