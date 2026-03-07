const https = require('https');

async function probeLanguageServerEndpoint(host, port, csrfToken, postLsJson) {
    const probes = [
        () => postLsJson(host, port, csrfToken, 'GetUnleashData', { wrapper_data: {} }, 1500),
        () => postLsJson(host, port, csrfToken, 'GetUserStatus', {
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en',
            },
        }, 2000),
    ];
    for (const runProbe of probes) {
        try {
            await runProbe();
            return true;
        } catch { }
    }
    return false;
}

async function postLsJson(host, port, csrfToken, method, body, timeoutMs = 3000) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: host,
            port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            rejectUnauthorized: false,
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`LS ${method} status=${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`LS ${method} timeout`));
        });
        req.write(payload);
        req.end();
    });
}

function parsePortsFromSsOutput(text, pid) {
    const ports = new Set();
    const ssRegex = new RegExp(`LISTEN\\s+\\d+\\s+\\d+\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]*\\]):(\\d+).*?pid=${pid},`, 'gi');
    let match;
    while ((match = ssRegex.exec(text)) !== null) {
        const port = Number(match[1]);
        if (Number.isFinite(port)) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
}

function parsePortsFromLsofOutput(text, pid) {
    const ports = new Set();
    const lsofRegex = new RegExp(`^\\S+\\s+${pid}\\s+.*?TCP\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
    let match;
    while ((match = lsofRegex.exec(text)) !== null) {
        const port = Number(match[1]);
        if (Number.isFinite(port)) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
}

function extractArgValue(cmdline, name) {
    const flag = String(name || '').trim().replace(/[-_]/g, '[-_]');
    const re = new RegExp(`(?:--|-)${flag}(?:=|\\s+)(\"[^\"]+\"|'[^']+'|[^\\s]+)`, 'i');
    const match = String(cmdline || '').match(re);
    if (!match) return '';
    return String(match[1] || '').replace(/^["']|["']$/g, '');
}

async function detectLanguageServer(deps) {
    const { execAsync } = deps;
    try {
        if (process.platform === 'win32') {
            const processCmds = [
                'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\\"name=\'language_server_windows_x64.exe\'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
                'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match \\\"(?i)(language[_-]?server|exa[_-]?language[_-]?server)\\\") -and ($_.CommandLine -match \\\"csrf[_-]token\\\") } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
            ];
            let items = [];
            for (const cmd of processCmds) {
                try {
                    const { stdout } = await execAsync(cmd);
                    if (!stdout.trim()) continue;
                    const parsed = JSON.parse(stdout.trim());
                    const list = Array.isArray(parsed) ? parsed : [parsed];
                    if (list.length > 0) {
                        items = list;
                        break;
                    }
                } catch { }
            }
            if (items.length === 0) return null;

            const prioritized = [
                ...items.filter((item) => {
                    const line = String(item.CommandLine || '');
                    return line && (/--app[_-]data[_-]dir\\s+antigravity/i.test(line) || /[\\\\/]antigravity[\\\\/]/i.test(line));
                }),
                ...items.filter((item) => {
                    const line = String(item.CommandLine || '');
                    return !(line && (/--app[_-]data[_-]dir\\s+antigravity/i.test(line) || /[\\\\/]antigravity[\\\\/]/i.test(line)));
                }),
            ];

            for (const proc of prioritized) {
                const pid = Number(proc.ProcessId);
                const commandLine = String(proc.CommandLine || '');
                const csrfToken =
                    extractArgValue(commandLine, 'csrf_token') ||
                    extractArgValue(commandLine, 'extension_server_csrf_token');
                if (!pid || !csrfToken) continue;

                const extensionPort = Number(extractArgValue(commandLine, 'extension_server_port'));
                const portsCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress"`;
                let ports = [];
                try {
                    const { stdout: portsOut } = await execAsync(portsCmd);
                    if (portsOut.trim()) {
                        const parsed = JSON.parse(portsOut.trim());
                        ports = (Array.isArray(parsed) ? parsed : [parsed])
                            .map(Number)
                            .filter((p) => Number.isFinite(p) && p > 0)
                            .sort((a, b) => a - b);
                    }
                } catch { }

                const candidatePorts = [...new Set([
                    ...ports,
                    ...(Number.isFinite(extensionPort) && extensionPort > 0 ? [extensionPort] : []),
                ])];
                for (const port of candidatePorts) {
                    try {
                        if (await probeLanguageServerEndpoint('127.0.0.1', port, csrfToken, postLsJson)) {
                            return { pid, port, csrfToken };
                        }
                    } catch { }
                }
            }
            return null;
        }

        const { stdout } = await execAsync(process.platform === 'darwin' ? 'pgrep -fl language_server' : 'pgrep -af language_server');
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const line = lines.find((l) => l.includes('--csrf_token') || l.includes('-csrf_token'));
        if (!line) return null;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[0]);
        const commandLine = line.slice(parts[0].length).trim();
        const csrfToken =
            extractArgValue(commandLine, 'csrf_token') ||
            extractArgValue(commandLine, 'extension_server_csrf_token');
        if (!pid || !csrfToken) return null;

        const portsCmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
            : `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
        const { stdout: portText } = await execAsync(portsCmd);
        let ports = parsePortsFromSsOutput(portText, pid);
        if (ports.length === 0) ports = parsePortsFromLsofOutput(portText, pid);
        for (const port of ports) {
            try {
                if (await probeLanguageServerEndpoint('127.0.0.1', port, csrfToken, postLsJson)) {
                    return { pid, port, csrfToken };
                }
            } catch { }
        }
    } catch {
    }
    return null;
}

async function fetchQuotaSnapshot(deps) {
    const { execAsync, normalizeQuotaSnapshot, extractActiveModelId } = deps;
    const ls = await detectLanguageServer({ execAsync });
    if (!ls) return { ls: null, quota: null, error: 'ls_not_found' };
    const data = await postLsJson('127.0.0.1', ls.port, ls.csrfToken, 'GetUserStatus', {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en',
        },
    }, 3000);
    let activeModelId = null;
    try {
        const conversation = await postLsJson('127.0.0.1', ls.port, ls.csrfToken, 'GetBrowserOpenConversation', {}, 2000);
        activeModelId = extractActiveModelId(conversation);
    } catch {
    }
    return {
        ls: {
            port: ls.port,
            csrfToken: ls.csrfToken,
            lastDetectedAt: Date.now(),
            sourceHost: '127.0.0.1',
        },
        quota: normalizeQuotaSnapshot(data, activeModelId),
        error: null,
    };
}

module.exports = {
    probeLanguageServerEndpoint,
    postLsJson,
    parsePortsFromSsOutput,
    parsePortsFromLsofOutput,
    extractArgValue,
    detectLanguageServer,
    fetchQuotaSnapshot,
};
