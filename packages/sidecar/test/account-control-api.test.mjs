import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAccountControlApi } = require('../src/services/account-control-api.js');

function postJson({ port, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(data || '{}'),
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function listenApi(accountControl) {
  const api = createAccountControlApi({
    accountControl,
    host: '127.0.0.1',
  });

  return new Promise((resolve) => {
    const waitForAddress = () => {
      const address = api.getAddress();
      if (address && typeof address === 'object' && address.port) {
        resolve({ api, port: address.port });
        return;
      }
      setImmediate(waitForAddress);
    };
    waitForAddress();
  });
}

test('POST /v1/accounts/list returns saved accounts', async () => {
  const calls = [];
  const { api, port } = await listenApi({
    async listAccounts() {
      calls.push('listAccounts');
      return [
        {
          email: 'user@example.com',
          modifiedTime: '2026-03-08T00:00:00.000Z',
        },
      ];
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
  });

  try {
    const response = await postJson({ port, path: '/v1/accounts/list', body: {} });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accounts: [
        {
          email: 'user@example.com',
          modifiedTime: '2026-03-08T00:00:00.000Z',
        },
      ],
    });
    assert.deepEqual(calls, ['listAccounts']);
  } finally {
    api.dispose();
  }
});

test('POST /v1/accounts/switch delegates email to account control', async () => {
  const calls = [];
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount({ targetEmail }) {
      calls.push(targetEmail);
      return {
        accepted: true,
        requestId: 'req_123',
        status: 'running',
      };
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch',
      body: { email: 'user@example.com' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      requestId: 'req_123',
      status: 'running',
    });
    assert.deepEqual(calls, ['user@example.com']);
  } finally {
    api.dispose();
  }
});

test('POST /v1/accounts/switch-status returns status for request id', async () => {
  const calls = [];
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus({ requestId }) {
      calls.push(requestId);
      return {
        requestId,
        status: 'running',
        phase: 'launching-worker',
      };
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch-status',
      body: { requestId: 'req_123' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      status: {
        requestId: 'req_123',
        status: 'running',
        phase: 'launching-worker',
      },
    });
    assert.deepEqual(calls, ['req_123']);
  } finally {
    api.dispose();
  }
});

test('POST /v1/accounts/switch-status returns latest known status when requestId is omitted', async () => {
  const calls = [];
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
    async getLatestSwitchStatus() {
      calls.push('getLatestSwitchStatus');
      return {
        requestId: 'req_latest',
        status: 'completed',
        phase: 'finished',
      };
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch-status',
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      status: {
        requestId: 'req_latest',
        status: 'completed',
        phase: 'finished',
      },
    });
    assert.deepEqual(calls, ['getLatestSwitchStatus']);
  } finally {
    api.dispose();
  }
});

test('invalid requestId on POST /v1/accounts/switch-status returns bad request', async () => {
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
    async getLatestSwitchStatus() {
      throw new Error('not expected');
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch-status',
      body: { requestId: '' },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: 'requestId must be a non-empty string when provided' });
  } finally {
    api.dispose();
  }
});

test('missing email on POST /v1/accounts/switch returns bad request', async () => {
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch',
      body: {},
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: 'email is required' });
  } finally {
    api.dispose();
  }
});

test('missing requestId on POST /v1/accounts/switch-status returns latest known status', async () => {
  const calls = [];
  const { api, port } = await listenApi({
    async listAccounts() {
      throw new Error('not expected');
    },
    async requestSwitchAccount() {
      throw new Error('not expected');
    },
    async getSwitchStatus() {
      throw new Error('not expected');
    },
    async getLatestSwitchStatus() {
      calls.push('getLatestSwitchStatus');
      return {
        requestId: 'req_latest_2',
        status: 'running',
        phase: 'waiting',
      };
    },
  });

  try {
    const response = await postJson({
      port,
      path: '/v1/accounts/switch-status',
      body: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      status: {
        requestId: 'req_latest_2',
        status: 'running',
        phase: 'waiting',
      },
    });
    assert.deepEqual(calls, ['getLatestSwitchStatus']);
  } finally {
    api.dispose();
  }
});
