import { describe, it } from 'node:test';
import assert from 'node:assert';
import { selectWorkerLaunchPort, getRegistryActiveCdpCandidate } from '../src/endpoint-resolver.js';

describe('endpoint-resolver', () => {
    describe('selectWorkerLaunchPort', () => {
        it('prioritizes current CDP port for restart', () => {
            const result = selectWorkerLaunchPort({
                action: 'restart',
                currentCdpPort: 9000,
                registryCdpPort: 9001,
                allocatedPort: 9002,
                fixedPort: 9003,
            });
            assert.strictEqual(result.port, 9000);
            assert.strictEqual(result.source, 'current');
        });

        it('falls back to registry for restart when no current port', () => {
            const result = selectWorkerLaunchPort({
                action: 'restart',
                currentCdpPort: null,
                registryCdpPort: 9001,
                allocatedPort: 9002,
            });
            assert.strictEqual(result.port, 9001);
            assert.strictEqual(result.source, 'registry');
        });

        it('uses allocated port for launch action', () => {
            const result = selectWorkerLaunchPort({
                action: 'launch',
                currentCdpPort: 9000,
                registryCdpPort: 9001,
                allocatedPort: 9002,
            });
            assert.strictEqual(result.port, 9002);
            assert.strictEqual(result.source, 'allocated');
        });

        it('falls back to fixed port', () => {
            const result = selectWorkerLaunchPort({
                action: 'launch',
                currentCdpPort: null,
                registryCdpPort: null,
                allocatedPort: null,
                fixedPort: 9003,
            });
            assert.strictEqual(result.port, 9003);
            assert.strictEqual(result.source, 'fixed');
        });

        it('returns unresolved when no port available', () => {
            const result = selectWorkerLaunchPort({
                action: 'launch',
            });
            assert.strictEqual(result.port, null);
            assert.strictEqual(result.source, 'unresolved');
        });

        it('skips current/registry for launch action', () => {
            const result = selectWorkerLaunchPort({
                action: 'launch',
                currentCdpPort: 9000,
                registryCdpPort: 9001,
                allocatedPort: null,
                fixedPort: null,
            });
            assert.strictEqual(result.port, null);
            assert.strictEqual(result.source, 'unresolved');
        });
    });

    describe('getRegistryActiveCdpCandidate', () => {
        it('returns null for empty registry', () => {
            const result = getRegistryActiveCdpCandidate({}, '/workspace', 'ws-1');
            assert.strictEqual(result, null);
        });

        it('matches by workspace key', () => {
            const registry = {
                '/workspace': {
                    port: 9001,
                    ip: '127.0.0.1',
                    state: 'ready',
                },
            };
            const result = getRegistryActiveCdpCandidate(registry, '/workspace', 'ws-1');
            assert.strictEqual(result.port, 9001);
            assert.strictEqual(result.match, 'workspace-key');
        });

        it('matches by workspace_id', () => {
            const registry = {
                '/other-path': {
                    workspace_id: 'ws-1',
                    port: 9002,
                    ip: '127.0.0.1',
                    state: 'ready',
                },
            };
            const result = getRegistryActiveCdpCandidate(registry, '/workspace', 'ws-1');
            assert.strictEqual(result.port, 9002);
            assert.strictEqual(result.match, 'workspace-id');
        });

        it('prefers active CDP endpoint port', () => {
            const registry = {
                '/workspace': {
                    port: 9001,
                    ip: '127.0.0.1',
                    state: 'ready',
                    cdp: {
                        active: { host: '127.0.0.1', port: 9005, source: 'probe' },
                    },
                },
            };
            const result = getRegistryActiveCdpCandidate(registry, '/workspace', 'ws-1');
            assert.strictEqual(result.port, 9005);
            assert.strictEqual(result.source, 'probe');
        });

        it('skips __control__ key', () => {
            const registry = {
                '__control__': { port: 9999 },
                '/workspace': { port: 9001, ip: '127.0.0.1' },
            };
            const result = getRegistryActiveCdpCandidate(registry, '/workspace', 'ws-1');
            assert.strictEqual(result.port, 9001);
        });

        it('picks higher-scoring candidate', () => {
            const registry = {
                '/workspace': {
                    port: 9001,
                    ip: '127.0.0.1',
                    state: 'idle',
                },
                '/other': {
                    workspace_id: 'ws-1',
                    port: 9002,
                    ip: '127.0.0.1',
                    state: 'ready',
                },
            };
            // /workspace matches by key (score 8+0 idle = 8)
            // /other matches by workspace_id (score 6+3 ready = 9)
            // 9 > 8, so /other wins
            const result = getRegistryActiveCdpCandidate(registry, '/workspace', 'ws-1');
            assert.strictEqual(result.port, 9002);
        });
    });
});
