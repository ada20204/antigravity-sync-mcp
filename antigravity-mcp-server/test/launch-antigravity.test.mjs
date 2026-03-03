import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchArgs, resolveLaunchPort } from '../build/dist/launch-antigravity.js';

test('buildLaunchArgs includes target directory and new-window semantics', () => {
    const args = buildLaunchArgs({
        targetDir: '/home/elliot/antigravity-sync',
        port: 9000,
    });

    assert.equal(args[0], '/home/elliot/antigravity-sync');
    assert.equal(args[1], '--new-window');
    assert.ok(args.includes('--remote-debugging-port=9000'));
    // Bind address is environment-dependent; just verify the arg is present
    assert.ok(args.some(a => a.startsWith('--remote-debugging-address=')));
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

test('buildLaunchArgs respects ANTIGRAVITY_CDP_BIND_ADDRESS override', () => {
    process.env.ANTIGRAVITY_CDP_BIND_ADDRESS = '192.168.1.1';
    try {
        const args = buildLaunchArgs({ targetDir: '/tmp/test', port: 9000 });
        const addrArg = args.find(a => a.startsWith('--remote-debugging-address='));
        assert.equal(addrArg, '--remote-debugging-address=192.168.1.1');
    } finally {
        delete process.env.ANTIGRAVITY_CDP_BIND_ADDRESS;
    }
});

test('buildLaunchArgs uses 127.0.0.1 by default', () => {
    delete process.env.ANTIGRAVITY_CDP_BIND_ADDRESS;
    const args = buildLaunchArgs({ targetDir: '/tmp/test', port: 9000 });
    const addrArg = args.find(a => a.startsWith('--remote-debugging-address='));
    assert.equal(addrArg, '--remote-debugging-address=127.0.0.1');
});
