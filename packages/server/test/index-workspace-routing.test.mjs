import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAskTask } from '../build/dist/task-runtime.js';
import { __testExports } from '../build/dist/index.js';

const {
  activeAskTasks,
  activeWorkspaceRoutes,
  claimWorkspaceTask,
  shouldAttemptColdStartLaunch,
  handleStop,
  handleListWorkspaces,
  NO_WORKSPACE_GUIDANCE,
  isSshRemoteContext,
  buildSshHint,
  SSH_HINT_ERROR_CODES,
  formatDiscoverError,
} = __testExports;

function writeRegistry(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function resetActiveState() {
  activeAskTasks.clear();
  activeWorkspaceRoutes.clear();
}

test.beforeEach(() => {
  resetActiveState();
});

test.afterEach(() => {
  resetActiveState();
  delete process.env.ANTIGRAVITY_REGISTRY_FILE;
  delete globalThis.fetch;
});

test('two concurrent workspace claims on different workspaceKeys both proceed', async () => {
  const taskA = createAskTask('task-a');
  const taskB = createAskTask('task-b');

  await Promise.all([
    Promise.resolve().then(() => claimWorkspaceTask('ws-a', taskA)),
    Promise.resolve().then(() => claimWorkspaceTask('ws-b', taskB)),
  ]);

  assert.equal(activeAskTasks.size, 2);
  assert.equal(activeAskTasks.get('ws-a')?.id, taskA.id);
  assert.equal(activeAskTasks.get('ws-b')?.id, taskB.id);
});

test('antigravity-stop with multiple active tasks and no targetDir returns workspace ambiguity error', async () => {
  claimWorkspaceTask('workspace-alpha', createAskTask('alpha'));
  claimWorkspaceTask('workspace-beta', createAskTask('beta'));

  await assert.rejects(
    () => handleStop(undefined),
    /Multiple workspaces are active \(workspace-alpha, workspace-beta\)\./
  );
});

test('antigravity-stop with mismatched targetDir returns exact-match error without stopping any task', async () => {
  claimWorkspaceTask('known-workspace', createAskTask('known'));

  await assert.rejects(
    () => handleStop('/tmp/not-known-workspace'),
    /requires exact workspace match and does not auto-fallback/
  );

  assert.equal(activeAskTasks.size, 1);
  assert.ok(activeAskTasks.has('known-workspace'));
});

test('list-workspaces returns registry entries without attempting CDP connection', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch should not be called by list-workspaces');
  };

  const registryFile = path.join(os.tmpdir(), `ag-mcp-list-workspaces-${Date.now()}.json`);
  writeRegistry(registryFile, {
    '/tmp/work-a': {
      schema_version: 2,
      workspace_id: 'ws-a',
      workspace_paths: { raw: '/tmp/work-a' },
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      local_endpoint: { host: '127.0.0.1', port: 9000, mode: 'direct' },
      quota: {
        promptCredits: { remainingPercentage: 73 },
        models: [{ modelId: 'gemini-3-flash' }],
      },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = registryFile;

  const resultText = await handleListWorkspaces();
  const parsed = JSON.parse(resultText);

  assert.equal(fetchCalls, 0);
  assert.equal(parsed.workspaces.length, 1);
  assert.equal(parsed.workspaces[0].workspacePath, '/tmp/work-a');
  assert.equal(parsed.workspaces[0].workspaceId, 'ws-a');
  assert.match(parsed.workspaces[0].quotaSummary, /models=1/);
});

test('no_workspace_ever_opened guidance message does not suggest auto-launch', () => {
  assert.match(NO_WORKSPACE_GUIDANCE, /Open Antigravity/i);
  assert.match(NO_WORKSPACE_GUIDANCE, /authorization/i);
  assert.ok(!/auto-launch|launch antigravity/i.test(NO_WORKSPACE_GUIDANCE));
  assert.equal(shouldAttemptColdStartLaunch(false, 'no_workspace_ever_opened'), false);
});

// ── SSH hint tests ────────────────────────────────────────────────────────────

function withSshEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('SSH_HINT_ERROR_CODES covers expected failure classes', () => {
  for (const code of ['registry_missing', 'workspace_not_found', 'endpoint_unreachable', 'entry_not_ready', 'entry_stale']) {
    assert.ok(SSH_HINT_ERROR_CODES.has(code), `expected ${code} in SSH_HINT_ERROR_CODES`);
  }
  assert.ok(!SSH_HINT_ERROR_CODES.has('schema_mismatch'));
  assert.ok(!SSH_HINT_ERROR_CODES.has('no_workspace_ever_opened'));
});

test('buildSshHint: returns null when no SSH context and no SSH error code', () => {
  assert.equal(buildSshHint('schema_mismatch'), null);
});

test('buildSshHint: returns null for SSH error code but no SSH context', () => {
  // No SSH env vars, no registry
  const tmpFile = path.join(os.tmpdir(), `ag-hint-empty-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({}));
  process.env.ANTIGRAVITY_REGISTRY_FILE = tmpFile;
  try {
    const result = buildSshHint('workspace_not_found');
    assert.equal(result, null);
  } finally {
    delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    fs.unlinkSync(tmpFile);
  }
});

test('buildSshHint: returns hint when SSH_CLIENT set + relevant error code', () => {
  withSshEnv({ SSH_CLIENT: '10.0.0.1 12345 22' }, () => {
    const result = buildSshHint('workspace_not_found');
    assert.ok(result !== null);
    assert.equal(result.hint_code, 'ssh_host_antigravity_not_reachable_yet');
    assert.match(result.hint_message, /Antigravity/);
    assert.match(result.hint_message, /port forwarding/i);
  });
});

test('buildSshHint: returns hint when SSH_TTY set + relevant error code', () => {
  withSshEnv({ SSH_TTY: '/dev/pts/0' }, () => {
    assert.ok(buildSshHint('endpoint_unreachable') !== null);
  });
});

test('buildSshHint: returns null for SSH_CLIENT set but non-SSH error code', () => {
  withSshEnv({ SSH_CLIENT: '10.0.0.1 12345 22' }, () => {
    assert.equal(buildSshHint('schema_mismatch'), null);
    assert.equal(buildSshHint('no_workspace_ever_opened'), null);
    assert.equal(buildSshHint(undefined), null);
  });
});

test('isSshRemoteContext: detects SSH_CLIENT env var', () => {
  withSshEnv({ SSH_CLIENT: '10.0.0.1 12345 22' }, () => {
    assert.equal(isSshRemoteContext(), true);
  });
});

test('isSshRemoteContext: detects SSH_TTY env var', () => {
  withSshEnv({ SSH_TTY: '/dev/pts/0' }, () => {
    assert.equal(isSshRemoteContext(), true);
  });
});

test('isSshRemoteContext: detects role=remote in registry', () => {
  const tmpFile = path.join(os.tmpdir(), `ag-hint-remote-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    '/remote/workspace': { schema_version: 2, role: 'remote', state: 'ready' },
  }));
  process.env.ANTIGRAVITY_REGISTRY_FILE = tmpFile;
  try {
    assert.equal(isSshRemoteContext(), true);
  } finally {
    delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    fs.unlinkSync(tmpFile);
  }
});

