import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsNetstatListeningPid } from '../src/pid-resolver.js';

test('parseWindowsNetstatListeningPid extracts exact listening pid for port', () => {
    const output = [
        '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       4242',
        '  TCP    127.0.0.1:19000        0.0.0.0:0              LISTENING       9999',
    ].join('\n');

    assert.equal(parseWindowsNetstatListeningPid(output, 9000), 4242);
});

test('parseWindowsNetstatListeningPid ignores non-listening and partial port matches', () => {
    const output = [
        '  TCP    127.0.0.1:19000        0.0.0.0:0              LISTENING       9999',
        '  TCP    127.0.0.1:9000         127.0.0.1:55555        ESTABLISHED     4242',
    ].join('\n');

    assert.equal(parseWindowsNetstatListeningPid(output, 9000), null);
});
