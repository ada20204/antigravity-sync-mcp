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
