const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');
const { startAutoAccept, stopAutoAccept } = require('./auto-accept');

const REGISTRY_DIR = path.join(os.homedir(), '.antigravity-mcp');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');
const QUOTA_POLL_INTERVAL_MS = 60_000;
const CDP_HEARTBEAT_INTERVAL_MS = 30_000;
const CDP_PROBE_TIMEOUT_MS = 250;
const CDP_MAX_HOSTS = 8;
const CDP_PROBE_SUMMARY_LIMIT = 40;
const DEFAULT_CDP_PORT_SPEC = '9222,9229,9000-9014,8997-9003,7800-7850';
const DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT = 15;
const DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT = 5;
const DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES = 30;
const execAsync = promisify(exec);


let outputChannel;

function clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function formatAgeMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

function log(msg) {
    const time = new Date().toLocaleTimeString();
    const fullMsg = `[${time}] ${msg}`;
    console.log(fullMsg);
    if (outputChannel) {
        outputChannel.appendLine(fullMsg);
    }
}

function getJson(url, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
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
            reject(new Error('timeout'));
        });
    });
}

function dedupeStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const v = String(value || '').trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

function parsePortCandidates(spec) {
    const source = String(spec || '').trim();
    if (!source) return [];
    const out = [];
    for (const tokenRaw of source.split(',')) {
        const token = tokenRaw.trim();
        if (!token) continue;
        const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
            const start = Number(range[1]);
            const end = Number(range[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const lo = Math.max(1, Math.min(start, end));
            const hi = Math.min(65535, Math.max(start, end));
            for (let p = lo; p <= hi; p++) out.push(p);
            continue;
        }
        const port = Number(token);
        if (!Number.isFinite(port)) continue;
        if (port >= 1 && port <= 65535) out.push(port);
    }
    return [...new Set(out)];
}

function trimProbeSummary(summary) {
    if (!Array.isArray(summary)) return [];
    if (summary.length <= CDP_PROBE_SUMMARY_LIMIT) return summary;
    return summary.slice(summary.length - CDP_PROBE_SUMMARY_LIMIT);
}

function buildCandidateMatrix(hosts, ports, limit = CDP_PROBE_SUMMARY_LIMIT) {
    const out = [];
    for (const host of hosts || []) {
        for (const port of ports || []) {
            out.push({ host, port });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function shortError(error) {
    const message = error && error.message ? error.message : String(error || 'unknown');
    return message.slice(0, 180);
}

function inferGatewayIpFromRouteTable(routeTable) {
    const lines = String(routeTable || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const destination = parts[1];
        const gatewayHex = parts[2];
        if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gatewayHex)) continue;

        const b1 = parseInt(gatewayHex.slice(6, 8), 16);
        const b2 = parseInt(gatewayHex.slice(4, 6), 16);
        const b3 = parseInt(gatewayHex.slice(2, 4), 16);
        const b4 = parseInt(gatewayHex.slice(0, 2), 16);
        return `${b1}.${b2}.${b3}.${b4}`;
    }
    return null;
}

function isRoutablePrivateHost(ip) {
    const v = String(ip || '').trim();
    if (!v) return false;
    if (v === '127.0.0.1' || v === 'localhost') return true;
    if (v === '::1') return true;

    const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range (often tailscale local)
    if (a === 169 && b === 254) return true;
    return false;
}

function getHostIps(fixedHost) {
    const ips = ['127.0.0.1', 'localhost'];
    if (fixedHost && String(fixedHost).trim()) ips.unshift(String(fixedHost).trim());

    const envHosts = []
        .concat(String(process.env.ANTIGRAVITY_CDP_HOSTS || '').split(','))
        .concat(String(process.env.ANTIGRAVITY_CDP_HOST || '').split(','))
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    ips.push(...envHosts);

    // In WSL, the Windows host gateway from /proc/net/route is the most stable probe target.
    try {
        if (fs.existsSync('/proc/net/route')) {
            const routeTable = fs.readFileSync('/proc/net/route', 'utf8');
            const gatewayIp = inferGatewayIpFromRouteTable(routeTable);
            if (gatewayIp) ips.push(gatewayIp);
        }
    } catch { }

    // In some environments the host still appears as nameserver in resolv.conf.
    try {
        if (fs.existsSync('/etc/resolv.conf')) {
            const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
            const matches = [...resolv.matchAll(/^nameserver\s+([\d.]+)/gm)];
            for (const match of matches) {
                const candidate = match && match[1] ? match[1] : '';
                if (isRoutablePrivateHost(candidate)) ips.push(candidate);
            }
        }
    } catch { }

    // Add local interface addresses (useful for Tailscale and non-localhost bindings).
    try {
        const interfaces = os.networkInterfaces();
        for (const rows of Object.values(interfaces)) {
            for (const row of rows || []) {
                if (!row || row.family !== 'IPv4' || row.internal) continue;
                if (isRoutablePrivateHost(row.address)) ips.push(row.address);
            }
        }
    } catch { }
    return dedupeStrings(ips);
}

function readRegistryIps(workspacePath) {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
        if (!parsed || typeof parsed !== 'object') return [];

        const ips = [];
        const entries = Object.entries(parsed);
        const normalizedWorkspacePath = String(workspacePath || '').replace(/\\/g, '/');

        for (const [rawKey, value] of entries) {
            if (!value || typeof value !== 'object') continue;
            const entryIp = String(value.ip || '').trim();
            if (!entryIp) continue;

            const normalizedKey = String(rawKey || '').replace(/\\/g, '/');
            const sameWorkspace = normalizedWorkspacePath && normalizedKey === normalizedWorkspacePath;
            if (sameWorkspace) {
                ips.unshift(entryIp); // Prefer exact workspace hit.
            } else {
                ips.push(entryIp);
            }
        }
        return dedupeStrings(ips);
    } catch {
        return [];
    }
}

function readRegistryObject() {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { }
    return {};
}

function writeRegistryObject(registry) {
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

function extractArgValue(cmdline, name) {
    const re = new RegExp(`(?:--|-)${name}[=\\s]+([^\\s]+)`, 'i');
    const match = String(cmdline || '').match(re);
    return match ? match[1] : '';
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

async function detectLanguageServer() {
    try {
        if (process.platform === 'win32') {
            const cmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \\\"language_server*\\\" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"';
            const { stdout } = await execAsync(cmd);
            if (!stdout.trim()) return null;
            let data = JSON.parse(stdout.trim());
            const items = Array.isArray(data) ? data : [data];
            const proc = items.find((item) => {
                const line = String(item.CommandLine || '');
                return line && (/--app_data_dir\\s+antigravity/i.test(line) || /[\\\\/]antigravity[\\\\/]/i.test(line));
            }) || items[0];
            if (!proc) return null;
            const pid = Number(proc.ProcessId);
            const commandLine = String(proc.CommandLine || '');
            const csrfToken = extractArgValue(commandLine, 'csrf_token');
            if (!pid || !csrfToken) return null;

            const portsCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress"`;
            const { stdout: portsOut } = await execAsync(portsCmd);
            let ports = [];
            if (portsOut.trim()) {
                const parsed = JSON.parse(portsOut.trim());
                ports = Array.isArray(parsed) ? parsed : [parsed];
                ports = ports.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            }
            for (const port of ports) {
                try {
                    await postLsJson('127.0.0.1', port, csrfToken, 'GetUnleashData', { wrapper_data: {} }, 1500);
                    return { pid, port, csrfToken };
                } catch { }
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
        const csrfToken = extractArgValue(commandLine, 'csrf_token');
        if (!pid || !csrfToken) return null;

        const portsCmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
            : `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
        const { stdout: portText } = await execAsync(portsCmd);
        let ports = parsePortsFromSsOutput(portText, pid);
        if (ports.length === 0) ports = parsePortsFromLsofOutput(portText, pid);
        for (const port of ports) {
            try {
                await postLsJson('127.0.0.1', port, csrfToken, 'GetUnleashData', { wrapper_data: {} }, 1500);
                return { pid, port, csrfToken };
            } catch { }
        }
    } catch {
        // best effort only
    }
    return null;
}

function normalizeModelKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s_()-]+/g, '');
}

function modelIdMatches(a, b) {
    const left = normalizeModelKey(a);
    const right = normalizeModelKey(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function collectStringByKeys(value, keysLowerSet) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = collectStringByKeys(item, keysLowerSet);
            if (found) return found;
        }
        return null;
    }
    const obj = value;
    for (const [key, raw] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (keysLowerSet.has(keyLower) && typeof raw === 'string' && raw.trim()) {
            return raw.trim();
        }
        const nested = collectStringByKeys(raw, keysLowerSet);
        if (nested) return nested;
    }
    return null;
}

function extractActiveModelId(conversation) {
    const candidate = collectStringByKeys(conversation, new Set([
        'model',
        'modelid',
        'selectedmodel',
        'activemodel',
        'modelalias',
    ]));
    return candidate || null;
}

function normalizeQuotaSnapshot(data, activeModelId) {
    const userStatus = (data && data.userStatus) || {};
    const planStatus = userStatus.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const availablePromptCredits = planStatus.availablePromptCredits;
    let promptCredits;
    if (typeof availablePromptCredits === 'number' && typeof planInfo.monthlyPromptCredits === 'number' && planInfo.monthlyPromptCredits > 0) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availablePromptCredits);
        promptCredits = {
            available,
            monthly,
            usedPercentage: ((monthly - available) / monthly) * 100,
            remainingPercentage: (available / monthly) * 100,
        };
    }

    const models = Array.isArray(userStatus.cascadeModelConfigData && userStatus.cascadeModelConfigData.clientModelConfigs)
        ? userStatus.cascadeModelConfigData.clientModelConfigs
        : [];

    const now = Date.now();
    return {
        timestamp: now,
        source: 'GetUserStatus',
        promptCredits,
        models: models
            .filter((m) => m && m.quotaInfo)
            .map((m) => {
                const resetTime = String(m.quotaInfo.resetTime || '');
                const resetMs = resetTime ? Date.parse(resetTime) : NaN;
                const modelId = String((m.modelOrAlias && m.modelOrAlias.model) || m.model || '');
                const label = String(m.label || '');
                const selectedHint = m.isSelected === true || m.selected === true || m.current === true || m.isCurrent === true;
                const selectedByActiveId = !!activeModelId && (modelIdMatches(modelId, activeModelId) || modelIdMatches(label, activeModelId));
                return {
                    label,
                    modelId,
                    remainingFraction: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : undefined,
                    remainingPercentage: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction * 100 : undefined,
                    isExhausted: m.quotaInfo.remainingFraction === 0,
                    isSelected: selectedHint || selectedByActiveId,
                    resetTime,
                    resetInMs: Number.isFinite(resetMs) ? resetMs - now : undefined,
                };
            }),
        activeModelId: activeModelId || undefined,
    };
}

async function fetchQuotaSnapshot() {
    const ls = await detectLanguageServer();
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
        // Best effort only.
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

function summarizeQuota(quota) {
    if (!quota || typeof quota !== 'object') return null;

    const prompt = quota.promptCredits && typeof quota.promptCredits === 'object'
        ? quota.promptCredits
        : null;
    const models = Array.isArray(quota.models) ? quota.models : [];

    const modelPercents = models
        .map((m) => (m && typeof m.remainingPercentage === 'number' ? m.remainingPercentage : null))
        .filter((v) => typeof v === 'number');
    const exhaustedCount = models.filter((m) => m && m.isExhausted === true).length;
    const activeModel = models.find((m) => m && m.isSelected) || models.find((m) => modelIdMatches((m && m.modelId) || (m && m.label), quota.activeModelId));

    const promptRemaining = prompt && typeof prompt.remainingPercentage === 'number'
        ? prompt.remainingPercentage
        : null;
    const minModelRemaining = modelPercents.length > 0 ? Math.min(...modelPercents) : null;
    const activeModelRemaining = activeModel && typeof activeModel.remainingPercentage === 'number'
        ? activeModel.remainingPercentage
        : null;
    const activeModelName = activeModel
        ? (activeModel.label || activeModel.modelId || quota.activeModelId || null)
        : (quota.activeModelId || null);

    const primaryPercent = activeModelRemaining !== null
        ? activeModelRemaining
        : (promptRemaining !== null ? promptRemaining : minModelRemaining);
    const primaryLabel = activeModelName
        ? `model ${activeModelName}`
        : (promptRemaining !== null ? 'prompt credits' : 'model quota');

    return {
        primaryPercent,
        primaryLabel,
        promptRemaining,
        minModelRemaining,
        activeModelName,
        activeModelRemaining,
        modelCount: models.length,
        exhaustedCount,
    };
}

function formatQuotaTooltip(quota, quotaError) {
    const lines = ['Quota snapshot (click to view details)'];
    if (quotaError) {
        lines.push(`Last error: ${quotaError}`);
    }
    const summary = summarizeQuota(quota);
    if (!summary) {
        lines.push('No snapshot yet.');
        return lines.join('\n');
    }
    if (quota && quota.timestamp) {
        lines.push(`Snapshot age: ${formatAgeMs(Date.now() - Number(quota.timestamp))}`);
    }
    if (summary.promptRemaining !== null) {
        lines.push(`Prompt credits remaining: ${summary.promptRemaining.toFixed(1)}%`);
    }
    if (summary.activeModelName) {
        lines.push(`Active model: ${summary.activeModelName}`);
    }
    if (summary.activeModelRemaining !== null) {
        lines.push(`Active model remaining: ${summary.activeModelRemaining.toFixed(1)}%`);
    }
    if (summary.minModelRemaining !== null) {
        lines.push(`Lowest model remaining: ${summary.minModelRemaining.toFixed(1)}%`);
    }
    lines.push(`Models tracked: ${summary.modelCount}, exhausted: ${summary.exhaustedCount}`);
    return lines.join('\n');
}

function formatQuotaReport(quota, quotaError) {
    const lines = ['=== Antigravity Quota Snapshot ==='];
    if (quotaError) lines.push(`lastError: ${quotaError}`);
    if (!quota || typeof quota !== 'object') {
        lines.push('No quota snapshot available yet.');
        return lines.join('\n');
    }

    if (quota.timestamp) {
        lines.push(`timestamp: ${new Date(quota.timestamp).toISOString()}`);
        lines.push(`snapshotAge: ${formatAgeMs(Date.now() - Number(quota.timestamp))}`);
    }
    if (quota.source) {
        lines.push(`source: ${quota.source}`);
    }
    if (quota.activeModelId) {
        lines.push(`activeModelId: ${quota.activeModelId}`);
    }
    const prompt = quota.promptCredits;
    if (prompt && typeof prompt === 'object') {
        lines.push(
            `promptCredits: available=${prompt.available ?? 'n/a'} ` +
            `monthly=${prompt.monthly ?? 'n/a'} ` +
            `remaining=${typeof prompt.remainingPercentage === 'number' ? prompt.remainingPercentage.toFixed(1) + '%' : 'n/a'}`
        );
    }

    const models = Array.isArray(quota.models) ? quota.models : [];
    if (models.length > 0) {
        lines.push('models:');
        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || ''))
        );
        for (const model of sorted) {
            const id = model.modelId || model.label || 'unknown';
            const remaining = typeof model.remainingPercentage === 'number'
                ? `${model.remainingPercentage.toFixed(1)}%`
                : 'n/a';
            const selected = model.isSelected ? ', selected=yes' : '';
            lines.push(`- ${id}: remaining=${remaining}, exhausted=${model.isExhausted ? 'yes' : 'no'}${selected}`);
        }
    } else {
        lines.push('models: none');
    }

    return lines.join('\n');
}

function looksLikeAntigravityVersion(versionPayload) {
    if (!versionPayload || typeof versionPayload !== 'object') return false;
    const browser = String(versionPayload.Browser || '');
    const ua = String(versionPayload['User-Agent'] || versionPayload.userAgent || '');
    const wsUrl = String(versionPayload.webSocketDebuggerUrl || '');
    const marker = `${browser} ${ua} ${wsUrl}`.toLowerCase();
    return (
        marker.includes('antigravity') ||
        marker.includes('cursor') ||
        marker.includes('codeium')
    );
}

async function findCdpTarget(params) {
    const { workspaceName, hosts, ports } = params;
    const summary = [];
    let lastError = '';

    for (const ip of hosts) {
        for (const port of ports) {
            let version = null;
            try {
                version = await getJson(`http://${ip}:${port}/json/version`, CDP_PROBE_TIMEOUT_MS);
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'version', ok: false, error: message });
                lastError = `${ip}:${port} version ${message}`;
                continue;
            }

            if (looksLikeAntigravityVersion(version)) {
                summary.push({ host: ip, port, stage: 'version', ok: true, source: 'version' });
                return {
                    target: { ip, port, source: 'version', version },
                    summary: trimProbeSummary(summary),
                    lastError: '',
                };
            }

            // Fallback for variants where version marker is not explicit.
            try {
                const list = await getJson(`http://${ip}:${port}/json/list`, CDP_PROBE_TIMEOUT_MS);
                const pages = Array.isArray(list)
                    ? list.filter((t) => t && t.type === 'page' && !(t.url && t.url.includes('jetski')))
                    : [];
                const workbenches = pages.filter((t) => t.url && t.url.includes('workbench.html'));

                const matchingWorkbench = workbenches.find((t) =>
                    !workspaceName || String(t.title || '').includes(workspaceName)
                );
                const workbench = matchingWorkbench || workbenches[0] || pages[0];

                if (workbench) {
                    summary.push({ host: ip, port, stage: 'list', ok: true, source: 'list' });
                    return {
                        target: { ip, port, source: 'list', version },
                        summary: trimProbeSummary(summary),
                        lastError: '',
                    };
                }

                summary.push({ host: ip, port, stage: 'list', ok: false, error: 'no_page_target' });
                lastError = `${ip}:${port} list no_page_target`;
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'list', ok: false, error: message });
                lastError = `${ip}:${port} list ${message}`;
            }
        }
    }

    return { target: null, summary: trimProbeSummary(summary), lastError: lastError || 'no_cdp_target' };
}

