import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLatestResponse } from '../dist/scripts.js';

function makeMockCdp(value) {
  return {
    contexts: [{ id: 1 }],
    async call(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(params.contextId, 1);
      return { result: { value } };
    },
    close() {},
  };
}

test('extractLatestResponse strips composer/footer noise from transcript text', async () => {
  const transcript = [
    '请只回复 OK',
    'Thought for <1s',
    '',
    'Advancing Toward the Goal',
    '',
    'OK',
    '',
    'Good',
    'Bad',
    '',
    'Ask anything, @ to mention, / for workflows',
    '',
    'Fast',
    'Gemini 3.1 Pro (Low)',
    'Send',
  ].join('\n');

  const result = await extractLatestResponse(makeMockCdp({ text: transcript }), '请只回复 OK');

  assert.equal(result, 'OK');
});

test('extractLatestResponse returns only last answer segment when thought text exists', async () => {
  const transcript = [
    '请只回复 TEST123',
    'Thought for 1s',
    '',
    'Initiating Task Execution',
    '',
    "I'm now focused on the next phase.",
    '',
    'TEST123',
  ].join('\n');

  const result = await extractLatestResponse(makeMockCdp({ text: transcript }), '请只回复 TEST123');
  assert.equal(result, 'TEST123');
});

test('extractLatestResponse does not return composer-only placeholder text', async () => {
  const composerOnly = 'Ask anything, @ to mention, / for workflows\n\nFast\nGemini 3.1 Pro (Low)\nSend';
  const result = await extractLatestResponse(makeMockCdp({ text: composerOnly }), 'irrelevant');

  assert.ok(result.toLowerCase().includes('could not be extracted'));
});