test('isSshRemoteContext: returns false for host-only registry', () => {
  const tmpFile = path.join(os.tmpdir(), `ag-hint-host-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    '/local/workspace': { schema_version: 2, role: 'host', state: 'ready' },
  }));
  process.env.ANTIGRAVITY_REGISTRY_FILE = tmpFile;
  try {
    assert.equal(isSshRemoteContext(), false);
  } finally {
    delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    fs.unlinkSync(tmpFile);
  }
});

test('formatDiscoverError: includes hint fields when SSH context active', () => {
  withSshEnv({ SSH_CLIENT: '10.0.0.1 12345 22' }, () => {
    const json = formatDiscoverError({ code: 'endpoint_unreachable', message: 'refused', workspaceId: 'ws-1', state: 'app_up_no_cdp', details: null });
    const parsed = JSON.parse(json);
    assert.equal(parsed.error_code, 'endpoint_unreachable');
    assert.equal(parsed.hint_code, 'ssh_host_antigravity_not_reachable_yet');
    assert.ok(typeof parsed.hint_message === 'string' && parsed.hint_message.length > 0);
  });
});

test('formatDiscoverError: no hint fields when not SSH context', () => {
  const tmpFile = path.join(os.tmpdir(), `ag-hint-nosssh-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({}));
  process.env.ANTIGRAVITY_REGISTRY_FILE = tmpFile;
  try {
    const json = formatDiscoverError({ code: 'endpoint_unreachable', message: 'refused', workspaceId: null, state: null, details: null });
    const parsed = JSON.parse(json);
    assert.equal(parsed.hint_code, undefined);
    assert.equal(parsed.hint_message, undefined);
  } finally {
    delete process.env.ANTIGRAVITY_REGISTRY_FILE;
    fs.unlinkSync(tmpFile);
  }
});
