import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchArgs, resolveLaunchPort } from '../dist/launch-antigravity.js';

test('buildLaunchArgs includes target directory and new-window semantics', () => {
  const args = buildLaunchArgs({
    targetDir: '/home/elliot/antigravity-sync',
    port: 9000,
  });

  assert.equal(args[0], '/home/elliot/antigravity-sync');
  assert.equal(args[1], '--new-window');
  assert.ok(args.includes('--remote-debugging-port=9000'));
  assert.ok(args.includes('--remote-debugging-address=0.0.0.0'));
});

test('resolveLaunchPort prefers launch env over cdp env', () => {
  const prevLaunch = process.env.ANTIGRAVITY_LAUNCH_PORT;
  const prevCdp = process.env.ANTIGRAVITY_CDP_PORT;
  process.env.ANTIGRAVITY_LAUNCH_PORT = '9001';
  process.env.ANTIGRAVITY_CDP_PORT = '9222';
  try {
    assert.equal(resolveLaunchPort(), 9001);
  } finally {
    if (prevLaunch === undefined) delete process.env.ANTIGRAVITY_LAUNCH_PORT;
    else process.env.ANTIGRAVITY_LAUNCH_PORT = prevLaunch;
    if (prevCdp === undefined) delete process.env.ANTIGRAVITY_CDP_PORT;
    else process.env.ANTIGRAVITY_CDP_PORT = prevCdp;
  }
});

