import test from 'node:test';
import assert from 'node:assert/strict';

import { createWaitStateEngine } from '../build/dist/wait-state.js';
import { isTrajectoryTerminal } from '../build/dist/ls-client.js';

function makeDiscovered(overrides = {}) {
  return {
    port: 9222,
    ip: '127.0.0.1',
    target: {
      id: 'target',
      title: 'Antigravity',
      url: 'file:///workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
      type: 'page',
    },
    ...overrides,
  };
}

test('createWaitStateEngine falls back to DOM polling when LS endpoint is missing', async () => {
  const engine = await createWaitStateEngine({
    discovered: makeDiscovered(),
  });

  const check = await engine.check(5000);
  assert.equal(check.completed, false);
  assert.equal(check.lsUsable, false);
  assert.equal(check.note, 'ls_endpoint_unavailable');
  engine.close();
});

test('isTrajectoryTerminal recognizes common terminal signals', () => {
  assert.equal(isTrajectoryTerminal({ status: 'finished' }), true);
  assert.equal(isTrajectoryTerminal({ nested: { done: true } }), true);
  assert.equal(isTrajectoryTerminal({ state: 'running' }), false);
});

test('isTrajectoryTerminal does not false-positive on substrings', () => {
  // "stopwatch" contains "stop" but should not match
  assert.equal(isTrajectoryTerminal({ status: 'stopwatch' }), false);
  // "incomplete" contains "complete" but should not trigger
  assert.equal(isTrajectoryTerminal({ state: 'incomplete' }), false);
  // "failure_fallback" — "fail" substring, but word boundary should prevent match
  // Note: "failure" itself matches \bfail(ed|ure)?\b so test a compound non-word
  assert.equal(isTrajectoryTerminal({ status: 'prefailure' }), false);
});

test('isTrajectoryTerminal matches word-boundary terminal values', () => {
  assert.equal(isTrajectoryTerminal({ status: 'done' }), true);
  assert.equal(isTrajectoryTerminal({ state: 'completed' }), true);
  assert.equal(isTrajectoryTerminal({ status: 'stopped' }), true);
  assert.equal(isTrajectoryTerminal({ state: 'cancelled' }), true);
  assert.equal(isTrajectoryTerminal({ status: 'failed' }), true);
  assert.equal(isTrajectoryTerminal({ status: 'failure' }), true);
});
