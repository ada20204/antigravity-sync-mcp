const http = require('http');

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function createAccountControlApi({ accountControl, host = '127.0.0.1', port = 0, log = () => {}, warn = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const urlPath = req.url ? req.url.split('?')[0] : '/';

    if (req.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      writeJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    try {
      if (urlPath === '/v1/accounts/list') {
        const accounts = await accountControl.listAccounts();
        writeJson(res, 200, { accounts });
        return;
      }

      const body = await readJsonBody(req);

      if (urlPath === '/v1/accounts/switch') {
        if (!body.email) {
          writeJson(res, 400, { error: 'email is required' });
          return;
        }

        const result = await accountControl.requestSwitchAccount({ targetEmail: body.email });
        writeJson(res, 200, result);
        return;
      }

      if (urlPath === '/v1/accounts/switch-status') {
        if (Object.prototype.hasOwnProperty.call(body, 'requestId')) {
          if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
            writeJson(res, 400, { error: 'requestId must be a non-empty string when provided' });
            return;
          }

          const status = await accountControl.getSwitchStatus({ requestId: body.requestId.trim() });
          writeJson(res, 200, { status });
          return;
        }

        const status = await accountControl.getLatestSwitchStatus();
        writeJson(res, 200, { status });
        return;
      }
    } catch (error) {
      warn(`AccountControlApi request failed: ${error.message}`);
      writeJson(res, 500, { error: error.message || 'internal_error' });
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  });

  server.on('error', (error) => {
    warn(`AccountControlApi server error: ${error.message}`);
  });

  server.listen(port, host, () => {
    const address = server.address();
    log(`AccountControlApi listening on ${typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address)}`);
  });

  return {
    getAddress() {
      return server.address();
    },
    dispose() {
      server.close();
    },
  };
}

module.exports = {
  createAccountControlApi,
};
