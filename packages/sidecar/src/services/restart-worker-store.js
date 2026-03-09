const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATUS_DIR = path.join(os.homedir(), '.config', 'antigravity-mcp');
const STATUS_FILE = path.join(STATUS_DIR, 'restart-status.json');
const RESULT_FILE = path.join(STATUS_DIR, 'restart-result.json');
const TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout']);

function buildRequestFilePath(prefix, requestId) {
  if (!requestId) {
    return null;
  }
  return path.join(STATUS_DIR, `${prefix}-${requestId}.json`);
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function getRecordCandidates({ requestId, requestPrefix, legacyFilePath, requestFilePath }) {
  return requestId
    ? [
        { source: requestPrefix, filePath: buildRequestFilePath(requestPrefix, requestId) },
        { source: `legacy-${requestPrefix.split('-')[1]}`, filePath: legacyFilePath },
      ]
    : [{ source: requestPrefix, filePath: requestFilePath }];
}

function readFirstMatchingRecord({ requestId, requestPrefix, requestFilePath, legacyFilePath }) {
  for (const candidate of getRecordCandidates({ requestId, requestPrefix, requestFilePath, legacyFilePath })) {
    const record = readJsonFile(candidate.filePath);
    if (record && (!requestId || record.requestId === requestId)) {
      return { source: candidate.source, record };
    }
  }
  return null;
}

function createRestartWorkerStore({
  statusFilePath = STATUS_FILE,
  resultFilePath = RESULT_FILE,
} = {}) {
  return {
    getStatus(requestId) {
      return readFirstMatchingRecord({
        requestId,
        requestPrefix: 'restart-status',
        requestFilePath: statusFilePath,
        legacyFilePath: statusFilePath,
      })?.record ?? null;
    },

    getResult(requestId) {
      return readFirstMatchingRecord({
        requestId,
        requestPrefix: 'restart-result',
        requestFilePath: resultFilePath,
        legacyFilePath: resultFilePath,
      })?.record ?? null;
    },

    getLatest(requestId) {
      const result = readFirstMatchingRecord({
        requestId,
        requestPrefix: 'restart-result',
        requestFilePath: resultFilePath,
        legacyFilePath: resultFilePath,
      });
      if (result) {
        return {
          source: result.source,
          record: result.record,
          terminal: TERMINAL_STATUSES.has(String(result.record.status || '').toLowerCase()),
        };
      }

      const status = readFirstMatchingRecord({
        requestId,
        requestPrefix: 'restart-status',
        requestFilePath: statusFilePath,
        legacyFilePath: statusFilePath,
      });
      if (status) {
        return {
          source: status.source,
          record: status.record,
          terminal: false,
        };
      }

      return null;
    },
  };
}

module.exports = {
  STATUS_DIR,
  STATUS_FILE,
  RESULT_FILE,
  TERMINAL_STATUSES,
  createRestartWorkerStore,
};
