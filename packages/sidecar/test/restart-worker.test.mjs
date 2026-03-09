import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

describe('restart-worker', () => {
    describe('parameter parsing', () => {
        it('should parse basic parameters', () => {
            // Mock process.argv
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

            // Import module to test
            const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
            delete require.cache[require.resolve(workerPath)];
            const worker = require(workerPath);

            const { getWorkspace, getAntigravityPath, getPort, getBindAddress } = worker.__testExports;

            assert.strictEqual(getWorkspace(), '/path/to/workspace');
            assert.strictEqual(getAntigravityPath(), '/path/to/antigravity');
            assert.strictEqual(getPort(), '9001');
            assert.strictEqual(getBindAddress(), '127.0.0.1');

            // Restore
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

            const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
            delete require.cache[require.resolve(workerPath)];
            const worker = require(workerPath);

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

            const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
            delete require.cache[require.resolve(workerPath)];
            const worker = require(workerPath);

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

            const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
            delete require.cache[require.resolve(workerPath)];
            const worker = require(workerPath);

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
                throw new Error(`process.exit(${code})`);
            };

            process.argv = [
                'node',
                'restart-worker.js',
                '--workspace', '/workspace',
                // Missing other required args
            ];

            const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
            delete require.cache[require.resolve(workerPath)];
            const worker = require(workerPath);

            const { validateArgs } = worker.__testExports;

            assert.throws(() => {
                validateArgs();
            }, /process\.exit/);

            assert.strictEqual(exitCalled, true);

            process.argv = originalArgv;
            process.exit = originalExit;
        });
    });
});
