import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const workerPath = path.join(__dirname, '../scripts/restart-worker.js');

function loadWorker() {
    delete require.cache[require.resolve(workerPath)];
    return require(workerPath);
}

describe('restart-worker', () => {
    describe('parameter parsing', () => {
        it('should parse basic parameters', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/path/to/workspace',
                '--antigravity-path', '/path/to/antigravity',
                '--port', '9001',
                '--bind-address', '127.0.0.1',
                '--config-dir', '/path/to/config',
            ];

            const worker = loadWorker();
            const { getWorkspace, getAntigravityPath, getPort, getBindAddress } = worker.__testExports;

            assert.strictEqual(getWorkspace(), '/path/to/workspace');
            assert.strictEqual(getAntigravityPath(), '/path/to/antigravity');
            assert.strictEqual(getPort(), '9001');
            assert.strictEqual(getBindAddress(), '127.0.0.1');

            process.argv = originalArgv;
        });

        it('should parse extra args', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/workspace',
                '--antigravity-path', '/antigravity',
                '--port', '9001',
                '--config-dir', '/config',
                '--extra-arg', '--verbose',
                '--extra-arg', '--debug',
            ];

            const worker = loadWorker();
            const { getExtraArgs } = worker.__testExports;
            const extraArgs = getExtraArgs();

            assert.deepStrictEqual(extraArgs, ['--verbose', '--debug']);

            process.argv = originalArgv;
        });

        it('should use default bind address', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/workspace',
                '--antigravity-path', '/antigravity',
                '--port', '9001',
                '--config-dir', '/config',
            ];

            const worker = loadWorker();
            const { getBindAddress } = worker.__testExports;

            assert.strictEqual(getBindAddress(), '127.0.0.1');

            process.argv = originalArgv;
        });
    });

    describe('buildLaunchArgs', () => {
        it('should build correct launch args', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/path/to/workspace',
                '--antigravity-path', '/path/to/antigravity',
                '--port', '9001',
                '--bind-address', '127.0.0.1',
                '--config-dir', '/config',
                '--extra-arg', '--verbose',
            ];

            const worker = loadWorker();
            const { buildLaunchArgs } = worker.__testExports;
            const args = buildLaunchArgs();

            assert.deepStrictEqual(args, [
                '/path/to/workspace',
                '--new-window',
                '--remote-debugging-port=9001',
                '--remote-debugging-address=127.0.0.1',
                '--verbose',
            ]);

            process.argv = originalArgv;
        });
    });

    describe('validation', () => {
        it('should fail validation when missing required args', () => {
            const originalArgv = process.argv;
            const originalExit = process.exit;
            let exitCalled = false;

            process.exit = (code) => {
                exitCalled = true;
                throw new Error('process.exit(' + code + ')');
            };

            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/workspace',
            ];

            const worker = loadWorker();
            const { validateArgs } = worker.__testExports;

            assert.throws(() => {
                validateArgs();
            }, /process\.exit/);

            assert.strictEqual(exitCalled, true);

            process.argv = originalArgv;
            process.exit = originalExit;
        });
    });

    describe('windows process detection', () => {
        it('should detect a running process from powershell output', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9001',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { checkProcessExists } = worker.__testExports;

            const exists = checkProcessExists('C:\\Program Files\\Antigravity\\Antigravity.exe', {
                platform: 'win32',
                execSync() {
                    return '1\r\n'; // PowerShell Count=1
                },
            });

            assert.strictEqual(exists, true);
            process.argv = originalArgv;
        });

        it('should treat zero count as not running', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9001',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { checkProcessExists } = worker.__testExports;

            const exists = checkProcessExists('C:\\Program Files\\Antigravity\\Antigravity.exe', {
                platform: 'win32',
                execSync() {
                    return '0\r\n'; // PowerShell Count=0
                },
            });

            assert.strictEqual(exists, false);
            process.argv = originalArgv;
        });

        it('should detect a listening port from netstat output', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9003',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { checkListeningPort } = worker.__testExports;

            const exists = checkListeningPort(9003, {
                platform: 'win32',
                execSync() {
                    return [
                        '  TCP    127.0.0.1:9003         0.0.0.0:0              LISTENING       4242',
                        '  TCP    127.0.0.1:19003        0.0.0.0:0              LISTENING       9999',
                    ].join('\r\n');
                },
            });

            assert.strictEqual(exists, true);
            process.argv = originalArgv;
        });
    });

    describe('windows launch', () => {
        it('should launch by spawning the executable directly', () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9002',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { launchWindowsDetached } = worker.__testExports;
            const calls = [];
            let unrefCalled = false;

            launchWindowsDetached(
                'C:\\Program Files\\Antigravity\\Antigravity.exe',
                ['C:\\workspace', '--new-window', '--remote-debugging-port=9002'],
                {
                    spawn(command, args, options) {
                        calls.push({ command, args, options });
                        return { unref() { unrefCalled = true; } };
                    },
                },
            );

            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].command, 'C:\\Program Files\\Antigravity\\Antigravity.exe');
            assert.deepStrictEqual(calls[0].args, ['C:\\workspace', '--new-window', '--remote-debugging-port=9002']);
            assert.deepStrictEqual(calls[0].options, {
                detached: true,
                stdio: 'ignore',
                shell: false,
                windowsHide: true,
            });
            assert.strictEqual(unrefCalled, true);
            process.argv = originalArgv;
        });
    });

    describe('file replacement retry', () => {
        it('should retry transient rename failures on windows-style file locks', async () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9002',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { replaceFileWithRetry } = worker.__testExports;
            let attempts = 0;
            let delays = 0;

            await replaceFileWithRetry('tmp.db', 'target.db', {
                renameSync() {
                    attempts++;
                    if (attempts < 3) {
                        const error = new Error('locked');
                        error.code = 'EPERM';
                        throw error;
                    }
                },
                existsSync() {
                    return true;
                },
                delay: async () => {
                    delays++;
                },
                retries: 5,
                retryDelayMs: 1,
            });

            assert.strictEqual(attempts, 3);
            assert.strictEqual(delays, 2);
            process.argv = originalArgv;
        });
    });

    describe('windows relaunch cooldown', () => {
        it('should wait before relaunch on windows', async () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9002',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { waitForWindowsRelaunchCooldown } = worker.__testExports;
            const waits = [];

            const waited = await waitForWindowsRelaunchCooldown({
                platform: 'win32',
                delay: async (ms) => {
                    waits.push(ms);
                },
            });

            assert.strictEqual(waited, 1500);
            assert.deepStrictEqual(waits, [1500]);
            process.argv = originalArgv;
        });

        it('should skip relaunch cooldown on non-windows platforms', async () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/workspace',
                '--antigravity-path', '/Applications/Antigravity.app/Contents/MacOS/Electron',
                '--port', '9002',
                '--config-dir', '/config',
            ];

            const worker = loadWorker();
            const { waitForWindowsRelaunchCooldown } = worker.__testExports;
            const waits = [];

            const waited = await waitForWindowsRelaunchCooldown({
                platform: 'darwin',
                delay: async (ms) => {
                    waits.push(ms);
                },
            });

            assert.strictEqual(waited, 0);
            assert.deepStrictEqual(waits, []);
            process.argv = originalArgv;
        });
    });

    describe('windows launch signal', () => {
        it('should treat a listening CDP port as launched even if process probe misses', async () => {
            const originalArgv = process.argv;
            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', 'C:\\workspace',
                '--antigravity-path', 'C:\\Program Files\\Antigravity\\Antigravity.exe',
                '--port', '9003',
                '--config-dir', 'C:\\config',
            ];

            const worker = loadWorker();
            const { waitForLaunchSignal } = worker.__testExports;
            let processChecks = 0;
            let portChecks = 0;

            const launched = await waitForLaunchSignal('Antigravity', {
                platform: 'win32',
                timeoutMs: 10,
                intervalMs: 1,
                checkProcessExists() {
                    processChecks++;
                    return false;
                },
                checkListeningPort() {
                    portChecks++;
                    return true;
                },
                delay: async () => {},
            });

            assert.strictEqual(launched, true);
            assert.strictEqual(processChecks > 0, true);
            assert.strictEqual(portChecks > 0, true);
            process.argv = originalArgv;
        });
    });
});

