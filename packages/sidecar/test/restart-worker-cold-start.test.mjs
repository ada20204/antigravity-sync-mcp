import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

describe('restart-worker cold-start mode', () => {
    it('should parse --cold-start flag', () => {
        const originalArgv = process.argv;
        process.argv = [
            'node',
            'restart-worker.js',
            '--workspace', '/workspace',
            '--antigravity-path', '/antigravity',
            '--port', '9001',
            '--config-dir', '/config',
            '--cold-start',
        ];

        const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
        delete require.cache[require.resolve(workerPath)];
        const worker = require(workerPath);

        const { getColdStart } = worker.__testExports;
        assert.strictEqual(getColdStart(), true);

        process.argv = originalArgv;
    });

    it('should default to restart mode without --cold-start', () => {
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

        const { getColdStart } = worker.__testExports;
        assert.strictEqual(getColdStart(), false);

        process.argv = originalArgv;
    });
});