function buildCdpProbePlan(params) {
    const { workspacePath, fixedHost, fixedPort, portSpec } = params;
    const allHosts = dedupeStrings([
        ...readRegistryIps(workspacePath),
        ...getHostIps(fixedHost),
    ]);
    const hosts = allHosts.slice(0, CDP_MAX_HOSTS);

    const parsedPorts = parsePortCandidates(portSpec || DEFAULT_CDP_PORT_SPEC);
    const fallbackPorts = parsePortCandidates(DEFAULT_CDP_PORT_SPEC);
    const basePorts = parsedPorts.length > 0 ? parsedPorts : fallbackPorts;
    const fixed = Number(fixedPort);
    const ports = Number.isFinite(fixed) && fixed > 0 && fixed <= 65535
        ? [fixed, ...basePorts.filter((p) => p !== fixed)]
        : basePorts;

    return { hosts, ports };
}

function splitArgs(raw) {
    const source = String(raw || '').trim();
    if (!source) return [];
    return source.split(/\s+/).filter(Boolean);
}

function resolveDefaultExecutablePath() {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local');
        const candidates = [
            path.win32.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
            path.win32.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    const candidates = [];
    const usersRoot = '/mnt/c/Users';
    try {
        if (fs.existsSync(usersRoot)) {
            const users = fs.readdirSync(usersRoot, { withFileTypes: true });
            for (const user of users) {
                if (!user.isDirectory()) continue;
                candidates.push(path.posix.join(usersRoot, user.name, 'AppData/Local/Programs/Antigravity/Antigravity.exe'));
                candidates.push(path.posix.join(usersRoot, user.name, 'AppData/Local/Programs/Cursor/Cursor.exe'));
            }
        }
    } catch { }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

function psQuote(value) {
    return String(value || '').replace(/'/g, "''");
}

function buildLaunchArgsForWorkspace(workspacePath, port, extraArgs) {
    return [
        workspacePath,
        '--new-window',
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=0.0.0.0',
        ...extraArgs,
    ];
}

function launchAntigravityDetached(params) {
    const { executable, args, restart } = params;
    if (process.platform === 'win32') {
        const exe = psQuote(executable);
        const argList = args.map((item) => `'${psQuote(item)}'`).join(',');
        const script = restart
            ? `$ErrorActionPreference='SilentlyContinue'; Get-Process Antigravity,Cursor | Stop-Process -Force; Start-Sleep -Milliseconds 500; Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`
            : `Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`;

        const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        return;
    }

    if (restart) {
        try {
            spawn('pkill', ['-f', 'Antigravity|Cursor'], { stdio: 'ignore' });
        } catch { }
    }
    const child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
    });
    child.unref();
}

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Antigravity MCP Sidecar');
    context.subscriptions.push(outputChannel);
    log('Extension activating...');

    let latestLs = null;
    let latestQuota = null;
    let latestQuotaError = null;
    let lastQuotaAlertLevel = 'none';
    let lastQuotaAlertAt = 0;

    // ─── Status Bar (always registered, regardless of CDP) ────────────
    let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravityMcpSidecar.toggle';
    context.subscriptions.push(statusBarItem);

    let quotaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    quotaStatusBarItem.command = 'antigravityMcpSidecar.showQuota';
    context.subscriptions.push(quotaStatusBarItem);

    let isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
    let cdpTarget = null;
    let cdpGeneration = 0;
    let cdpProbeSummary = [];
    let cdpLastError = null;
    let cdpState = 'idle';
    let cdpVerifiedAt = 0;
    let cdpSource = null;
    let cdpHeartbeatRunning = false;
    let cdpFixedHost = '';
    let cdpFixedPort = 0;
    let cdpPortSpec = DEFAULT_CDP_PORT_SPEC;
    let antigravityExecutablePath = '';
    let antigravityLaunchExtraArgs = [];
    let antigravityLaunchPort = 9000;
    let cdpProbeHosts = [];
    let cdpProbePorts = [];
    let register = () => { };
    let negotiateCdp = async () => false;
    let workspacePath = '';
    let workspaceName = '';
    let quotaWarnThresholdPercent = DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT;
    let quotaCriticalThresholdPercent = DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT;
    let quotaAlertCooldownMs = DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES * 60_000;
    let quotaStaleMinutes = 3;

    function reloadQuotaUiConfig() {
        const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
        quotaWarnThresholdPercent = clampNumber(
            config.get('quotaWarnThresholdPercent', DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT),
            0,
            100
        );
        quotaCriticalThresholdPercent = clampNumber(
            config.get('quotaCriticalThresholdPercent', DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT),
            0,
            100
        );
        if (quotaCriticalThresholdPercent > quotaWarnThresholdPercent) {
            const tmp = quotaWarnThresholdPercent;
            quotaWarnThresholdPercent = quotaCriticalThresholdPercent;
            quotaCriticalThresholdPercent = tmp;
        }
        quotaStaleMinutes = clampNumber(config.get('quotaStaleMinutes', 3), 1, 120);
        const cooldownMinutes = clampNumber(
            config.get('quotaAlertCooldownMinutes', DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES),
            1,
            720
        );
        quotaAlertCooldownMs = cooldownMinutes * 60_000;
    }

    reloadQuotaUiConfig();

    function reloadCdpConfig() {
        const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
        cdpFixedHost = String(config.get('cdpFixedHost', '') || '').trim();
        cdpFixedPort = clampNumber(config.get('cdpFixedPort', 0), 0, 65535);
        cdpPortSpec = String(config.get('cdpPortCandidates', DEFAULT_CDP_PORT_SPEC) || DEFAULT_CDP_PORT_SPEC);
        const configuredExe = String(config.get('antigravityExecutablePath', '') || '').trim();
        antigravityExecutablePath = configuredExe || resolveDefaultExecutablePath();
        antigravityLaunchExtraArgs = splitArgs(config.get('antigravityLaunchExtraArgs', ''));
        antigravityLaunchPort = clampNumber(config.get('antigravityLaunchPort', 9000), 1, 65535);
    }

    reloadCdpConfig();

    function getQuotaLevel(summary) {
        if (!summary) return { level: 'none', watchedPercent: null, target: 'quota' };

        if (summary.activeModelRemaining !== null) {
            const percent = summary.activeModelRemaining;
            const target = summary.activeModelName ? `model ${summary.activeModelName}` : 'active model';
            if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
            if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
            return { level: 'none', watchedPercent: percent, target };
        }
        if (summary.promptRemaining !== null) {
            const percent = summary.promptRemaining;
            const target = 'prompt credits';
            if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
            if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
            return { level: 'none', watchedPercent: percent, target };
        }
        if (summary.minModelRemaining !== null) {
            const percent = summary.minModelRemaining;
            const target = 'lowest model quota';
            if (percent <= quotaCriticalThresholdPercent) return { level: 'critical', watchedPercent: percent, target };
            if (percent <= quotaWarnThresholdPercent) return { level: 'warning', watchedPercent: percent, target };
            return { level: 'none', watchedPercent: percent, target };
        }
        return { level: 'none', watchedPercent: null, target: 'quota' };
    }

    function updateQuotaStatusBar() {
        if (!cdpTarget) {
            quotaStatusBarItem.hide();
            return;
        }

        const summary = summarizeQuota(latestQuota);
        const snapshotAgeMs = latestQuota && latestQuota.timestamp
            ? Date.now() - Number(latestQuota.timestamp)
            : Number.POSITIVE_INFINITY;
        const isStale = !Number.isFinite(snapshotAgeMs) || snapshotAgeMs > quotaStaleMinutes * 60_000;
        const level = getQuotaLevel(summary).level;
        if (summary && summary.activeModelName && summary.activeModelRemaining !== null) {
            const modelShort = summary.activeModelName.replace(/^.*\//, '').slice(0, 16);
            quotaStatusBarItem.text = `${isStale ? '$(history)' : '$(graph)'} ${modelShort} ${Math.max(0, summary.activeModelRemaining).toFixed(0)}%`;
        } else if (summary && summary.primaryPercent !== null) {
            quotaStatusBarItem.text = `${isStale ? '$(history)' : '$(graph)'} Quota ${Math.max(0, summary.primaryPercent).toFixed(0)}%`;
        } else if (latestQuotaError) {
            quotaStatusBarItem.text = '$(warning) Quota N/A';
        } else {
            quotaStatusBarItem.text = '$(sync~spin) Quota ...';
        }
        if (level === 'critical') {
            quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (level === 'warning') {
            quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            quotaStatusBarItem.backgroundColor = undefined;
        }
        quotaStatusBarItem.tooltip = formatQuotaTooltip(latestQuota, latestQuotaError);
        quotaStatusBarItem.show();
    }

    function updateStatusBar() {
        if (!cdpTarget) {
            statusBarItem.text = '$(warning) Sidecar: No CDP';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'CDP port not found — auto-accept unavailable';
            statusBarItem.show();
        } else if (isEnabled) {
            statusBarItem.text = '$(zap) Sidecar: ON';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'Auto-accept is ACTIVE — click to disable';
            statusBarItem.show();
        } else {
            statusBarItem.text = '$(circle-slash) Sidecar: OFF';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'Auto-accept is OFF — click to enable';
            statusBarItem.show();
        }
        updateQuotaStatusBar();
    }

    function maybeNotifyLowQuota() {
        const summary = summarizeQuota(latestQuota);
        if (!summary) return;
        const snapshotAgeMs = latestQuota && latestQuota.timestamp
            ? Date.now() - Number(latestQuota.timestamp)
            : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs > quotaStaleMinutes * 60_000) {
            return;
        }
        const levelInfo = getQuotaLevel(summary);
        const level = levelInfo.level;
        const watchedPercent = levelInfo.watchedPercent;

        if (level === 'none') {
            lastQuotaAlertLevel = 'none';
            return;
        }
        if (watchedPercent === null) return;

        const now = Date.now();
        const shouldNotify =
            level !== lastQuotaAlertLevel ||
            (now - lastQuotaAlertAt) > quotaAlertCooldownMs;
        if (!shouldNotify) return;

        const message = `Antigravity quota low: ${levelInfo.target} remaining ${watchedPercent.toFixed(1)}%`;

        if (level === 'critical') {
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showWarningMessage(message);
        }
        log(`Quota alert (${level}): ${message}`);
        lastQuotaAlertLevel = level;
        lastQuotaAlertAt = now;
    }

    function syncState() {
        if (isEnabled && cdpTarget) {
            const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
            startAutoAccept(cdpTarget.port, log, config.get('nativePollInterval', 500), config.get('cdpPollInterval', 1500), cdpTarget.ip);
            log(`Auto-accept loops running on ${cdpTarget.ip}:${cdpTarget.port}`);
        } else {
            stopAutoAccept();
            if (!cdpTarget) {
                log('Auto-accept unavailable: no CDP debug port found');
            } else {
                log('Auto-accept paused');
            }
        }
        updateStatusBar();
    }

    async function executeManualLaunch(action) {
        if (!workspacePath) {
            vscode.window.showWarningMessage('No workspace folder available for Antigravity launch.');
            return;
        }
        if (!antigravityExecutablePath || !fs.existsSync(antigravityExecutablePath)) {
            vscode.window.showWarningMessage(
                'Antigravity executable not found. Configure antigravityMcpSidecar.antigravityExecutablePath first.'
            );
            return;
        }

        const selectedPort = cdpFixedPort > 0 ? cdpFixedPort : antigravityLaunchPort;
        const launchArgs = buildLaunchArgsForWorkspace(workspacePath, selectedPort, antigravityLaunchExtraArgs);
        try {
            launchAntigravityDetached({
                executable: antigravityExecutablePath,
                args: launchArgs,
                restart: action === 'restart',
            });
            log(
                `${action === 'restart' ? 'Restarting' : 'Launching'} Antigravity with port=${selectedPort} workspace=${workspacePath}`
            );
        } catch (error) {
            const message = shortError(error);
            vscode.window.showErrorMessage(`Failed to ${action} Antigravity: ${message}`);
            return;
        }

        cdpState = 'probing';
        cdpLastError = null;
        cdpSource = action === 'restart' ? 'manual-restart' : 'manual-launch';
        register();

        // Give new process a short head start before probing.
        await new Promise((resolve) => setTimeout(resolve, action === 'restart' ? 1500 : 800));
        const ok = await negotiateCdp();
        stopAutoAccept();
        syncState();
        updateQuotaStatusBar();
        if (ok) {
            vscode.window.showInformationMessage(
                `Antigravity ${action === 'restart' ? 'restarted' : 'launched'} and CDP is ready on ${cdpTarget.ip}:${cdpTarget.port}.`
            );
            return;
        }
        vscode.window.showWarningMessage(
            `Antigravity ${action} command sent, but CDP is still unavailable. Check launch args and retry.`
        );
    }

    // ─── Toggle Command (always registered) ───────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.toggle', async () => {
        if (!cdpTarget) {
            vscode.window.showWarningMessage('Sidecar: No CDP port found. Cannot toggle auto-accept.');
            return;
        }
        isEnabled = !isEnabled;
        await vscode.workspace.getConfiguration('antigravityMcpSidecar').update('enabled', isEnabled, vscode.ConfigurationTarget.Global);
        syncState();
        vscode.window.showInformationMessage(`Sidecar Auto-Accept: ${isEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.launchAntigravity', async () => {
        await executeManualLaunch('launch');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.restartAntigravity', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Restart Antigravity now? This may interrupt your current window/session.',
            { modal: true },
            'Restart'
        );
        if (confirm !== 'Restart') return;
        await executeManualLaunch('restart');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showQuota', async () => {
        const report = formatQuotaReport(latestQuota, latestQuotaError);
        outputChannel.show(true);
        for (const line of report.split('\n')) {
            outputChannel.appendLine(line);
        }
        if (!latestQuota && latestQuotaError) {
            vscode.window.showWarningMessage(`Quota snapshot unavailable: ${latestQuotaError}`);
            return;
        }
        const summary = summarizeQuota(latestQuota);
        if (summary && summary.primaryPercent !== null) {
            vscode.window.showInformationMessage(`Quota: ${summary.primaryPercent.toFixed(1)}% remaining (${summary.primaryLabel})`);
        } else {
            vscode.window.showInformationMessage('Quota snapshot has been written to output channel.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showQuotaTable', async () => {
        const models = Array.isArray(latestQuota && latestQuota.models) ? latestQuota.models : [];
        if (models.length === 0) {
            vscode.window.showWarningMessage('No model quota snapshot available yet.');
            return;
        }

        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || ''))
        );
        const items = sorted.map((model) => {
            const id = model.modelId || model.label || 'unknown';
            const remaining = typeof model.remainingPercentage === 'number'
                ? `${model.remainingPercentage.toFixed(1)}%`
                : 'n/a';
            const selectedMark = model.isSelected ? ' [active]' : '';
            return {
                label: `${id}${selectedMark}`,
                description: `remaining=${remaining} exhausted=${model.isExhausted ? 'yes' : 'no'}`,
                detail: model.resetTime ? `reset=${model.resetTime}` : '',
            };
        });

        await vscode.window.showQuickPick(items, {
            title: 'Antigravity Model Quota',
            placeHolder: 'Sorted by model id/label',
            matchOnDescription: true,
            matchOnDetail: true,
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.refreshQuota', async () => {
        try {
            await refreshQuota();
            const summary = summarizeQuota(latestQuota);
            if (summary && summary.primaryPercent !== null) {
                vscode.window.showInformationMessage(`Quota refreshed: ${summary.primaryPercent.toFixed(1)}% (${summary.primaryLabel})`);
            } else {
                vscode.window.showInformationMessage('Quota refreshed.');
            }
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            vscode.window.showWarningMessage(`Quota refresh failed: ${message}`);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravityMcpSidecar')) {
            const prevFixedHost = cdpFixedHost;
            const prevFixedPort = cdpFixedPort;
            const prevPortSpec = cdpPortSpec;
            isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
            reloadQuotaUiConfig();
            reloadCdpConfig();
            const cdpConfigChanged =
                prevFixedHost !== cdpFixedHost ||
                prevFixedPort !== cdpFixedPort ||
                prevPortSpec !== cdpPortSpec;
            if (cdpConfigChanged) {
                cdpState = 'probing';
                register();
                negotiateCdp()
                    .then(() => {
                        stopAutoAccept();
                        syncState();
                        updateQuotaStatusBar();
                    })
                    .catch((error) => {
                        log(`CDP renegotiation failed after config change: ${shortError(error)}`);
                        stopAutoAccept();
                        syncState();
                        updateQuotaStatusBar();
                    });
                return;
            }
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
        }
    }));

    // ─── CDP Discovery ────────────────────────────────────────────────
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        log('No workspace folders found');
        updateStatusBar();
        return;
    }

    workspacePath = workspaceFolders[0].uri.fsPath;
    workspaceName = vscode.workspace.name || "";
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }

    register = () => {
        const registry = readRegistryObject();
        const previous = (registry[workspacePath] && typeof registry[workspacePath] === 'object')
            ? registry[workspacePath]
            : {};

        const previousCdp = previous.cdp && typeof previous.cdp === 'object' ? previous.cdp : {};
        const activeHost = cdpTarget ? cdpTarget.ip : (previousCdp.active && previousCdp.active.host) || previous.ip;
        const activePort = cdpTarget ? cdpTarget.port : (previousCdp.active && previousCdp.active.port) || previous.port;

        registry[workspacePath] = {
            ...previous,
            port: cdpTarget ? cdpTarget.port : previous.port,
            ip: cdpTarget ? cdpTarget.ip : previous.ip,
            pid: process.pid,
            lastActive: Date.now(),
            ls: latestLs || previous.ls,
            quota: latestQuota || previous.quota,
            quotaError: latestQuotaError,
            cdp: {
                ...previousCdp,
                generation: cdpGeneration,
                state: cdpState,
                updatedAt: Date.now(),
                verifiedAt: cdpVerifiedAt || previousCdp.verifiedAt,
                active: (activeHost && activePort)
                    ? {
                        host: activeHost,
                        port: activePort,
                        source: cdpSource || (previousCdp.active && previousCdp.active.source) || 'registry',
                        verifiedAt: cdpVerifiedAt || (previousCdp.active && previousCdp.active.verifiedAt) || Date.now(),
                    }
                    : undefined,
                candidates: buildCandidateMatrix(cdpProbeHosts, cdpProbePorts),
                probeSummary: trimProbeSummary(cdpProbeSummary),
                lastError: cdpLastError || undefined,
            },
        };

        writeRegistryObject(registry);
    };

    negotiateCdp = async () => {
        const previous = readRegistryObject()[workspacePath];
        const previousGeneration = previous && previous.cdp && Number.isFinite(previous.cdp.generation)
            ? Number(previous.cdp.generation)
            : 0;
        cdpGeneration = previousGeneration + 1;

        const plan = buildCdpProbePlan({
            workspacePath,
            fixedHost: cdpFixedHost,
            fixedPort: cdpFixedPort,
            portSpec: cdpPortSpec,
        });
        cdpProbeHosts = plan.hosts;
        cdpProbePorts = plan.ports;
        cdpProbeSummary = [];
        cdpLastError = null;
        cdpState = 'probing';
        cdpSource = null;
        cdpVerifiedAt = 0;
        register();

        log(`Probing CDP hosts: ${cdpProbeHosts.join(',') || 'none'} ports=${cdpProbePorts.slice(0, 8).join(',')}${cdpProbePorts.length > 8 ? ',...' : ''}`);
        const result = await findCdpTarget({
            workspaceName,
            hosts: cdpProbeHosts,
            ports: cdpProbePorts,
        });
        cdpProbeSummary = result.summary || [];

        if (result.target) {
            cdpTarget = { ip: result.target.ip, port: result.target.port };
            cdpState = 'ready';
            cdpSource = result.target.source || 'probe';
            cdpVerifiedAt = Date.now();
            cdpLastError = null;
            register();
            log(`Registered workspace ${workspacePath} with CDP target ${cdpTarget.ip}:${cdpTarget.port} (source=${cdpSource})`);
            return true;
        }

        cdpTarget = null;
        cdpState = 'error';
        cdpLastError = result.lastError || 'no_cdp_target';
        register();
        log(`Error: Could not find CDP port for workspace: ${workspacePath}`);
        log(`Probe hosts: ${cdpProbeHosts.join(',')}`);
        log(`CDP last error: ${cdpLastError}`);
        return false;
    };

    if (!(await negotiateCdp())) {
        updateStatusBar();

        // ─── CDP Auto-Fix Prompt ──────────────────────────────────────
        const platform = process.platform;
        const actions = ['How to Fix'];
        if (platform === 'win32') actions.unshift('Auto-Fix Shortcut (Windows)');

        vscode.window.showErrorMessage(
            '⚡ Sidecar: No CDP debug port found. Antigravity must be launched with an available --remote-debugging-port (for example 9000) and --remote-debugging-address=0.0.0.0.',
            ...actions
        ).then(action => {
            if (action === 'How to Fix') {
                const guide = platform === 'linux'
                    ? 'Launch Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=0.0.0.0, then restart VS Code window.'
                    : platform === 'darwin'
                        ? 'Open Terminal and run: open -a "Antigravity" --args --remote-debugging-port=9000 --remote-debugging-address=0.0.0.0'
                        : 'Restart Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=0.0.0.0.';
                vscode.window.showInformationMessage(guide, { modal: true });
            } else if (action === 'Auto-Fix Shortcut (Windows)') {
                autoFixWindowsShortcut();
            }
        });

        return;
    }

    const refreshQuota = async () => {
        try {
            const result = await fetchQuotaSnapshot();
            latestLs = result.ls || latestLs;
            latestQuota = result.quota || latestQuota;
            latestQuotaError = result.error;
            register();
            if (result.quota) {
                log(`Quota snapshot updated (${result.quota.models ? result.quota.models.length : 0} model entries)`);
            } else if (result.error) {
                log(`Quota snapshot unavailable: ${result.error}`);
            }
            updateQuotaStatusBar();
            maybeNotifyLowQuota();
        } catch (e) {
            latestQuotaError = e && e.message ? e.message : String(e);
            register();
            log(`Quota refresh failed: ${latestQuotaError}`);
            updateQuotaStatusBar();
        }
    };

    await refreshQuota();
    const quotaTimer = setInterval(() => {
        refreshQuota().catch(() => { });
    }, QUOTA_POLL_INTERVAL_MS);
    context.subscriptions.push({
        dispose: () => clearInterval(quotaTimer),
    });

    const heartbeatCdp = async () => {
        if (cdpHeartbeatRunning) return;
        if (!cdpTarget) return;
        cdpHeartbeatRunning = true;
        try {
            const version = await getJson(`http://${cdpTarget.ip}:${cdpTarget.port}/json/version`, CDP_PROBE_TIMEOUT_MS);
            if (!looksLikeAntigravityVersion(version)) {
                throw new Error('version_not_antigravity');
            }
            cdpState = 'ready';
            cdpSource = cdpSource || 'heartbeat';
            cdpVerifiedAt = Date.now();
            cdpLastError = null;
            register();
        } catch (error) {
            cdpState = 'probing';
            cdpLastError = `heartbeat ${shortError(error)}`;
            register();
            const recovered = await negotiateCdp();
            if (!recovered) {
                cdpTarget = null;
                log(`CDP heartbeat recovery failed: ${cdpLastError || 'unknown'}`);
            } else {
                log(`CDP heartbeat recovered endpoint ${cdpTarget.ip}:${cdpTarget.port}`);
            }
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
        } finally {
            cdpHeartbeatRunning = false;
        }
    };

    const cdpHeartbeatTimer = setInterval(() => {
        heartbeatCdp().catch((error) => {
            log(`CDP heartbeat error: ${shortError(error)}`);
        });
    }, CDP_HEARTBEAT_INTERVAL_MS);
    context.subscriptions.push({
        dispose: () => clearInterval(cdpHeartbeatTimer),
    });

    syncState();

    context.subscriptions.push({
        dispose: () => {
            stopAutoAccept();
            if (fs.existsSync(REGISTRY_FILE)) {
                try {
                    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
                    if (registry[workspacePath] && registry[workspacePath].pid === process.pid) {
                        delete registry[workspacePath];
                        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
                        log(`Deregistered workspace ${workspacePath}`);
                    }
                } catch { }
            }
        }
    });
}

