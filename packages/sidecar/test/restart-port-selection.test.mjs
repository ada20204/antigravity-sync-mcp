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
const {
  selectWorkerLaunchPort,
  describeWorkerLaunchPortSource,
  getRegistryActiveCdpCandidate,
} = _testExports;

test('restart prefers current active cdp port over newly allocated port', () => {
  const port = selectWorkerLaunchPort({
    action: 'restart',
    currentCdpPort: 9011,
    allocatedPort: 9002,
    fixedPort: 0,
  });

  assert.equal(port, 9011);
});

test('launch keeps allocated port when no active cdp port should be reused', () => {
  const port = selectWorkerLaunchPort({
    action: 'launch',
    currentCdpPort: 9011,
    allocatedPort: 9002,
    fixedPort: 0,
  });

  assert.equal(port, 9002);
});

test('restart falls back to allocated port when current cdp port is unavailable', () => {
  const port = selectWorkerLaunchPort({
    action: 'restart',
    currentCdpPort: null,
    allocatedPort: 9002,
    fixedPort: 0,
  });

  assert.equal(port, 9002);
});

test('restart prefers registry cdp port when current cdp port is unavailable', () => {
  const port = selectWorkerLaunchPort({
    action: 'restart',
    currentCdpPort: null,
    registryCdpPort: 9011,
    allocatedPort: 9002,
    fixedPort: 0,
  });

  assert.equal(port, 9011);
});

test('port selection source explains registry fallback', () => {
  const source = describeWorkerLaunchPortSource({
    action: 'restart',
    currentCdpPort: null,
    registryCdpPort: 9011,
    allocatedPort: 9002,
    fixedPort: 0,
  });

  assert.equal(source, 'registry');
});

test('registry candidate prefers exact workspace match and latest activity', () => {
  const registry = {
    '__control__': {},
    'c:\\other': {
      workspace_id: 'different',
      workspace_paths: {
        normalized: 'c:/other',
        raw: 'c:\\other',
      },
      state: 'ready',
      lastActive: 20,
      port: 9002,
      ip: '127.0.0.1',
      cdp: {
        active: {
          host: '127.0.0.1',
          port: 9002,
          source: 'version',
        },
      },
    },
    'c:\\repo': {
      workspace_id: 'workspace-1',
      workspace_paths: {
        normalized: 'c:/repo',
        raw: 'c:\\repo',
      },
      state: 'app_up_no_cdp',
      lastActive: 50,
      port: 9010,
      ip: '127.0.0.1',
    },
    'c:\\repo-copy': {
      workspace_id: 'workspace-1',
      workspace_paths: {
        normalized: 'c:/repo-copy',
        raw: 'c:\\repo-copy',
      },
      state: 'ready',
      lastActive: 40,
      port: 9011,
      ip: '127.0.0.1',
      cdp: {
        active: {
          host: '127.0.0.1',
          port: 9011,
          source: 'version',
        },
      },
    },
  };

  const candidate = getRegistryActiveCdpCandidate(registry, 'c:\\repo', 'workspace-1');

  // Score breakdown for 'c:\repo' entry:
  //   key === workspacePath → +8
  //   workspace_id === workspaceId → +6
  //   workspace_paths.raw === workspacePath → +5
  //   normalized match depends on platform (macOS normalizes differently) → +0 or +4
  //   state !== 'ready' → +0, no active cdp → +0
  assert.equal(candidate.host, '127.0.0.1');
  assert.equal(candidate.port, 9010);
  assert.equal(candidate.source, 'registry');
  assert.equal(candidate.match, 'workspace-key');
  assert.equal(candidate.state, 'app_up_no_cdp');
  assert.equal(candidate.lastActive, 50);
  assert.ok(candidate.score >= 19, `score should be at least 19, got ${candidate.score}`);
});
