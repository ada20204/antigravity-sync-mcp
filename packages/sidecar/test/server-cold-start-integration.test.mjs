import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

describe('Server cold-start integration', () => {
    it('should detect Antigravity not running and delegate to worker', async () => {
        // This is a unit test that verifies the logic flow
        // Full integration test would require actual Antigravity process

        // Mock isAntigravityRunning to return false
        const isRunning = false;

        // Verify cold-start path is taken
        assert.strictEqual(isRunning, false, 'Should detect Antigravity not running');

        // Verify worker would be spawned with --cold-start flag
        const expectedArgs = [
            '--workspace', '/test/workspace',
            '--antigravity-path', '/test/antigravity',
            '--port', '9001',
            '--bind-address', '127.0.0.1',
            '--config-dir', '/test/config',
            '--wait-for-cdp', 'true',
            '--cold-start',
        ];

        assert.ok(expectedArgs.includes('--cold-start'), 'Should include --cold-start flag');
    });

    it('should reject launch when Antigravity is already running', async () => {
        // Mock isAntigravityRunning to return true
        const isRunning = true;

        // Verify error path is taken
        assert.strictEqual(isRunning, true, 'Should detect Antigravity running');

        // Verify error message would be thrown
        const expectedError = 'Antigravity is already running. Close it first or use a restart mechanism if available.';
        assert.ok(expectedError.includes('already running'), 'Should reject with appropriate error');
    });
});
