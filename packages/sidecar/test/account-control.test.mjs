import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountControlService } from '../src/services/account-control.js';
import { createSwitchStatusStore } from '../src/services/switch-status-store.js';

function fakeAccountService() {
  return {
    listSavedAccounts() {
      return [
        {
          email: 'user@example.com',
          filePath: '/tmp/user@example.com.json',
          modifiedTime: new Date('2026-03-08T00:00:00.000Z'),
        },
      ];
    },
    async readCurrentAuthFields() {
      return {
        authStatus: JSON.stringify({ email: 'current@example.com' }),
      };
    },
    extractEmail(authStatus) {
      return JSON.parse(authStatus).email;
    },
  };
}

function fakeWorkerLauncher() {
  return {
    async launchSwitchWorker() {
      return { pid: 4321 };
    },
  };
}

function createInMemoryStatusStore(initial = {}) {
  const records = new Map(Object.entries(initial));
  let latestRequestId = Object.keys(initial).at(-1) ?? null;

  return {
    get(requestId) {
      return records.get(requestId) || null;
    },
    set(requestId, value) {
      if (value == null) {
        records.delete(requestId);
        if (latestRequestId === requestId) {
          latestRequestId = null;
        }
        return null;
      }

      records.set(requestId, value);
      latestRequestId = requestId;
      return value;
    },
    getLatest() {
      return latestRequestId ? records.get(latestRequestId) || null : null;
    },
    hasPending() {
      const latest = this.getLatest();
      return latest ? ['pending', 'running'].includes(latest.status) : false;
    },
  };
}

function createResultReader({ filePath } = {}) {
  return {
    getLatest() {
      if (!filePath || !fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
  };
}

test('listAccounts returns saved accounts in expected shape', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_list',
  });

  const accounts = await service.listAccounts();

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, 'user@example.com');
  assert.ok(accounts[0].modifiedTime instanceof Date);
});

test('current account lookup returns extracted email from live auth fields', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_current',
  });

  const current = await service.getCurrentAccount();

  assert.deepEqual(current, { email: 'current@example.com' });
});

test('switch request returns accepted running task and persists transitions', async () => {
  const timestamps = [1700000000000, 1700000001000, 1700000002000, 1700000002000];
  const statusStore = createInMemoryStatusStore();
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore,
    now: () => timestamps.shift(),
    randomId: () => 'req_123',
  });

  const result = await service.requestSwitchAccount({ targetEmail: 'user@example.com' });
  const persisted = await service.getSwitchStatus({ requestId: 'req_123' });

  assert.equal(result.accepted, true);
  assert.equal(result.requestId, 'req_123');
  assert.equal(result.status, 'running');
  assert.equal(persisted.requestId, 'req_123');
  assert.equal(persisted.targetEmail, 'user@example.com');
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.phase, 'launching-worker');
  assert.equal(persisted.createdAt, 1700000001000);
  assert.equal(persisted.updatedAt, 1700000002000);
});

test('worker launcher receives full switch-worker runtime arguments', async () => {
  const launchCalls = [];
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: {
      async launchSwitchWorker(params) {
        launchCalls.push(params);
        return { pid: 4321 };
      },
    },
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_full_args',
  });

  await service.requestSwitchAccount({ targetEmail: 'user@example.com' });

  assert.deepEqual(launchCalls, [{ requestId: 'req_full_args', targetEmail: 'user@example.com' }]);
});

test('last status loading reads latest result when result file exists', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'account-control-result-'));
  const resultFilePath = path.join(tempRoot, 'latest-result.json');
  fs.writeFileSync(resultFilePath, JSON.stringify({
    requestId: 'req_result',
    targetEmail: 'done@example.com',
    status: 'completed',
    phase: 'finished',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
  }), 'utf8');

  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore({
      req_store: {
        requestId: 'req_store',
        targetEmail: 'store@example.com',
        status: 'running',
        phase: 'launching-worker',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
    }),
    resultReader: createResultReader({ filePath: resultFilePath }),
    now: () => 1700000000000,
    randomId: () => 'req_unused',
  });

  const latest = await service.getLatestSwitchStatus();

  assert.equal(latest?.requestId, 'req_result');
  assert.equal(latest?.status, 'completed');
  assert.equal(latest?.phase, 'finished');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('history result does not override newer running request', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'account-control-result-'));
  const resultFilePath = path.join(tempRoot, 'latest-result.json');
  fs.writeFileSync(resultFilePath, JSON.stringify({
    requestId: 'req_old_result',
    targetEmail: 'old@example.com',
    status: 'completed',
    phase: 'finished',
    createdAt: 1700000000000,
    updatedAt: 1700000003000,
  }), 'utf8');

  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore({
      req_new_running: {
        requestId: 'req_new_running',
        targetEmail: 'new@example.com',
        status: 'running',
        phase: 'launching-worker',
        createdAt: 1700000004000,
        updatedAt: 1700000006000,
      },
    }),
    resultReader: createResultReader({ filePath: resultFilePath }),
    now: () => 1700000000000,
    randomId: () => 'req_unused',
  });

  const latest = await service.getLatestSwitchStatus();

  assert.equal(latest?.requestId, 'req_new_running');
  assert.equal(latest?.status, 'running');
  assert.equal(latest?.phase, 'launching-worker');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('status lookup returns task metadata for known request', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore({
      req_123: {
        requestId: 'req_123',
        status: 'pending',
        phase: 'queued',
        targetEmail: 'user@example.com',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    }),
    now: () => 1700000000000,
    randomId: () => 'req_123',
  });

  const result = await service.getSwitchStatus({ requestId: 'req_123' });

  assert.equal(result.requestId, 'req_123');
  assert.equal(result.status, 'pending');
  assert.equal(result.phase, 'queued');
});

