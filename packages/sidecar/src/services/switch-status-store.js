const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATUS_DIR = path.join(os.homedir(), '.config', 'antigravity-mcp');
const STATUS_FILE = path.join(STATUS_DIR, 'switch-status.json');
const PENDING_STATUSES = new Set(['pending', 'running']);

function toStoredRecord(record, requestId, timestamp = Date.now()) {
  if (record == null) {
    return null;
  }

  return {
    requestId: record.requestId ?? requestId,
    targetEmail: record.targetEmail ?? record.target ?? null,
    status: record.status,
    phase: record.phase ?? null,
    error: record.error ?? null,
    logs: Array.isArray(record.logs) ? record.logs : undefined,
    createdAt: record.createdAt ?? timestamp,
    updatedAt: record.updatedAt ?? timestamp,
  };
}

function ensureParentDir(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readStatusFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { latestRequestId: null, records: {} };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return { latestRequestId: null, records: {} };
  }

  const parsed = JSON.parse(raw);
  return {
    latestRequestId: parsed.latestRequestId ?? null,
    records: parsed.records ?? {},
  };
}

function writeStatusFile(filePath, data) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function createSwitchStatusStore({ filePath = STATUS_FILE } = {}) {
  return {
    get(requestId) {
      const data = readStatusFile(filePath);
      return data.records[requestId] ?? null;
    },

    set(requestId, record) {
      const data = readStatusFile(filePath);
      if (record == null) {
        delete data.records[requestId];
        if (data.latestRequestId === requestId) {
          data.latestRequestId = null;
        }
      } else {
        data.records[requestId] = toStoredRecord(record, requestId);
        data.latestRequestId = requestId;
      }
      writeStatusFile(filePath, data);
      return data.records[requestId] ?? null;
    },

    update(requestId, updates = {}) {
      const current = this.get(requestId);
      const timestamp = updates.updatedAt ?? Date.now();
      const next = toStoredRecord({
        ...current,
        ...updates,
        requestId,
        createdAt: current?.createdAt ?? updates.createdAt ?? timestamp,
        updatedAt: timestamp,
      }, requestId, timestamp);
      return this.set(requestId, next);
    },

    getLatest() {
      const data = readStatusFile(filePath);
      if (!data.latestRequestId) {
        return null;
      }
      return data.records[data.latestRequestId] ?? null;
    },

    getLatestForTarget(targetEmail) {
      const data = readStatusFile(filePath);
      const matches = Object.values(data.records)
        .filter((record) => record?.targetEmail === targetEmail)
        .sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
      return matches[0] ?? null;
    },

    hasPending() {
      const latest = this.getLatest();
      return latest ? PENDING_STATUSES.has(latest.status) : false;
    },
  };
}

module.exports = {
  createSwitchStatusStore,
};
