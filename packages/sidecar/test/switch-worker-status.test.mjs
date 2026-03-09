import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSwitchStatusStore } from '../src/services/switch-status-store.js';
import { createAccountControlService } from '../src/services/account-control.js';

let cachedWorkerExports = null;
async function loadWorkerExports() {
  if (cachedWorkerExports) {
    return cachedWorkerExports;
  }
  const module = await import('../scripts/switch-worker.js');
  cachedWorkerExports = module.default?.__testExports ?? module.__testExports;
  return cachedWorkerExports;
}

function createTempStore() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-worker-status-'));
  const filePath = path.join(tempRoot, 'switch-status.json');
  return {
    tempRoot,
    filePath,
    store: createSwitchStatusStore({ filePath }),
  };
}

test('worker writes phase/status updates during execution', async () => {
  const { tempRoot, filePath } = createTempStore();
  try {
    process.argv = [
      process.argv[0],
      path.join(tempRoot, 'switch-worker.js'),
      '--db-path', path.join(tempRoot, 'state.vscdb'),
      '--target-email', 'phase@example.com',
      '--backup-dir', path.join(tempRoot, 'accounts'),
      '--antigravity-path', '/Applications/Antigravity.app',
      '--pid', '1234',
      '--workspace', path.join(tempRoot, 'workspace'),
      '--port', '9000',
      '--config-dir', tempRoot,
      '--request-id', 'req_phase',
    ];

    const exported = await loadWorkerExports();
    exported.resetTestState();
    await exported.updateSharedStatus({ status: 'running', phase: 'precheck' });
    await exported.updateSharedStatus({ status: 'running', phase: 'wait_exit' });
    await exported.updateSharedStatus({ status: 'running', phase: 'modify_db' });
    await exported.updateSharedStatus({ status: 'running', phase: 'restart' });

    const reloaded = createSwitchStatusStore({ filePath });
    const status = reloaded.get('req_phase');
    const statusFileRaw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.equal(status?.requestId, 'req_phase');
    assert.equal(statusFileRaw.records.req_phase.targetEmail, 'phase@example.com');
    assert.equal(status?.targetEmail, 'phase@example.com');
    assert.equal(status?.status, 'running');
    assert.equal(status?.phase, 'restart');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('final success/failure maps to the status store used by controller/API', async () => {
  const { tempRoot, filePath, store } = createTempStore();
  try {
    process.argv = [
      process.argv[0],
      path.join(tempRoot, 'switch-worker.js'),
      '--db-path', path.join(tempRoot, 'state.vscdb'),
      '--target-email', 'done@example.com',
      '--backup-dir', path.join(tempRoot, 'accounts'),
      '--antigravity-path', '/Applications/Antigravity.app',
      '--pid', '1234',
      '--workspace', path.join(tempRoot, 'workspace'),
      '--port', '9000',
      '--config-dir', tempRoot,
      '--request-id', 'req_done',
    ];

    const worker = await loadWorkerExports();
    worker.resetTestState();
    await worker.writeResult('success', 'complete');

    const service = createAccountControlService({
      accountService: {
        listSavedAccounts() { return []; },
        async readCurrentAuthFields() { return null; },
        extractEmail() { return null; },
      },
      workerLauncher: {
        async launchSwitchWorker() { return { pid: 9999 }; },
      },
      statusStore: store,
      now: () => 1700000000000,
      randomId: () => 'unused',
    });

    const persistedDirect = createSwitchStatusStore({ filePath }).get('req_done');
    assert.equal(persistedDirect?.requestId, 'req_done');
    const latest = await service.getLatestSwitchStatus();
    const byId = await service.getSwitchStatus({ requestId: 'req_done' });

    assert.equal(byId?.requestId, 'req_done');
    assert.equal(byId?.status, 'success');
    assert.ok(latest, 'expected latest status record');
    assert.equal(latest?.requestId, 'req_done');

    await worker.writeResult('failed', 'modify_db', 'boom');
    const failed = await service.getSwitchStatus({ requestId: 'req_done' });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.phase, 'modify_db');
    assert.equal(failed?.error, 'boom');

    const rawResult = JSON.parse(fs.readFileSync(path.join(tempRoot, 'switch-result.json'), 'utf8'));
    assert.equal(rawResult.requestId, 'req_done');
    assert.equal(rawResult.status, 'failed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('extension activation can still consume switch-result.json without breaking MCP status lookup', async () => {
  const { tempRoot, filePath, store } = createTempStore();
  try {
    const resultFile = path.join(tempRoot, 'switch-result.json');
    store.set('req_keep', {
      requestId: 'req_keep',
      targetEmail: 'keep@example.com',
      status: 'success',
      phase: 'complete',
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    });

    fs.writeFileSync(resultFile, JSON.stringify({
      requestId: 'req_keep',
      target: 'keep@example.com',
      targetEmail: 'keep@example.com',
      status: 'success',
      phase: 'complete',
      logs: ['done'],
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    }, null, 2), 'utf8');

    const consumed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(consumed.requestId, 'req_keep');
    fs.unlinkSync(resultFile);

    const service = createAccountControlService({
      accountService: {
        listSavedAccounts() { return []; },
        async readCurrentAuthFields() { return null; },
        extractEmail() { return null; },
      },
      workerLauncher: {
        async launchSwitchWorker() { return { pid: 9999 }; },
      },
      statusStore: createSwitchStatusStore({ filePath }),
      resultReader: {
        getLatest() {
          if (!fs.existsSync(resultFile)) {
            return null;
          }
          return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        },
      },
      now: () => 1700000002000,
      randomId: () => 'unused',
    });

    const latest = await service.getLatestSwitchStatus();
    const byId = await service.getSwitchStatus({ requestId: 'req_keep' });

    assert.equal(fs.existsSync(resultFile), false);
    assert.equal(latest?.requestId, 'req_keep');
    assert.equal(latest?.status, 'success');
    assert.equal(byId?.requestId, 'req_keep');
    assert.equal(byId?.status, 'success');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