test('locked request rejection occurs when a switch lock is already held', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    taskState: {
      hasLock() {
        return true;
      },
    },
    now: () => 1700000000000,
    randomId: () => 'req_new',
  });

  await assert.rejects(
    () => service.requestSwitchAccount({ targetEmail: 'user@example.com' }),
    (error) => {
      assert.match(error.message, /switch request already in progress/i);
      assert.equal(error.code, 'SWITCH_ALREADY_PENDING');
      return true;
    },
  );
});

test('locked request rejection occurs when latest result still reports active task state', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    resultReader: {
      getLatest() {
        return {
          requestId: 'req_active',
          targetEmail: 'active@example.com',
          status: 'running',
          phase: 'waiting',
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        };
      },
    },
    now: () => 1700000000000,
    randomId: () => 'req_new',
  });

  await assert.rejects(
    () => service.requestSwitchAccount({ targetEmail: 'user@example.com' }),
    (error) => {
      assert.match(error.message, /switch request already in progress/i);
      assert.equal(error.code, 'SWITCH_ALREADY_PENDING');
      return true;
    },
  );
});

test('stale running switch status does not block a new switch request', async () => {
  const statusStore = createInMemoryStatusStore({
    req_stale: {
      requestId: 'req_stale',
      targetEmail: 'stale@example.com',
      status: 'running',
      phase: 'launching-worker',
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    },
  });
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore,
    now: () => 1700000065000,
    randomId: () => 'req_new',
  });

  const result = await service.requestSwitchAccount({ targetEmail: 'user@example.com' });

  assert.equal(result.accepted, true);
  assert.equal(result.requestId, 'req_new');
  assert.equal(statusStore.getLatest()?.requestId, 'req_new');
  assert.equal(statusStore.getLatest()?.status, 'running');
});

test('fresh running switch status still blocks a new switch request', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore({
      req_active: {
        requestId: 'req_active',
        targetEmail: 'active@example.com',
        status: 'running',
        phase: 'launching-worker',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
    }),
    now: () => 1700000005000,
    randomId: () => 'req_new',
  });

  await assert.rejects(
    () => service.requestSwitchAccount({ targetEmail: 'user@example.com' }),
    (error) => {
      assert.match(error.message, /switch request already in progress/i);
      assert.equal(error.code, 'SWITCH_ALREADY_PENDING');
      return true;
    },
  );
});

test('prepareAddAnotherAccount throws when authStatus is string "null"', async () => {
  const service = createAccountControlService({
    accountService: {
      ...fakeAccountService(),
      async readCurrentAuthFields() {
        return { authStatus: 'null' };
      },
    },
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_null_auth',
  });

  await assert.rejects(
    () => service.prepareAddAnotherAccount(),
    (error) => {
      assert.equal(error.message, 'No account is currently logged in');
      assert.equal(error.code, 'ACCOUNT_NOT_LOGGED_IN');
      return true;
    },
  );
});

test('getCurrentAccount returns null when authStatus is string "null"', async () => {
  const service = createAccountControlService({
    accountService: {
      ...fakeAccountService(),
      async readCurrentAuthFields() {
        return { authStatus: 'null' };
      },
    },
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_null_auth',
  });

  const result = await service.getCurrentAccount();
  assert.equal(result, null);
});

test('file status store persists latest status records on disk', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'account-control-status-'));
  const filePath = path.join(tempRoot, 'switch-status.json');
  const store = createSwitchStatusStore({ filePath });

  store.set('req_disk', {
    requestId: 'req_disk',
    targetEmail: 'disk@example.com',
    status: 'running',
    phase: 'launching-worker',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  });

  const reloadedStore = createSwitchStatusStore({ filePath });
  const latest = reloadedStore.getLatest();
  const status = reloadedStore.get('req_disk');

  assert.equal(status?.requestId, 'req_disk');
  assert.equal(latest?.requestId, 'req_disk');
  assert.equal(reloadedStore.hasPending(), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
