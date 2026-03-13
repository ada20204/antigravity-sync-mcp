import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Module = require('node:module');

const vscodeMock = {
    workspace: {
        getConfiguration: () => ({ get: (k, d) => d }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        workspaceFolders: [],
    },
    window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
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

const originalLoad = Module._load;
Module._load = function (id, ...rest) {
    if (id === 'vscode') return vscodeMock;
    return originalLoad.call(this, id, ...rest);
};

const extensionPath = join(__dirname, '..', 'src', 'extension.js');
const { _testExports } = require(extensionPath);
const { parseWindowsNetstatListeningPid } = _testExports;

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
