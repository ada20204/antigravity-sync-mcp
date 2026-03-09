import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { __testExports } from '../server-runtime/dist/index.js';

const {
  handleAccountsList,
  handleAccountSwitch,
  handleAccountSwitchStatus,
} = __testExports;

function withAccountControlServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const urlPath = req.url ? req.url.split('?')[0] : '/';
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const route = routes.get(urlPath);
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const parsedBody = body ? JSON.parse(body) : {};
      route.calls.push(parsedBody);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify(route.response(parsedBody)));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18900, '127.0.0.1', async () => {
      try {
        const result = await fn();
        await new Promise((closeResolve) => server.close(closeResolve));
        resolve(result);
      } catch (error) {
        await new Promise((closeResolve) => server.close(closeResolve));
        reject(error);
      }
    });
  });
}

test('tools list includes exactly the 3 account tools', async () => {
  const module = await import('../server-runtime/dist/index.js');
  const source = await import('node:fs/promises');
  const fileText = await source.readFile(new URL('../server-runtime/dist/index.js', import.meta.url), 'utf8');

  assert.match(fileText, /name: "antigravity-accounts-list"/);
  assert.match(fileText, /name: "antigravity-account-switch"/);
  assert.match(fileText, /name: "antigravity-account-switch-status"/);

  const names = [...fileText.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
  const accountNames = names.filter((name) => name.startsWith('antigravity-account'));
  assert.deepEqual(accountNames.sort(), [
    'antigravity-account-switch',
    'antigravity-account-switch-status',
    'antigravity-accounts-list',
  ]);
  assert.ok(module.__testExports);
});

test('tool handlers proxy to sidecar control API and format returned JSON as text output', async () => {
  const routes = new Map([
    ['/v1/accounts/list', {
      calls: [],
      response() {
        return {
          accounts: [
            { email: 'a@example.com', modifiedTime: '2026-03-08T00:00:00.000Z' },
          ],
        };
      },
    }],
    ['/v1/accounts/switch', {
      calls: [],
      response(body) {
        return {
          accepted: true,
          requestId: 'req_123',
          status: 'running',
          echoedEmail: body.email,
        };
      },
    }],
  ]);

  await withAccountControlServer(routes, async () => {
    const listText = await handleAccountsList();
    const switchText = await handleAccountSwitch('a@example.com');

    assert.equal(listText, JSON.stringify({
      accounts: [
        { email: 'a@example.com', modifiedTime: '2026-03-08T00:00:00.000Z' },
      ],
    }, null, 2));
    assert.equal(switchText, JSON.stringify({
      accepted: true,
      requestId: 'req_123',
      status: 'running',
      echoedEmail: 'a@example.com',
    }, null, 2));
    assert.deepEqual(routes.get('/v1/accounts/list').calls, [{}]);
    assert.deepEqual(routes.get('/v1/accounts/switch').calls, [{ email: 'a@example.com' }]);
  });
});

test('switch-status supports explicit requestId and last-status fallback if no requestId supplied', async () => {
  const routes = new Map([
    ['/v1/accounts/switch-status', {
      calls: [],
      response(body) {
        if (Object.prototype.hasOwnProperty.call(body, 'requestId')) {
          return {
            status: {
              requestId: body.requestId,
              status: 'running',
              phase: 'launching-worker',
            },
          };
        }

        return {
          status: {
            requestId: 'req_latest',
            status: 'completed',
            phase: 'finished',
          },
        };
      },
    }],
  ]);

  await withAccountControlServer(routes, async () => {
    const explicitText = await handleAccountSwitchStatus('req_123');
    const fallbackText = await handleAccountSwitchStatus();

    assert.equal(explicitText, JSON.stringify({
      status: {
        requestId: 'req_123',
        status: 'running',
        phase: 'launching-worker',
      },
    }, null, 2));
    assert.equal(fallbackText, JSON.stringify({
      status: {
        requestId: 'req_latest',
        status: 'completed',
        phase: 'finished',
      },
    }, null, 2));
    assert.deepEqual(routes.get('/v1/accounts/switch-status').calls, [{ requestId: 'req_123' }, {}]);
  });
});
