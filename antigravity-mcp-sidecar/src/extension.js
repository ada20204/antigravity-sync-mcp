const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec, spawn } = require('child_process');
const net = require('net');
const { createHash } = require('crypto');
const { promisify } = require('util');
const { startAutoAccept, stopAutoAccept } = require('./auto-accept');
const {
    createNodeId,
    createStructuredLogger,
    createTraceId,
    LOG_RETENTION_MS,
} = require('./structured-log');
const {
    NonceCache,
    ensureBridgeToken,
    verifyControlRequest,
    DEFAULT_MAX_SKEW_MS,
} = require('./bridge-auth');

const REGISTRY_DIR = path.join(os.homedir(), '.config', 'antigravity-mcp');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');
const MCP_BIN_DIR = path.join(REGISTRY_DIR, 'bin');
const MCP_METADATA_FILE = path.join(REGISTRY_DIR, 'server-runtime.json');
const REGISTRY_SCHEMA_VERSION = 2;
const REGISTRY_COMPAT_SCHEMA_VERSIONS = [2];
const REGISTRY_CONTROL_KEY = '__control__';
const CONTROL_NO_CDP_PROMPT_KEY = 'cdp_prompt_requests';
const HOST_CONTROL_POLL_INTERVAL_MS = 2_500;
const QUOTA_POLL_INTERVAL_MS = 60_000;
const CDP_HEARTBEAT_INTERVAL_MS = 30_000;
const CDP_PROBE_TIMEOUT_MS = 250;
const CDP_MAX_HOSTS = 8;
const CDP_PROBE_SUMMARY_LIMIT = 40;
const DEFAULT_CDP_PORT_SPEC = '9000-9014';
const CDP_PORT_RANGE_MIN = 9000;
const CDP_PORT_RANGE_MAX = 9014;
const DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT = 15;
const DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT = 5;
const DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES = 30;
const CDP_HEARTBEAT_REPEAT_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const NO_CDP_PROMPT_REQUEST_TTL_MS = 5 * 60 * 1000;
const LOG_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const execAsync = promisify(exec);

function getBundledServerEntryPath(context) {
    return path.join(context.extensionPath, 'server-runtime', 'dist', 'index.js');
}

function getLauncherPaths() {
    const unixLauncher = path.join(MCP_BIN_DIR, 'antigravity-mcp-server');
    const windowsLauncher = path.join(MCP_BIN_DIR, 'antigravity-mcp-server.cmd');
    return { unixLauncher, windowsLauncher };
}

