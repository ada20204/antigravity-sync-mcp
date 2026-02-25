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
const execAsync = promisify(exec);


let outputChannel;

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

function normalizeQuotaSnapshot(data) {
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
                return {
                    label: String(m.label || ''),
                    modelId: String((m.modelOrAlias && m.modelOrAlias.model) || ''),
                    remainingFraction: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : undefined,
                    remainingPercentage: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction * 100 : undefined,
                    isExhausted: m.quotaInfo.remainingFraction === 0,
                    resetTime,
                    resetInMs: Number.isFinite(resetMs) ? resetMs - now : undefined,
                };
            }),
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
    return {
        ls: {
            port: ls.port,
            csrfToken: ls.csrfToken,
            lastDetectedAt: Date.now(),
            sourceHost: '127.0.0.1',
        },
        quota: normalizeQuotaSnapshot(data),
        error: null,
    };
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

    // ─── Status Bar (always registered, regardless of CDP) ────────────
    let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravityMcpSidecar.toggle';
    context.subscriptions.push(statusBarItem);

    let isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
    let cdpTarget = null;

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

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravityMcpSidecar')) {
            isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
            stopAutoAccept();
            syncState();
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

    let latestLs = null;
    let latestQuota = null;
    let latestQuotaError = null;

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
        } catch (e) {
            latestQuotaError = e && e.message ? e.message : String(e);
            register();
            log(`Quota refresh failed: ${latestQuotaError}`);
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
