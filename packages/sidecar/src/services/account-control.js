function toStatusRecord(record, nowValue = record?.updatedAt ?? record?.createdAt ?? Date.now()) {
  if (!record) {
    return null;
  }

  return {
    requestId: record.requestId,
    targetEmail: record.targetEmail,
    status: record.status,
    phase: record.phase ?? null,
    error: record.error ?? null,
    createdAt: record.createdAt ?? nowValue,
    updatedAt: record.updatedAt ?? nowValue,
  };
}

function isActiveTask(record, now = Date.now()) {
  if (!record || !['pending', 'running'].includes(record.status)) {
    return false;
  }

  const updatedAt = Number(record.updatedAt ?? record.createdAt ?? 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return true;
  }

  return (now - updatedAt) < 60_000;
}

function pickLatestRecord(...records) {
  return records
    .filter(Boolean)
    .map((record) => toStatusRecord(record))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

function createAccountControlService({
  accountService,
  workerLauncher,
  statusStore,
  resultReader = { getLatest: () => null },
  taskState = { hasLock: () => false },
  now = Date.now,
  randomId,
}) {
  function persistStatus(requestId, updates) {
    const current = statusStore.get(requestId);
    const timestamp = now();
    const next = toStatusRecord({
      ...current,
      ...updates,
      requestId,
      updatedAt: timestamp,
      createdAt: current?.createdAt ?? updates.createdAt ?? timestamp,
    }, timestamp);

    statusStore.set(requestId, next);
    return next;
  }

  function hasPendingTask() {
    const nowValue = now();
    return Boolean(
      taskState.hasLock?.() ||
      isActiveTask(statusStore.getLatest?.(), nowValue) ||
      isActiveTask(resultReader.getLatest?.(), nowValue),
    );
  }

  return {
    async listAccounts() {
      return accountService.listSavedAccounts();
    },

    async deleteAccount({ email }) {
      accountService.deleteAccount(email);
      return { email };
    },

    async getCurrentAccount() {
      const current = await accountService.readCurrentAuthFields();
      const rawAuth = current?.authStatus;
      if (!rawAuth || rawAuth === 'null') {
        return null;
      }

      const email = accountService.extractEmail(rawAuth);
      if (!email) {
        return null;
      }

      return {
        email,
      };
    },

    async requestSwitchAccount({ targetEmail }) {
      if (hasPendingTask()) {
        const error = new Error('switch request already in progress');
        error.code = 'SWITCH_ALREADY_PENDING';
        throw error;
      }

      const requestId = randomId();
      const createdAt = now();
      const record = toStatusRecord({
        requestId,
        targetEmail,
        status: 'pending',
        phase: 'queued',
        createdAt,
        updatedAt: createdAt,
      });

      statusStore.set(requestId, record);

      try {
        persistStatus(requestId, { status: 'running', phase: 'launching-worker' });
        await workerLauncher.launchSwitchWorker({ requestId, targetEmail });
      } catch (error) {
        persistStatus(requestId, { status: 'failed', phase: 'launch-error' });
        throw error;
      }

      return {
        accepted: true,
        requestId,
        status: 'running',
      };
    },

    async prepareAddAnotherAccount() {
      if (hasPendingTask()) {
        const error = new Error('switch request already in progress');
        error.code = 'SWITCH_ALREADY_PENDING';
        throw error;
      }

      const current = await accountService.readCurrentAuthFields();
      const rawAuth = current?.authStatus;
      if (!rawAuth || rawAuth === 'null') {
        const error = new Error('No account is currently logged in');
        error.code = 'ACCOUNT_NOT_LOGGED_IN';
        throw error;
      }

      const email = accountService.extractEmail(rawAuth);
      if (!email) {
        const error = new Error('No account is currently logged in');
        error.code = 'ACCOUNT_NOT_LOGGED_IN';
        throw error;
      }

      const saveResult = await accountService.saveCurrentAccount();

      return {
        email,
        filePath: saveResult.filePath,
      };
    },

    async getSwitchStatus({ requestId }) {
      return toStatusRecord(statusStore.get(requestId));
    },

    async getLatestSwitchStatus() {
      return pickLatestRecord(statusStore.getLatest?.(), resultReader.getLatest?.());
    },
  };
}

module.exports = {
  createAccountControlService,
};