function ensureMcpLauncher(context) {
    const entryPath = getBundledServerEntryPath(context);
    if (!fs.existsSync(entryPath)) {
        return { ok: false, error: `Bundled server entry missing: ${entryPath}` };
    }
    if (!fs.existsSync(MCP_BIN_DIR)) {
        fs.mkdirSync(MCP_BIN_DIR, { recursive: true });
    }

    const { unixLauncher, windowsLauncher } = getLauncherPaths();
    const entryForShell = entryPath.replace(/"/g, '\\"');
    const unixScript = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `exec node "${entryForShell}" "$@"`,
        '',
    ].join('\n');
    fs.writeFileSync(unixLauncher, unixScript, { encoding: 'utf-8', mode: 0o755 });
    try {
        fs.chmodSync(unixLauncher, 0o755);
    } catch { }

    const entryForCmd = entryPath.replace(/"/g, '""');
    const cmdScript = [
        '@echo off',
        `node "${entryForCmd}" %*`,
        '',
    ].join('\r\n');
    fs.writeFileSync(windowsLauncher, cmdScript, 'utf-8');

    const metadata = {
        version: context.extension.packageJSON && context.extension.packageJSON.version
            ? String(context.extension.packageJSON.version)
            : 'unknown',
        extensionPath: context.extensionPath,
        bundledServer: entryPath,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MCP_METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    try {
        fs.chmodSync(MCP_METADATA_FILE, 0o600);
    } catch { }

    return {
        ok: true,
        entryPath,
        unixLauncher,
        windowsLauncher,
    };
}

function buildAiConfigPrompt(params) {
    const { launcherPath, entryPath, workspacePath } = params;
    const workspaceHint = workspacePath || '${workspaceFolder}';
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'node' : launcherPath;
    const args = isWindows
        ? [entryPath, '--target-dir', workspaceHint]
        : ['--target-dir', workspaceHint];
    const configJson = JSON.stringify(
        {
            mcpServers: {
                'antigravity-mcp': {
                    command: String(command || ''),
                    args: args.map((item) => String(item || '')),
                },
            },
        },
        null,
        2
    );
    return [
        '# Antigravity MCP Setup Prompt (for AI clients)',
        '',
        'Use the following MCP server config:',
        '',
        '```json',
        configJson,
        '```',
        '',
        isWindows
            ? 'Windows note: use `node + server-runtime/dist/index.js` to avoid extra cmd window popups.'
            : 'Unix note: use the generated launcher path under ~/.config/antigravity-mcp/bin.',
        '',
        'Recommended instruction to AI:',
        '- Prefer tool `ask-antigravity` for delegated coding tasks.',
        '- Pass `mode` as `fast` for quick loop and `plan` for deep tasks.',
        '- If response indicates `registry_not_ready`, ask user to open/restart Antigravity with sidecar enabled.',
    ].join('\n');
}

// ── Schema helpers ────────────────────────────────────────────────────────
function normalizePath(rawPath) {
    let p = String(rawPath || '').trim();
    if (!p) return '';
    // Resolve symlinks and relative segments — must match server-side normalizePathForId.
    try { p = fs.realpathSync(p); } catch { /* path may not exist locally; fall back to resolve */ }
    p = path.resolve(p);
    p = p.replace(/\\/g, '/');
    p = p.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
}

function computeWorkspaceId(rawPath) {
    const normalized = normalizePath(rawPath);
    return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function mapCdpStateToRegistryState(state) {
    switch (state) {
        case 'idle': return 'app_down';
        case 'launching': return 'launching';
        case 'probing': return 'app_up_cdp_not_ready';
        case 'app_up_no_cdp': return 'app_up_no_cdp';
        case 'app_down': return 'app_down';
        case 'ready': return 'ready';
        case 'error': return 'error';
        default: return 'app_down';
    }
}
// ──────────────────────────────────────────────────────────────────────────

function resolveRuntimeRole() {
    const forced = String(process.env.ANTIGRAVITY_SIDECAR_ROLE || '').trim().toLowerCase();
    if (forced === 'host' || forced === 'remote') return forced;
    // This extension is UI-kind and runs in the desktop host process.
    // Treat it as host by default; use ANTIGRAVITY_SIDECAR_ROLE=remote only
    // when an explicit remote-side deployment is configured.
    return 'host';
}

let outputChannel;
let structuredLogger;

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

function createErrorInfo(code, message, details) {
    return {
        code: String(code || 'unknown_error'),
        message: String(message || 'unknown error'),
        at: Date.now(),
        details: details && typeof details === 'object' ? details : undefined,
    };
}

function log(msg, fields) {
    if (!structuredLogger) {
        const time = new Date().toLocaleTimeString();
        const fullMsg = `[${time}] ${msg}`;
        console.log(fullMsg);
        if (outputChannel) outputChannel.appendLine(fullMsg);
        return;
    }
    structuredLogger.info(msg, fields);
}

function warn(msg, fields) {
    if (!structuredLogger) return log(msg, fields);
    structuredLogger.warn(msg, fields);
}

function errorLog(msg, fields) {
    if (!structuredLogger) return log(msg, fields);
    structuredLogger.error(msg, fields);
}

function getControlRecord(registry) {
    if (!registry || typeof registry !== 'object') return { restart_requests: {}, [CONTROL_NO_CDP_PROMPT_KEY]: {} };
    const raw = registry[REGISTRY_CONTROL_KEY];
    if (!raw || typeof raw !== 'object') return { restart_requests: {}, [CONTROL_NO_CDP_PROMPT_KEY]: {} };
    const control = raw;
    if (!control.restart_requests || typeof control.restart_requests !== 'object') {
        control.restart_requests = {};
    }
    if (!control[CONTROL_NO_CDP_PROMPT_KEY] || typeof control[CONTROL_NO_CDP_PROMPT_KEY] !== 'object') {
        control[CONTROL_NO_CDP_PROMPT_KEY] = {};
    }
    return control;
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

function isStrictCdpPortSpec(spec) {
    const parsed = parsePortCandidates(spec);
    if (parsed.length === 0) return false;
    return parsed.every((port) => port >= CDP_PORT_RANGE_MIN && port <= CDP_PORT_RANGE_MAX);
}

function trimProbeSummary(summary) {
    if (!Array.isArray(summary)) return [];
    if (summary.length <= CDP_PROBE_SUMMARY_LIMIT) return summary;
    // Keep first half + last half so early failures remain visible together
    // with the tail of the probe sequence.
    const half = Math.floor(CDP_PROBE_SUMMARY_LIMIT / 2);
    return [...summary.slice(0, half), ...summary.slice(summary.length - half)];
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

function previewTokens(values, limit = 3) {
    const list = Array.isArray(values) ? values : [];
    if (list.length === 0) return 'none';
    if (list.length <= limit) return list.join(',');
    return `${list.slice(0, limit).join(',')}...(+${list.length - limit})`;
}

function summarizeProbePlan(hosts, ports) {
    const hostList = Array.isArray(hosts) ? hosts : [];
    const portList = Array.isArray(ports) ? ports : [];
    return `hosts=${hostList.length}[${previewTokens(hostList, 3)}] ports=${portList.length}[${previewTokens(portList, 5)}]`;
}

function shortError(error) {
    const message = error && error.message ? error.message : String(error || 'unknown');
    return message.slice(0, 180);
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
    registry[REGISTRY_CONTROL_KEY] = getControlRecord(registry);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    try {
        fs.chmodSync(REGISTRY_FILE, 0o600);
    } catch { }
}

function extractArgValue(cmdline, name) {
    const flag = String(name || '').trim().replace(/[-_]/g, '[-_]');
    const re = new RegExp(`(?:--|-)${flag}(?:=|\\s+)(\"[^\"]+\"|'[^']+'|[^\\s]+)`, 'i');
    const match = String(cmdline || '').match(re);
    if (!match) return '';
    return String(match[1] || '').replace(/^["']|["']$/g, '');
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

async function probeLanguageServerEndpoint(host, port, csrfToken) {
    // Method availability varies across LS versions; try a small set.
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

async function detectLanguageServer() {
    try {
        if (process.platform === 'win32') {
            const processCmds = [
                'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'language_server_windows_x64.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
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
                    return line && (/--app[_-]data[_-]dir\\s+(antigravity|cursor)/i.test(line) || /[\\\\/](antigravity|cursor)[\\\\/]/i.test(line));
                }),
                ...items.filter((item) => {
                    const line = String(item.CommandLine || '');
                    return !(line && (/--app[_-]data[_-]dir\\s+(antigravity|cursor)/i.test(line) || /[\\\\/](antigravity|cursor)[\\\\/]/i.test(line)));
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
                        if (await probeLanguageServerEndpoint('127.0.0.1', port, csrfToken)) {
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
                if (await probeLanguageServerEndpoint('127.0.0.1', port, csrfToken)) {
                    return { pid, port, csrfToken };
                }
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
        : (minModelRemaining !== null ? minModelRemaining : promptRemaining);
    const primaryLabel = activeModelName
        ? `model ${activeModelName}`
        : (minModelRemaining !== null ? 'lowest model quota' : 'prompt credits');

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
    let lastErrorCode = 'cdp_not_found';

    for (const ip of hosts) {
        for (const port of ports) {
            let version = null;
            try {
                version = await getJson(`http://${ip}:${port}/json/version`, CDP_PROBE_TIMEOUT_MS);
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'version', ok: false, error: message });
                lastError = `${ip}:${port} version ${message}`;
                lastErrorCode = message.includes('timeout') ? 'cdp_version_timeout' : 'cdp_version_unreachable';
                continue;
            }

            if (looksLikeAntigravityVersion(version)) {
                summary.push({ host: ip, port, stage: 'version', ok: true, source: 'version' });
                return {
                    target: { ip, port, source: 'version', version },
                    summary: trimProbeSummary(summary),
                    lastError: '',
                    lastErrorCode: 'ok',
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
                        lastErrorCode: 'ok',
                    };
                }

                summary.push({ host: ip, port, stage: 'list', ok: false, error: 'no_page_target' });
                lastError = `${ip}:${port} list no_page_target`;
                lastErrorCode = 'cdp_list_no_page_target';
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'list', ok: false, error: message });
                lastError = `${ip}:${port} list ${message}`;
                lastErrorCode = message.includes('timeout') ? 'cdp_list_timeout' : 'cdp_list_unreachable';
            }
        }
    }

    return {
        target: null,
        summary: trimProbeSummary(summary),
        lastError: lastError || 'no_cdp_target',
        lastErrorCode,
    };
}

async function isAntigravityProcessRunning() {
    try {
        if (process.platform === 'win32') {
            const cmd = 'powershell -NoProfile -Command "(Get-Process Antigravity,Cursor -ErrorAction SilentlyContinue | Measure-Object).Count"';
            const { stdout } = await execAsync(cmd);
            return Number(String(stdout || '').trim()) > 0;
        }
        const { stdout } = await execAsync('pgrep -af "Antigravity|Cursor"');
        return String(stdout || '').trim().length > 0;
    } catch {
        return false;
    }
}

function buildCdpProbePlan(params) {
    const { workspacePath, fixedHost, fixedPort, portSpec } = params;
    // The sidecar should probe loopback by default to avoid stale or unrelated
    // network-interface addresses that only add timeout cost.
    // and stale registry IPs from other workspaces — they only cause timeouts.
    const baseHosts = ['127.0.0.1', 'localhost'];
    if (fixedHost && String(fixedHost).trim()) baseHosts.unshift(String(fixedHost).trim());
    // Allow explicit multi-host override via env var for unusual remote setups.
    const envHosts = []
        .concat(String(process.env.ANTIGRAVITY_CDP_HOSTS || '').split(','))
        .concat(String(process.env.ANTIGRAVITY_CDP_HOST || '').split(','))
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    baseHosts.push(...envHosts);
    const allHosts = dedupeStrings(baseHosts);
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

/**
 * Scan registry for occupied CDP ports and return the lowest available port.
 * Returns null when no port is available in range.
 * @param {object} registry - registry object (may be null/undefined)
 * @param {[number, number]} portRange - [lo, hi] inclusive
 * @param {{ preferredPort?: number, unavailablePorts?: Set<number> }} options
 * @returns {number|null} allocated port
 */
function allocateFreeCdpPort(registry, portRange, options = {}) {
    const lo = portRange ? portRange[0] : 9000;
    const hi = portRange ? portRange[1] : 9014;
    const preferred = Number(options.preferredPort);
    const occupied = collectRegistryOccupiedPorts(registry);
    const unavailable = options.unavailablePorts instanceof Set
        ? options.unavailablePorts
        : new Set();
    for (const p of unavailable) {
        occupied.add(Number(p));
    }

    const ordered = buildPortCandidateOrder([lo, hi], preferred);
    for (const port of ordered) {
        if (!occupied.has(port)) return port;
    }
    return null;
}

function collectRegistryOccupiedPorts(registry) {
    const occupied = new Set();
    try {
        for (const [key, entry] of Object.entries(registry || {})) {
            if (key.startsWith('__')) continue;
            const port = entry && entry.local_endpoint && Number(entry.local_endpoint.port);
            if (Number.isFinite(port) && port > 0) occupied.add(port);
        }
    } catch (_) {
        // Ignore malformed registry payloads.
    }
    return occupied;
}

function buildPortCandidateOrder(portRange, preferredPort) {
    const lo = portRange ? Number(portRange[0]) : 9000;
    const hi = portRange ? Number(portRange[1]) : 9014;
    const ordered = [];
    const preferred = Number(preferredPort);
    if (Number.isFinite(preferred) && preferred >= lo && preferred <= hi) {
        ordered.push(preferred);
    }
    for (let port = lo; port <= hi; port++) {
        if (port === preferred) continue;
        ordered.push(port);
    }
    return ordered;
}

async function isTcpPortAvailable(host, port, timeoutMs = 600) {
    return await new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                server.close(() => resolve(ok));
            } catch (_) {
                resolve(ok);
            }
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        server.on('error', () => finish(false));
        server.listen({ host, port, exclusive: true }, () => finish(true));
    });
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

    if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
            '/Applications/Antigravity.app/Contents/MacOS/Electron',
            '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
            '/Applications/Cursor.app/Contents/MacOS/Cursor',
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    const candidates = [
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/usr/bin/cursor',
        '/usr/local/bin/cursor',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

function psQuote(value) {
    return String(value || '').replace(/'/g, "''");
}

function resolveCdpBindAddress() {
    const override = String(process.env.ANTIGRAVITY_CDP_BIND_ADDRESS || '').trim();
    return override || '127.0.0.1';
}

function buildLaunchArgsForWorkspace(workspacePath, port, extraArgs) {
    return [
        workspacePath,
        '--new-window',
        `--remote-debugging-port=${port}`,
        `--remote-debugging-address=${resolveCdpBindAddress()}`,
        ...extraArgs,
    ];
}

function launchAntigravityDetached(params) {
    const { executable, args, restart } = params;
    if (process.platform === 'win32') {
        const exe = psQuote(executable);
        const argList = args.map((item) => `'${psQuote(item)}'`).join(',');
        const script = restart
            ? `$ErrorActionPreference='SilentlyContinue'; Get-Process Antigravity,Cursor | Stop-Process -Force; $deadline=(Get-Date).AddSeconds(8); while((Get-Date)-lt $deadline){if(-not(Get-Process Antigravity,Cursor -EA SilentlyContinue)){break};Start-Sleep -Milliseconds 200}; Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`
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
    const runtimeRole = resolveRuntimeRole();
    const nodeId = createNodeId(runtimeRole);
    const remoteName = String((vscode.env && vscode.env.remoteName) || '').trim();
    let workspaceId = '';
    structuredLogger = createStructuredLogger({
        baseDir: REGISTRY_DIR,
        outputChannel,
        role: runtimeRole,
        nodeId,
        getWorkspaceId: () => workspaceId,
    });
    log('Extension activating...', {
        plane: 'ctrl',
        state: 'activating',
        extra: {
            role: runtimeRole,
            remote_name: remoteName || 'local',
            node_id: nodeId,
            log_retention_days: LOG_RETENTION_MS / (24 * 60 * 60 * 1000),
        },
    });
    const launcherResult = ensureMcpLauncher(context);
    if (launcherResult.ok) {
        log(`Bundled MCP launcher ready: ${launcherResult.unixLauncher}`, {
            plane: 'ctrl',
            state: 'ready',
            extra: {
                bundled_server: launcherResult.entryPath,
                windows_launcher: launcherResult.windowsLauncher,
            },
        });
    } else {
        warn(`Bundled MCP launcher unavailable: ${launcherResult.error}`, {
            plane: 'ctrl',
            error_code: 'bundled_server_missing',
        });
    }

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
    let lastHeartbeatFailureSignature = '';
    let lastHeartbeatFailureLogAt = 0;
    let launchTimeoutHandle = null;
    const LAUNCH_TIMEOUT_MS = 60_000;
    let cdpFixedHost = '';
    let cdpFixedPort = 0;
    let cdpPortSpec = DEFAULT_CDP_PORT_SPEC;
    let antigravityExecutablePath = '';
    let antigravityLaunchExtraArgs = [];
    let antigravityLaunchPort = 9000;
    let cdpProbeHosts = [];
    let cdpProbePorts = [];
    let register = () => { };
    let negotiateCdp = async (_options = {}) => false;
    let workspacePath = '';
    let workspaceName = '';
    let bridgeToken = '';
    let bridgeMaxSkewMs = DEFAULT_MAX_SKEW_MS;
    let bridgeRequestTtlMs = 5 * 60 * 1000;
    let lastSyncStateLogKey = '';
    const nonceCache = new NonceCache();
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
        const configuredPortSpec = String(config.get('cdpPortCandidates', DEFAULT_CDP_PORT_SPEC) || '').trim();
        cdpPortSpec = isStrictCdpPortSpec(configuredPortSpec)
            ? configuredPortSpec
            : DEFAULT_CDP_PORT_SPEC;
        const configuredExe = String(config.get('antigravityExecutablePath', '') || '').trim();
        antigravityExecutablePath = configuredExe || resolveDefaultExecutablePath();
        antigravityLaunchExtraArgs = splitArgs(config.get('antigravityLaunchExtraArgs', ''));
        antigravityLaunchPort = clampNumber(config.get('antigravityLaunchPort', 9000), 1, 65535);
        bridgeToken = ensureBridgeToken(
            REGISTRY_DIR,
            String(config.get('bridgeSharedToken', '') || '').trim()
        );
        bridgeMaxSkewMs = clampNumber(
            config.get('bridgeMaxSkewMs', DEFAULT_MAX_SKEW_MS),
            5_000,
            10 * 60 * 1000
        );
        bridgeRequestTtlMs = clampNumber(
            config.get('bridgeRequestTtlMs', 5 * 60 * 1000),
            30_000,
            30 * 60 * 1000
        );
    }

    reloadCdpConfig();
    const logRetentionTimer = setInterval(() => {
        try {
            structuredLogger.cleanupOldLogs();
        } catch { }
    }, LOG_RETENTION_SWEEP_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(logRetentionTimer) });

    // Periodically prune expired nonces so the NonceCache doesn't grow unboundedly.
    const noncePruneTimer = setInterval(() => {
        try { nonceCache.prune(); } catch { }
    }, 5 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(noncePruneTimer) });

    function getQuotaLevel(summary) {
        if (!summary) return { level: 'none', watchedPercent: null, target: 'quota' };

        if (summary.activeModelRemaining !== null) {
            const percent = summary.activeModelRemaining;
            const target = summary.activeModelName ? `model ${summary.activeModelName}` : 'active model';
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
        if (summary.promptRemaining !== null) {
            const percent = summary.promptRemaining;
            const target = 'prompt credits';
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
        // No popup alerts for quota; keep logs/status bar only.
        log(`Quota alert (${level}): ${message}`);
        lastQuotaAlertLevel = level;
        lastQuotaAlertAt = now;
    }

    function syncState() {
        let nextLogKey = '';
        if (isEnabled && cdpTarget) {
            const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
            startAutoAccept(cdpTarget.port, log, config.get('nativePollInterval', 500), config.get('cdpPollInterval', 1500), cdpTarget.ip);
            nextLogKey = `running:${cdpTarget.ip}:${cdpTarget.port}`;
            if (nextLogKey !== lastSyncStateLogKey) {
                log(`Auto-accept loops running on ${cdpTarget.ip}:${cdpTarget.port}`);
            }
        } else {
            stopAutoAccept();
            if (!cdpTarget) {
                nextLogKey = 'paused:no_cdp';
                if (nextLogKey !== lastSyncStateLogKey) {
                    log('Auto-accept unavailable: no CDP debug port found');
                }
            } else {
                nextLogKey = 'paused:disabled';
                if (nextLogKey !== lastSyncStateLogKey) {
                    log('Auto-accept paused');
                }
            }
        }
        lastSyncStateLogKey = nextLogKey;
        updateStatusBar();
    }

    async function executeManualLaunch(action, options = {}) {
        const trigger = options.trigger || 'local';
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

        const registry = readRegistryObject() || {};
        const bindAddress = resolveCdpBindAddress();
        let allocatedPort = null;

        if (cdpFixedPort > 0) {
            const fixedAvailable = await isTcpPortAvailable(bindAddress, cdpFixedPort);
            if (!fixedAvailable) {
                const message = `Configured CDP fixed port ${cdpFixedPort} is unavailable on ${bindAddress}.`;
                cdpLastError = createErrorInfo('cdp_fixed_port_unavailable', message, {
                    bind_address: bindAddress,
                    fixed_port: cdpFixedPort,
                });
                register();
                vscode.window.showWarningMessage(`${message} Please choose another fixed port.`);
                return;
            }
            allocatedPort = cdpFixedPort;
        } else {
            const unavailable = new Set();
            while (true) {
                const nextPort = allocateFreeCdpPort(registry, [9000, 9014], {
                    preferredPort: antigravityLaunchPort,
                    unavailablePorts: unavailable,
                });
                if (!Number.isFinite(nextPort) || nextPort <= 0) break;
                const available = await isTcpPortAvailable(bindAddress, nextPort);
                if (available) {
                    allocatedPort = nextPort;
                    break;
                }
                unavailable.add(nextPort);
            }
            if (!Number.isFinite(allocatedPort) || allocatedPort <= 0) {
                const message = `No available CDP port in range 9000-9014 on ${bindAddress}.`;
                cdpLastError = createErrorInfo('cdp_port_exhausted', message, {
                    bind_address: bindAddress,
                    preferred_port: antigravityLaunchPort,
                });
                register();
                vscode.window.showErrorMessage(`${message} Close old Antigravity windows or set a fixed CDP port.`);
                return;
            }
        }
        const launchArgs = buildLaunchArgsForWorkspace(workspacePath, allocatedPort, antigravityLaunchExtraArgs);
        try {
            launchAntigravityDetached({
                executable: antigravityExecutablePath,
                args: launchArgs,
                restart: action === 'restart',
            });
            log(
                `${action === 'restart' ? 'Restarting' : 'Launching'} Antigravity with port=${allocatedPort} workspace=${workspacePath}`,
                {
                    plane: 'ctrl',
                    state: 'launching',
                    extra: { action, trigger, allocated_port: allocatedPort },
                }
            );
        } catch (error) {
            const message = shortError(error);
            vscode.window.showErrorMessage(`Failed to ${action} Antigravity: ${message}`);
            cdpLastError = createErrorInfo('launch_failed', message, { action, trigger });
            register();
            return;
        }

        // Transition to 'launching' — prevents duplicate remote launch requests.
        // Auto-expires to 'idle' (app_down) if process never appears within LAUNCH_TIMEOUT_MS.
        if (launchTimeoutHandle) clearTimeout(launchTimeoutHandle);
        cdpState = 'launching';
        cdpLastError = null;
        cdpSource = action === 'restart' ? 'manual-restart' : 'manual-launch';
        register();
        launchTimeoutHandle = setTimeout(() => {
            launchTimeoutHandle = null;
            if (cdpState === 'launching') {
                cdpState = 'app_down';
                cdpLastError = createErrorInfo(
                    'launch_timeout',
                    'Antigravity did not appear after launch request within timeout window'
                );
                register();
                log('Launch timeout: no process appeared within timeout, reverting to app_down');
            }
        }, LAUNCH_TIMEOUT_MS);

        // Give new process a short head start before probing.
        await new Promise((resolve) => setTimeout(resolve, action === 'restart' ? 1500 : 800));
        const ok = await negotiateCdp();
        if (launchTimeoutHandle) { clearTimeout(launchTimeoutHandle); launchTimeoutHandle = null; }
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

    async function requestHostRestart(params = {}) {
        const reason = String(params.reason || 'remote_request').slice(0, 200);
        if (runtimeRole !== 'remote') {
            warn('Host restart request ignored: sidecar is not in remote mode', {
                plane: 'ctrl',
                error_code: 'remote_request_not_supported',
            });
            return false;
        }
        warn('Host restart bridge is not configured in this build; request cannot be forwarded automatically', {
            plane: 'ctrl',
            error_code: 'remote_restart_bridge_unavailable',
            extra: { reason },
        });
        vscode.window.showInformationMessage(
            'Remote host restart bridge is not configured. Restart Antigravity on host manually with CDP flags.'
        );
        return false;
    }

    async function showNoCdpPromptFromServer(request = {}) {
        const platform = process.platform;
        const state = String(request.state || cdpState || 'unknown');
        const code = String(request.reason_code || (cdpLastError && cdpLastError.code) || 'cdp_not_ready');
        const bindAddress = resolveCdpBindAddress();
        const baseMessage =
            `MCP requested CDP but it is unavailable (state=${state}, code=${code}). ` +
            `Launch Antigravity with --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`;
        const actions = ['How to Fix'];
        if (platform === 'win32') actions.unshift('Auto-Fix Shortcut (Windows)');

        const action = await vscode.window.showWarningMessage(baseMessage, ...actions);
        if (action === 'How to Fix') {
            const guide = platform === 'linux'
                ? (runtimeRole === 'remote'
                    ? `Remote sidecar cannot cold-start host app. Open Antigravity on host with --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`
                    : `Launch Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}, then retry MCP request.`)
                : platform === 'darwin'
                    ? `Open Terminal and run: open -a "Antigravity" --args --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}`
                    : `Restart Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`;
            await vscode.window.showInformationMessage(guide, { modal: true });
        } else if (action === 'Auto-Fix Shortcut (Windows)') {
            autoFixWindowsShortcut();
        }
        return action || '';
    }

    function rejectControlRequest(registry, request, code, message) {
        const control = getControlRecord(registry);
        const current = control.restart_requests[request.id];
        if (!current) return;
        control.restart_requests[request.id] = {
            ...current,
            status: 'rejected',
            handled_at: Date.now(),
            handled_by: nodeId,
            error: { code, message },
            updated_at: Date.now(),
        };
        registry[REGISTRY_CONTROL_KEY] = control;
    }

    let controlRequestHandling = false;
    async function processHostControlRequests() {
        if (controlRequestHandling) return;
        controlRequestHandling = true;
        try {
            const registry = readRegistryObject();
            const control = getControlRecord(registry);
            let changed = false;

            const promptRequests = Object.values(control[CONTROL_NO_CDP_PROMPT_KEY] || {})
                .filter((item) => item && item.status === 'pending')
                .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
            for (const request of promptRequests) {
                if (request.workspace_id && request.workspace_id !== workspaceId) continue;
                const ageMs = Date.now() - Number(request.updated_at || request.created_at || 0);
                if (ageMs > NO_CDP_PROMPT_REQUEST_TTL_MS) {
                    const current = control[CONTROL_NO_CDP_PROMPT_KEY][request.id];
                    if (current) {
                        control[CONTROL_NO_CDP_PROMPT_KEY][request.id] = {
                            ...current,
                            status: 'expired',
                            updated_at: Date.now(),
                        };
                        changed = true;
                    }
                    continue;
                }
                const selectedAction = await showNoCdpPromptFromServer(request);
                const current = control[CONTROL_NO_CDP_PROMPT_KEY][request.id];
                if (current) {
                    control[CONTROL_NO_CDP_PROMPT_KEY][request.id] = {
                        ...current,
                        status: 'shown',
                        action: selectedAction || undefined,
                        shown_at: Date.now(),
                        handled_by: nodeId,
                        updated_at: Date.now(),
                    };
                    changed = true;
                }
                break;
            }

            if (runtimeRole !== 'host') {
                if (changed) {
                    registry[REGISTRY_CONTROL_KEY] = control;
                    writeRegistryObject(registry);
                }
                return;
            }

            const requests = Object.values(control.restart_requests || {})
                .filter((item) => item && item.status === 'pending')
                .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));

            for (const request of requests) {
                if (request.workspace_id !== workspaceId) continue;
                if (request.to_node_id && request.to_node_id !== nodeId) continue;

                const ageMs = Date.now() - Number(request.created_at || request.ts || 0);
                if (ageMs > bridgeRequestTtlMs) {
                    rejectControlRequest(registry, request, 'request_expired', 'control request exceeded ttl');
                    changed = true;
                    continue;
                }

                const verified = verifyControlRequest(request, bridgeToken, {
                    maxSkewMs: bridgeMaxSkewMs,
                    nonceCache,
                });
                if (!verified.ok) {
                    rejectControlRequest(registry, request, verified.code, verified.message);
                    changed = true;
                    continue;
                }

                const decision = await vscode.window.showWarningMessage(
                    `Remote sidecar requested restart for workspace ${workspacePath}. Restart Antigravity now?`,
                    { modal: true },
                    'Restart',
                    'Reject'
                );
                // Re-read registry after the blocking modal — other processes may have
                // written changes while we waited.  Using the stale pre-modal object
                // would overwrite those changes.
                const liveRegistry = readRegistryObject() || registry;
                const controlRef = getControlRecord(liveRegistry);
                const current = controlRef.restart_requests[request.id];
                if (!current) continue;

                if (decision !== 'Restart') {
                    controlRef.restart_requests[request.id] = {
                        ...current,
                        status: 'rejected',
                        handled_at: Date.now(),
                        handled_by: nodeId,
                        error: { code: 'restart_rejected', message: 'user rejected host restart request' },
                        updated_at: Date.now(),
                    };
                    liveRegistry[REGISTRY_CONTROL_KEY] = controlRef;
                    writeRegistryObject(liveRegistry);
                    continue;
                }

                controlRef.restart_requests[request.id] = {
                    ...current,
                    status: 'approved',
                    handled_at: Date.now(),
                    handled_by: nodeId,
                    updated_at: Date.now(),
                };
                liveRegistry[REGISTRY_CONTROL_KEY] = controlRef;
                writeRegistryObject(liveRegistry);
                await executeManualLaunch('restart', { trigger: 'remote-request' });

                const registryAfter = readRegistryObject();
                const controlAfter = getControlRecord(registryAfter);
                const currentAfter = controlAfter.restart_requests[request.id];
                if (currentAfter) {
                    controlAfter.restart_requests[request.id] = {
                        ...currentAfter,
                        status: cdpState === 'ready' ? 'applied' : 'error',
                        handled_at: Date.now(),
                        handled_by: nodeId,
                        error: cdpState === 'ready' ? undefined : { code: 'restart_failed', message: 'CDP not ready after restart' },
                        updated_at: Date.now(),
                    };
                    registryAfter[REGISTRY_CONTROL_KEY] = controlAfter;
                    writeRegistryObject(registryAfter);
                }
            }

            if (changed) {
                registry[REGISTRY_CONTROL_KEY] = control;
                writeRegistryObject(registry);
            }
        } catch (err) {
            warn(`Host control request processor failed: ${shortError(err)}`, {
                plane: 'ctrl',
                error_code: 'control_request_processor_failed',
            });
        } finally {
            controlRequestHandling = false;
        }
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
        if (runtimeRole === 'remote') {
            vscode.window.showInformationMessage('Remote sidecar cannot cold-start host app. Please launch Antigravity on host.');
            return;
        }
        await executeManualLaunch('launch');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.installBundledServer', async () => {
        const result = ensureMcpLauncher(context);
        if (!result.ok) {
            vscode.window.showErrorMessage(`Bundled server install failed: ${result.error}`);
            return;
        }
        const launcher = process.platform === 'win32' ? result.windowsLauncher : result.unixLauncher;
        const prompt = buildAiConfigPrompt({
            launcherPath: launcher,
            entryPath: result.entryPath,
            workspacePath,
        });
        outputChannel.show(true);
        outputChannel.appendLine('=== Antigravity MCP Bundled Server ===');
        outputChannel.appendLine(`entry: ${result.entryPath}`);
        outputChannel.appendLine(`launcher(unix): ${result.unixLauncher}`);
        outputChannel.appendLine(`launcher(win): ${result.windowsLauncher}`);
        outputChannel.appendLine('');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(`Bundled MCP server ready. AI config prompt copied to clipboard. Launcher: ${launcher}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showAiConfigPrompt', async () => {
        const { unixLauncher, windowsLauncher } = getLauncherPaths();
        const launcher = process.platform === 'win32' ? windowsLauncher : unixLauncher;
        const prompt = buildAiConfigPrompt({
            launcherPath: launcher,
            entryPath: getBundledServerEntryPath(context),
            workspacePath,
        });
        outputChannel.show(true);
        outputChannel.appendLine('=== Antigravity MCP AI Config Prompt ===');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('AI config prompt copied to clipboard and written to output.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.requestHostRestart', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Submit host restart request now? This requires a configured host-bridge transport.',
            { modal: true },
            'Submit'
        );
        if (confirm !== 'Submit') return;
        await requestHostRestart({ reason: 'manual_command' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.restartAntigravity', async () => {
        if (runtimeRole === 'remote') {
            const confirm = await vscode.window.showWarningMessage(
                'Request host restart now? This requires a configured host-bridge transport.',
                { modal: true },
                'Request Restart'
            );
            if (confirm !== 'Request Restart') return;
            await requestHostRestart({ reason: 'restart_command' });
            return;
        }
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
            log(`Quota snapshot unavailable: ${latestQuotaError}`);
            return;
        }
        const summary = summarizeQuota(latestQuota);
        if (summary && summary.primaryPercent !== null) {
            log(`Quota: ${summary.primaryPercent.toFixed(1)}% remaining (${summary.primaryLabel})`);
        } else {
            log('Quota snapshot written to output channel.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showQuotaTable', async () => {
        const models = Array.isArray(latestQuota && latestQuota.models) ? latestQuota.models : [];
        outputChannel.show(true);
        if (models.length === 0) {
            outputChannel.appendLine('No model quota snapshot available yet.');
            log('No model quota snapshot available yet.');
            return;
        }

        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || ''))
        );
        outputChannel.appendLine('=== Antigravity Model Quota ===');
        for (const model of sorted) {
            const id = model.modelId || model.label || 'unknown';
            const remaining = typeof model.remainingPercentage === 'number'
                ? `${model.remainingPercentage.toFixed(1)}%`
                : 'n/a';
            const selectedMark = model.isSelected ? ' [active]' : '';
            outputChannel.appendLine(`${id}${selectedMark}: remaining=${remaining} exhausted=${model.isExhausted ? 'yes' : 'no'}${model.resetTime ? ` reset=${model.resetTime}` : ''}`);
        }
        log(`Quota table written to output channel (${sorted.length} models).`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.refreshQuota', async () => {
        try {
            await refreshQuota();
            const summary = summarizeQuota(latestQuota);
            if (summary && summary.primaryPercent !== null) {
                log(`Quota refreshed: ${summary.primaryPercent.toFixed(1)}% (${summary.primaryLabel})`);
            } else {
                log('Quota refreshed.');
            }
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            log(`Quota refresh failed: ${message}`);
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
    workspaceId = computeWorkspaceId(workspacePath);
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

        const now = Date.now();
        const v1State = mapCdpStateToRegistryState(cdpState);
        const endpointHost = activeHost || '127.0.0.1';
        const endpointPort = activePort || 9000;

        registry[workspacePath] = {
            ...previous,
            schema_version: REGISTRY_SCHEMA_VERSION,
            protocol: {
                schema_version: REGISTRY_SCHEMA_VERSION,
                compatible_schema_versions: REGISTRY_COMPAT_SCHEMA_VERSIONS,
                writer_role: runtimeRole,
                writer_node_id: nodeId,
                updated_at: now,
            },
            workspace_id: workspaceId || computeWorkspaceId(workspacePath),
            workspace_paths: {
                normalized: normalizePath(workspacePath),
                raw: workspacePath,
            },
            node_id: nodeId,
            role: runtimeRole,
            source_of_truth: runtimeRole === 'host' ? 'host' : 'remote',
            source_endpoint: { host: endpointHost, port: endpointPort },
            local_endpoint: {
                host: endpointHost,
                port: endpointPort,
                mode: runtimeRole === 'host' ? 'direct' : 'forwarded',
            },
            state: v1State,
            verified_at: cdpVerifiedAt || previous.verified_at,
            ttl_ms: 90000,
            priority: runtimeRole === 'host' ? 100 : 80,
            quota_meta: {
                source: runtimeRole === 'host' ? 'host' : 'remote',
                stale: false,
                refreshed_at: now,
                refresh_interval_ms: QUOTA_POLL_INTERVAL_MS,
            },
            last_error: cdpLastError || undefined,
            port: cdpTarget ? cdpTarget.port : previous.port,
            ip: cdpTarget ? cdpTarget.ip : previous.ip,
            pid: process.pid,
            lastActive: now,
            ls: latestLs || previous.ls,
            quota: latestQuota || previous.quota,
            quotaError: latestQuotaError,
            cdp: {
                ...previousCdp,
                generation: cdpGeneration,
                state: cdpState,
                updatedAt: now,
                verifiedAt: cdpVerifiedAt || previousCdp.verifiedAt,
                active: (activeHost && activePort)
                    ? {
                        host: activeHost,
                        port: activePort,
                        source: cdpSource || (previousCdp.active && previousCdp.active.source) || 'registry',
                        verifiedAt: cdpVerifiedAt || (previousCdp.active && previousCdp.active.verifiedAt) || now,
                    }
                    : undefined,
                candidates: buildCandidateMatrix(cdpProbeHosts, cdpProbePorts),
                probeSummary: trimProbeSummary(cdpProbeSummary),
                lastError: cdpLastError ? `${cdpLastError.code}:${cdpLastError.message}` : undefined,
            },
        };

        registry[REGISTRY_CONTROL_KEY] = getControlRecord(registry);
        writeRegistryObject(registry);
    };

    negotiateCdp = async (options = {}) => {
        const phase = String((options && options.phase) || 'runtime');
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

        if (phase !== 'startup' && phase !== 'heartbeat-retry') {
            log(`CDP probe started (${summarizeProbePlan(cdpProbeHosts, cdpProbePorts)})`, {
                plane: 'data',
                state: 'probing',
            });
        }
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
            lastHeartbeatFailureSignature = '';
            lastHeartbeatFailureLogAt = 0;
            register();
            log(`Registered workspace ${workspacePath} with CDP target ${cdpTarget.ip}:${cdpTarget.port} (source=${cdpSource})`, {
                plane: 'data',
                state: 'ready',
            });
            return true;
        }

        cdpTarget = null;
        const appRunning = await isAntigravityProcessRunning();
        if (result.lastErrorCode === 'cdp_list_no_page_target') {
            cdpState = 'probing';
        } else if (appRunning) {
            cdpState = 'app_up_no_cdp';
        } else {
            cdpState = 'app_down';
        }
        cdpLastError = createErrorInfo(
            result.lastErrorCode || 'cdp_not_found',
            result.lastError || 'no_cdp_target',
            {
                hosts: cdpProbeHosts,
                ports: cdpProbePorts.slice(0, 16),
                app_running: appRunning,
            }
        );
        register();
        if (phase !== 'startup') {
            const failureSignature = `${cdpState}|${cdpLastError.code}|${cdpLastError.message}`;
            const now = Date.now();
            const shouldLogHeartbeatFailure = phase !== 'heartbeat-retry'
                || failureSignature !== lastHeartbeatFailureSignature
                || (now - lastHeartbeatFailureLogAt) >= CDP_HEARTBEAT_REPEAT_LOG_COOLDOWN_MS;
            if (shouldLogHeartbeatFailure) {
                errorLog(
                    `CDP probe failed (${cdpLastError.code}): state=${cdpState} workspace=${workspacePath} last=${cdpLastError.message}`,
                    {
                        plane: 'data',
                        state: mapCdpStateToRegistryState(cdpState),
                        error_code: cdpLastError.code,
                        extra: {
                            probe: summarizeProbePlan(cdpProbeHosts, cdpProbePorts),
                        },
                    }
                );
                lastHeartbeatFailureSignature = failureSignature;
                lastHeartbeatFailureLogAt = now;
            }
        }
        return false;
    };

    await processHostControlRequests();
    const controlTimer = setInterval(() => {
        processHostControlRequests().catch((err) => {
            warn(`Control loop error: ${shortError(err)}`, {
                plane: 'ctrl',
                error_code: 'control_loop_error',
            });
        });
    }, HOST_CONTROL_POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(controlTimer) });

    // Heartbeat runs even when initial CDP probe fails so it can auto-recover.
    const heartbeatRetry = async () => {
        if (cdpHeartbeatRunning) return;
        if (cdpState !== 'app_up_no_cdp' && cdpState !== 'app_up_cdp_not_ready' && cdpState !== 'app_down') return;
        cdpHeartbeatRunning = true;
        try {
            // If process is down and we have an executable, attempt auto-relaunch.
            if (cdpState === 'app_down' && antigravityExecutablePath && fs.existsSync(antigravityExecutablePath)) {
                log('CDP heartbeat: process down, attempting auto-relaunch with CDP args', {
                    plane: 'ctrl',
                    state: 'launching',
                });
                await executeManualLaunch('launch', { trigger: 'heartbeat-auto-relaunch' });
                return;
            }
            const recovered = await negotiateCdp({ phase: 'heartbeat-retry' });
            if (recovered) {
                log(`CDP auto-recovered via heartbeat retry (${cdpTarget.ip}:${cdpTarget.port})`);
                updateStatusBar();
                updateQuotaStatusBar();
                // One-time quota fetch since we missed normal init.
                fetchQuotaSnapshot().then((result) => {
                    latestLs = result.ls || latestLs;
                    latestQuota = result.quota || latestQuota;
                    latestQuotaError = result.error;
                    register();
                    updateQuotaStatusBar();
                    maybeNotifyLowQuota();
                }).catch(() => { });
            }
        } finally {
            cdpHeartbeatRunning = false;
        }
    };

    const cdpRetryTimer = setInterval(() => {
        if (!cdpTarget) heartbeatRetry().catch(() => { });
    }, CDP_HEARTBEAT_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(cdpRetryTimer) });

    if (!(await negotiateCdp({ phase: 'startup' }))) {
        updateStatusBar();
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
            cdpLastError = createErrorInfo('cdp_heartbeat_error', `heartbeat ${shortError(error)}`);
            register();
            const recovered = await negotiateCdp();
            if (!recovered) {
                cdpTarget = null;
                errorLog(`CDP heartbeat recovery failed: ${cdpLastError ? `${cdpLastError.code}:${cdpLastError.message}` : 'unknown'}`, {
                    plane: 'data',
                    state: mapCdpStateToRegistryState(cdpState),
                    error_code: cdpLastError ? cdpLastError.code : 'cdp_heartbeat_error',
                });
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
                        writeRegistryObject(registry);
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
$flag = "--remote-debugging-port=9000"
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
                'No Antigravity/Cursor shortcut found. Add --remote-debugging-port=9000 to your shortcut manually.'
            );
        }
    });
}

function deactivate() {
    stopAutoAccept();
}

module.exports = {
    activate,
    deactivate,
    // Exported for unit testing only
    _testExports: {
        allocateFreeCdpPort,
        parsePortCandidates,
        isStrictCdpPortSpec,
        buildPortCandidateOrder,
        collectRegistryOccupiedPorts,
    },
};
