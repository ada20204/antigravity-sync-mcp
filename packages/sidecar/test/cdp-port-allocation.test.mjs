/**
 * Unit tests for allocateFreeCdpPort() and parsePortCandidates()
 * Tasks: 4.1-4.8
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Mock vscode before requiring extension.js
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal vscode mock so extension.js can be loaded
const vscodeMock = {
    workspace: {
        getConfiguration: () => ({ get: (k, d) => d }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        workspaceFolders: [],
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => {},
            show: () => {},
            dispose: () => {},
        }),
        showWarningMessage: () => {},
        showErrorMessage: () => {},
        showInformationMessage: () => {},
        createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: async () => {},
    },
    env: { machineId: 'test-machine' },
    EventEmitter: class { fire() {} event = () => ({ dispose: () => {} }); },
    StatusBarAlignment: { Right: 2 },
    Uri: { file: (p) => ({ fsPath: p }) },
    extensions: { getExtension: () => null },
    context: {},
};

// Patch require('vscode') in the loaded module
const require = createRequire(import.meta.url);
const Module = require('node:module');
const _originalLoad = Module._load;
Module._load = function (id, ...rest) {
    if (id === 'vscode') return vscodeMock;
    return _originalLoad.call(this, id, ...rest);
};

const extensionPath = join(__dirname, '..', 'src', 'extension.js');
const { _testExports } = require(extensionPath);
const {
    allocateFreeCdpPort,
    parsePortCandidates,
    isStrictCdpPortSpec,
    buildPortCandidateOrder,
    collectRegistryOccupiedPorts,
} = _testExports;

// ─── allocateFreeCdpPort ────────────────────────────────────────────────────

test('4.1 allocateFreeCdpPort: empty registry returns 9000', () => {
    assert.equal(allocateFreeCdpPort({}, [9000, 9014]), 9000);
});

test('4.1 allocateFreeCdpPort: null registry returns 9000', () => {
    assert.equal(allocateFreeCdpPort(null, [9000, 9014]), 9000);
});

test('4.2 allocateFreeCdpPort: one occupied port (9000) returns 9001', () => {
    const registry = {
        '/ws/a': { local_endpoint: { port: 9000 } },
    };
    assert.equal(allocateFreeCdpPort(registry, [9000, 9014]), 9001);
});

test('4.3 allocateFreeCdpPort: non-sequential occupied ports returns lowest gap', () => {
    const registry = {
        '/ws/a': { local_endpoint: { port: 9000 } },
        '/ws/b': { local_endpoint: { port: 9002 } },
        '/ws/c': { local_endpoint: { port: 9004 } },
    };
    // 9001 is the lowest available
    assert.equal(allocateFreeCdpPort(registry, [9000, 9014]), 9001);
});

test('4.4 allocateFreeCdpPort: all ports occupied returns null', () => {
    const registry = {};
    for (let p = 9000; p <= 9014; p++) {
        registry[`/ws/${p}`] = { local_endpoint: { port: p } };
    }
    assert.equal(allocateFreeCdpPort(registry, [9000, 9014]), null);
});

test('4.5 allocateFreeCdpPort: missing registry file (undefined) returns 9000', () => {
    assert.equal(allocateFreeCdpPort(undefined, [9000, 9014]), 9000);
});

test('4.6 allocateFreeCdpPort: malformed entries (null port) are skipped', () => {
    const registry = {
        '/ws/a': { local_endpoint: { port: null } },
        '/ws/b': { local_endpoint: { port: 'bad' } },
        '/ws/c': { local_endpoint: { port: -1 } },
    };
    assert.equal(allocateFreeCdpPort(registry, [9000, 9014]), 9000);
});

test('4.6 allocateFreeCdpPort: __control__ entries are ignored', () => {
    const registry = {
        __control__: { local_endpoint: { port: 9000 } },
        '/ws/a': { local_endpoint: { port: 9001 } },
    };
    // 9000 should be free (control entry ignored), 9001 occupied
    assert.equal(allocateFreeCdpPort(registry, [9000, 9014]), 9000);
});

test('allocateFreeCdpPort: preferred port is selected when available', () => {
    const registry = {
        '/ws/a': { local_endpoint: { port: 9000 } },
    };
    const port = allocateFreeCdpPort(registry, [9000, 9014], { preferredPort: 9003 });
    assert.equal(port, 9003);
});

test('allocateFreeCdpPort: unavailablePorts are skipped', () => {
    const registry = {};
    const unavailable = new Set([9000, 9001, 9002]);
    const port = allocateFreeCdpPort(registry, [9000, 9014], { unavailablePorts: unavailable });
    assert.equal(port, 9003);
});

test('allocateFreeCdpPort: idempotent — same registry returns same port', () => {
    const registry = {
        '/ws/a': { local_endpoint: { port: 9000 } },
        '/ws/b': { local_endpoint: { port: 9001 } },
    };
    const first = allocateFreeCdpPort(registry, [9000, 9014]);
    const second = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(first, second);
    assert.equal(first, 9002);
});

test('buildPortCandidateOrder: preferred port is first then ascending range', () => {
    const ordered = buildPortCandidateOrder([9000, 9004], 9003);
    assert.deepEqual(ordered, [9003, 9000, 9001, 9002, 9004]);
});

test('collectRegistryOccupiedPorts: ignores control entries', () => {
    const occupied = collectRegistryOccupiedPorts({
        __control__: { local_endpoint: { port: 9000 } },
        '/ws/a': { local_endpoint: { port: 9002 } },
    });
    assert.equal(occupied.has(9000), false);
    assert.equal(occupied.has(9002), true);
});

// ─── parsePortCandidates ────────────────────────────────────────────────────

test('4.7 parsePortCandidates: "9000-9014" returns exactly 15 ports', () => {
    const ports = parsePortCandidates('9000-9014');
    assert.equal(ports.length, 15);
    assert.equal(ports[0], 9000);
    assert.equal(ports[14], 9014);
});

test('4.8 parsePortCandidates: old wide spec returns expected count', () => {
    // '9000-9014,8997-9003,9229,7800-7850'
    // 9000-9014 = 15, 8997-9003 = 7 (but 9000-9003 overlap with previous = 4 net new)
    // 9229 = 1, 7800-7850 = 51; deduplication handled by parsePortCandidates
    const ports = parsePortCandidates('9000-9014,8997-9003,9229,7800-7850');
    // Total unique = 15 + 4 (8997-9000 is 8997,8998,8999 + one already counted) ...
    // Let's just verify the Set size >= 70 before dedup is roughly correct
    // Actually verify it parses correctly: all ranges expanded
    const portSet = new Set(ports);
    // 9000-9014: 15, 8997-8999: 3 new, 9229: 1 new, 7800-7850: 51 new = 70 unique
    assert.equal(portSet.size, 70);
});

test('parsePortCandidates: single port spec', () => {
    const ports = parsePortCandidates('9000');
    assert.deepEqual(ports, [9000]);
});

test('parsePortCandidates: empty spec returns empty array', () => {
    const ports = parsePortCandidates('');
    assert.deepEqual(ports, []);
});

test('isStrictCdpPortSpec: accepts 9000-9014 only', () => {
    assert.equal(isStrictCdpPortSpec('9000-9014'), true);
    assert.equal(isStrictCdpPortSpec('9000,9001,9014'), true);
});

test('isStrictCdpPortSpec: rejects legacy/wide specs', () => {
    assert.equal(isStrictCdpPortSpec('9000-9014,8997-9003,9229,7800-7850'), false);
    assert.equal(isStrictCdpPortSpec('9000,9229'), false);
});

// ─── Multi-instance sequential launch simulation ────────────────────────────

test('multi-instance: 3 windows launched sequentially get ports 9000, 9001, 9002', () => {
    const registry = {};

    // Window 1: registry empty → allocate 9000, then register it
    const port1 = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(port1, 9000);
    registry['/ws/a'] = { local_endpoint: { port: port1 } };

    // Window 2: registry has 9000 → allocate 9001, then register it
    const port2 = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(port2, 9001);
    registry['/ws/b'] = { local_endpoint: { port: port2 } };

    // Window 3: registry has 9000, 9001 → allocate 9002
    const port3 = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(port3, 9002);
});

test('multi-instance: closing middle window frees port for reuse', () => {
    // Three windows running on 9000, 9001, 9002
    const registry = {
        '/ws/a': { local_endpoint: { port: 9000 } },
        '/ws/b': { local_endpoint: { port: 9001 } },
        '/ws/c': { local_endpoint: { port: 9002 } },
    };

    // Close window on port 9001
    delete registry['/ws/b'];

    // Next launch should reuse 9001 (lowest available)
    const port = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(port, 9001);
});

test('multi-instance: 15 windows fill all ports, 16th returns null', () => {
    const registry = {};
    for (let i = 0; i < 15; i++) {
        const port = allocateFreeCdpPort(registry, [9000, 9014]);
        assert.equal(port, 9000 + i, `window ${i + 1} should get port ${9000 + i}`);
        registry[`/ws/${i}`] = { local_endpoint: { port } };
    }
    // All 15 ports occupied, 16th returns null (no silent fallback)
    const overflow = allocateFreeCdpPort(registry, [9000, 9014]);
    assert.equal(overflow, null);
});

test('multi-instance: each window gets a unique port across 5 sequential launches', () => {
    const registry = {};
    const allocatedPorts = [];
    for (let i = 0; i < 5; i++) {
        const port = allocateFreeCdpPort(registry, [9000, 9014]);
        allocatedPorts.push(port);
        registry[`/ws/${i}`] = { local_endpoint: { port } };
    }
    // All ports must be unique
    const unique = new Set(allocatedPorts);
    assert.equal(unique.size, 5, `expected 5 unique ports, got: ${allocatedPorts}`);
    // Ports should be sequential from 9000
    assert.deepEqual(allocatedPorts, [9000, 9001, 9002, 9003, 9004]);
});