function autoFixWindowsShortcut() {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Auto-fix is Windows-only. See the "How to Fix" option for your platform.');
        return;
    }

    const cp = require('child_process');
    const psFile = path.join(os.tmpdir(), 'antigravity_patch_shortcut.ps1');
    const psContent = `
$flag = "--remote-debugging-port=9222"
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs"
)
$patched = $false
foreach ($dir in $paths) {
    if (Test-Path $dir) {
        $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            $shortcut = $WshShell.CreateShortcut($file.FullName)
            if ($shortcut.TargetPath -like "*Antigravity*" -or $shortcut.TargetPath -like "*Cursor*") {
                if ($shortcut.Arguments -notlike "*remote-debugging-port*") {
                    $shortcut.Arguments = ($shortcut.Arguments + " " + $flag).Trim()
                    $shortcut.Save()
                    $patched = $true
                    Write-Output "PATCHED: $($file.FullName)"
                }
            }
        }
    }
}
if ($patched) { Write-Output "SUCCESS" } else { Write-Output "NOT_FOUND" }
`;

    try {
        fs.writeFileSync(psFile, psContent, 'utf8');
    } catch (e) {
        log(`[CDP] Failed to write patcher script: ${e.message}`);
        vscode.window.showWarningMessage('Could not create patcher script. Please add the flag manually.');
        return;
    }

    log('[CDP] Running shortcut patcher...');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (err, stdout, stderr) => {
        try { fs.unlinkSync(psFile); } catch (e) { }

        if (err) {
            log(`[CDP] Patcher error: ${err.message}`);
            vscode.window.showWarningMessage('Shortcut patching failed. Please add the flag manually.');
            return;
        }
        log(`[CDP] Patcher output: ${stdout.trim()}`);
        if (stdout.includes('SUCCESS')) {
            log('[CDP] ✓ Shortcut patched!');
            vscode.window.showInformationMessage(
                '✅ Shortcut updated! Restart Antigravity for the fix to take effect.',
                'OK'
            );
        } else {
            vscode.window.showWarningMessage(
                'No Antigravity/Cursor shortcut found. Add --remote-debugging-port=9222 to your shortcut manually.'
            );
        }
    });
}

function deactivate() {
    stopAutoAccept();
}

module.exports = {
    activate,
    deactivate
};
