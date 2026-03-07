const http = require('http');
const { createHash, randomBytes } = require('crypto');
const {
    signBridgeHttpRequest,
    verifyBridgeHttpRequest,
} = require('../bridge-auth');

function postJson(url, body, headers = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const bodyBuf = Buffer.from(body, 'utf8');
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': bodyBuf.length,
                ...headers,
            },
            timeout: timeoutMs,
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsedBody = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        const err = Object.assign(
                            new Error(parsedBody.error || `HTTP ${res.statusCode}`),
                            { statusCode: res.statusCode, body: parsedBody }
                        );
                        reject(err);
                    } else {
                        resolve(parsedBody);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(bodyBuf);
        req.end();
    });
}

function createHostBridgeServer(params) {
    const {
        getSnapshot,
        bridgeToken,
        nonceCache,
        log,
        warn,
        schemaVersion,
        bridgeVersion,
        host,
        port,
    } = params;

    const server = http.createServer((req, res) => {
        const urlPath = req.url ? req.url.split('?')[0] : '/';

        if (req.method === 'GET' && urlPath === '/v1/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', bridge_version: bridgeVersion, node_role: 'host' }));
            return;
        }

        if (req.method === 'POST' && urlPath === '/v1/snapshot') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const ts = req.headers['x-ag-bridge-ts'];
                const nonce = req.headers['x-ag-bridge-nonce'];
                const signature = req.headers['x-ag-bridge-signature'];
                const fromNodeId = req.headers['x-ag-bridge-node-id'];
                const bodyHash = createHash('sha256').update(body || '').digest('hex');

                const authResult = verifyBridgeHttpRequest(
                    { method: 'POST', path: '/v1/snapshot', bodyHash, ts, nonce, nodeId: fromNodeId, signature },
                    bridgeToken,
                    { nonceCache }
                );
                if (!authResult.ok) {
                    warn(`HostBridge auth rejected: ${authResult.code} from node=${fromNodeId}`);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: authResult.code }));
                    return;
                }

                let reqBody = {};
                try { reqBody = JSON.parse(body || '{}'); } catch { }

                const snapshot = getSnapshot(reqBody.workspace_id, reqBody.workspace_path);
                if (!snapshot) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'workspace_not_found' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    schema_version: schemaVersion,
                    entry: snapshot,
                    server_time: Date.now(),
                    ttl_ms: 30_000,
                }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
    });

    server.on('error', (err) => {
        warn(`HostBridgeService error: ${err.message}`, { plane: 'ctrl', error_code: 'bridge_server_error' });
    });

    server.listen(port, host, () => {
        log(`HostBridgeService listening on ${host}:${port}`, {
            plane: 'ctrl',
            state: 'ready',
        });
    });

    return { dispose: () => server.close() };
}

function createRemoteBridgeClient(params) {
    const {
        bridgeEndpoint,
        bridgeToken,
        nodeId,
        onSnapshot,
        log,
        warn,
    } = params;

    const POLL_MS = 3_000;
    const BACKOFF = [10_000, 30_000];
    let stopped = false;
    let failures = 0;
    let handle = null;

    async function poll() {
        if (stopped) return;
        try {
            const ts = Date.now();
            const nonce = randomBytes(16).toString('hex');
            const body = JSON.stringify({});
            const bodyHash = createHash('sha256').update(body).digest('hex');
            const signature = signBridgeHttpRequest(
                { method: 'POST', path: '/v1/snapshot', bodyHash, ts, nonce, nodeId },
                bridgeToken
            );
            const result = await postJson(
                `http://${bridgeEndpoint}/v1/snapshot`,
                body,
                {
                    'x-ag-bridge-ts': String(ts),
                    'x-ag-bridge-nonce': nonce,
                    'x-ag-bridge-signature': signature,
                    'x-ag-bridge-node-id': nodeId,
                }
            );
            failures = 0;
            onSnapshot(result);
        } catch (err) {
            failures++;
            if (failures === 1 || failures % 10 === 0) {
                warn(`RemoteBridgeClient poll failed (attempt ${failures}): ${err.message}`, {
                    plane: 'ctrl',
                    error_code: 'bridge_poll_error',
                });
            }
        }
        if (!stopped) {
            const delay = failures === 0 ? POLL_MS : failures <= 3 ? BACKOFF[0] : BACKOFF[1];
            handle = setTimeout(() => poll().catch(() => {}), delay);
        }
    }

    poll().catch(() => {});

    return {
        dispose: () => {
            stopped = true;
            if (handle) clearTimeout(handle);
        },
    };
}

module.exports = {
    createHostBridgeServer,
    createRemoteBridgeClient,
    postJson,
};
