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

function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1000 }, (res) => {
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

function getHostIps() {
    const ips = ['127.0.0.1'];
    // In WSL, Windows host is often nameserver in resolv.conf
    try {
        if (fs.existsSync('/etc/resolv.conf')) {
            const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
            const match = resolv.match(/^nameserver\s+([\d.]+)/m);
            if (match && match[1]) ips.push(match[1]);
        }
    } catch { }
    return ips;
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

async function findCdpTarget(workspaceName) {
    // Standard Chromium/Electron debug ports + Antigravity common ranges
    const PORTS = [
        9222, 9229,                                              // standard --remote-debugging-port defaults
        ...Array.from({ length: 15 }, (_, i) => 9000 + i),      // 9000-9014 (Antigravity common)
        ...Array.from({ length: 7 }, (_, i) => 8997 + i),       // 8997-9003
        ...Array.from({ length: 51 }, (_, i) => 7800 + i),      // 7800-7850
    ];

    const ips = getHostIps();

    for (const ip of ips) {
        for (const port of PORTS) {
            try {
                const list = await getJson(`http://${ip}:${port}/json/list`);

                const workbench = list.find((t) =>
                    t.url && t.url.includes('workbench.html') &&
                    t.type === 'page' &&
                    !(t.url && t.url.includes('jetski'))
                );

                if (workbench) {
                    if (!workspaceName || workbench.title.includes(workspaceName)) {
                        return { port, ip };
                    }
                }
            } catch {
                // Ignore
            }
        }
    }

    return null;
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
            isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
            reloadQuotaUiConfig();
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

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const workspaceName = vscode.workspace.name || "";

    cdpTarget = await findCdpTarget(workspaceName);
    if (!cdpTarget) {
        log(`Error: Could not find CDP port for workspace: ${workspacePath}`);
        updateStatusBar();

        // ─── CDP Auto-Fix Prompt ──────────────────────────────────────
        const platform = process.platform;
        const actions = ['How to Fix'];
        if (platform === 'win32') actions.unshift('Auto-Fix Shortcut (Windows)');

        vscode.window.showErrorMessage(
            '⚡ Sidecar: No CDP debug port found. Antigravity must be launched with --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 for auto-accept to work natively and in WSL.',
            ...actions
        ).then(action => {
            if (action === 'How to Fix') {
                const guide = platform === 'linux'
                    ? 'Find your Antigravity .desktop file (usually in ~/.local/share/applications/) or launch command and append: --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0. Then restart.'
                    : platform === 'darwin'
                        ? 'Open Terminal and run: open -a "Antigravity" --args --remote-debugging-port=9222'
                        : 'Right-click your Antigravity shortcut → Properties → add --remote-debugging-port=9222 to the Target field.';
                vscode.window.showInformationMessage(guide, { modal: true });
            } else if (action === 'Auto-Fix Shortcut (Windows)') {
                autoFixWindowsShortcut();
            }
        });

        return;
    }

    // ─── Registry ─────────────────────────────────────────────────────
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }

    const register = () => {
        let registry = {};
        if (fs.existsSync(REGISTRY_FILE)) {
            try {
                registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
            } catch {
                registry = {};
            }
        }

        const previous = (registry[workspacePath] && typeof registry[workspacePath] === 'object')
            ? registry[workspacePath]
            : {};

        registry[workspacePath] = {
            ...previous,
            port: cdpTarget.port,
            ip: cdpTarget.ip,
            pid: process.pid,
            lastActive: Date.now(),
            ls: latestLs || previous.ls,
            quota: latestQuota || previous.quota,
            quotaError: latestQuotaError,
        };

        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    };

    register();
    log(`Registered workspace ${workspacePath} with CDP target ${cdpTarget.ip}:${cdpTarget.port}`);

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
