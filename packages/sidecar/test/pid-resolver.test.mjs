import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveListeningPidForPort, parseWindowsNetstatListeningPid, parsePosixLsofListeningPid } from '../src/pid-resolver.js';

describe('pid-resolver', () => {
    describe('parseWindowsNetstatListeningPid', () => {
        it('parses PID from netstat output', () => {
            const output = [
                '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       1234',
                '  TCP    127.0.0.1:9001         0.0.0.0:0              LISTENING       5678',
            ].join('\r\n');
            assert.strictEqual(parseWindowsNetstatListeningPid(output, 9000), 1234);
            assert.strictEqual(parseWindowsNetstatListeningPid(output, 9001), 5678);
        });

        it('returns null when port not found', () => {
            const output = '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       1234\r\n';
            assert.strictEqual(parseWindowsNetstatListeningPid(output, 9999), null);
        });

        it('ignores non-LISTENING states', () => {
            const output = '  TCP    127.0.0.1:9000         0.0.0.0:0              ESTABLISHED     1234\r\n';
            assert.strictEqual(parseWindowsNetstatListeningPid(output, 9000), null);
        });

        it('handles empty output', () => {
            assert.strictEqual(parseWindowsNetstatListeningPid('', 9000), null);
            assert.strictEqual(parseWindowsNetstatListeningPid(null, 9000), null);
        });

        it('does not match port as suffix of longer port number', () => {
            const output = '  TCP    127.0.0.1:19000        0.0.0.0:0              LISTENING       9999\r\n';
            assert.strictEqual(parseWindowsNetstatListeningPid(output, 9000), null);
        });
    });

    describe('parsePosixLsofListeningPid', () => {
        it('parses PID from lsof -t output', () => {
            assert.strictEqual(parsePosixLsofListeningPid('1234\n'), 1234);
        });

        it('takes first line when multiple PIDs', () => {
            assert.strictEqual(parsePosixLsofListeningPid('1234\n5678\n'), 1234);
        });

        it('returns null for empty output', () => {
            assert.strictEqual(parsePosixLsofListeningPid(''), null);
            assert.strictEqual(parsePosixLsofListeningPid(null), null);
        });

        it('returns null for non-numeric output', () => {
            assert.strictEqual(parsePosixLsofListeningPid('not-a-pid\n'), null);
        });
    });

    describe('resolveListeningPidForPort', () => {
        it('returns unresolved for invalid port', () => {
            const result = resolveListeningPidForPort(0);
            assert.strictEqual(result.pid, null);
            assert.strictEqual(result.source, 'unresolved');
            assert.strictEqual(result.attempts, 0);
        });

        it('returns unresolved for negative port', () => {
            const result = resolveListeningPidForPort(-1);
            assert.strictEqual(result.pid, null);
            assert.strictEqual(result.source, 'unresolved');
        });

        it('returns port_owner when PID found via lsof', () => {
            const result = resolveListeningPidForPort(9000, {
                dependencies: {
                    platform: 'darwin',
                    execSync: () => '42\n',
                },
            });
            assert.strictEqual(result.pid, 42);
            assert.strictEqual(result.source, 'port_owner');
            assert.strictEqual(result.attempts, 1);
        });

        it('returns port_owner when PID found via netstat on win32', () => {
            const netstatOutput = '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       99\r\n';
            const result = resolveListeningPidForPort(9000, {
                dependencies: {
                    platform: 'win32',
                    execSync: () => netstatOutput,
                },
            });
            assert.strictEqual(result.pid, 99);
            assert.strictEqual(result.source, 'port_owner');
        });

        it('returns unresolved when execSync throws', () => {
            const result = resolveListeningPidForPort(9000, {
                dependencies: {
                    platform: 'darwin',
                    execSync: () => { throw new Error('no process'); },
                },
            });
            assert.strictEqual(result.pid, null);
            assert.strictEqual(result.source, 'unresolved');
            assert.strictEqual(result.attempts, 1);
        });

        it('retries specified number of times', () => {
            let calls = 0;
            const result = resolveListeningPidForPort(9000, {
                retries: 3,
                delayMs: 0,
                dependencies: {
                    platform: 'darwin',
                    execSync: () => {
                        calls++;
                        throw new Error('no process');
                    },
                },
            });
            assert.strictEqual(result.pid, null);
            assert.strictEqual(result.source, 'unresolved');
            assert.strictEqual(result.attempts, 3);
            assert.strictEqual(calls, 3);
        });

        it('succeeds on retry', () => {
            let calls = 0;
            const result = resolveListeningPidForPort(9000, {
                retries: 3,
                delayMs: 0,
                dependencies: {
                    platform: 'darwin',
                    execSync: () => {
                        calls++;
                        if (calls < 2) throw new Error('not yet');
                        return '55\n';
                    },
                },
            });
            assert.strictEqual(result.pid, 55);
            assert.strictEqual(result.source, 'port_owner');
            assert.strictEqual(result.attempts, 2);
        });
    });
});
