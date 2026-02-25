const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { startAutoAccept, stopAutoAccept } = require('./auto-accept');

const REGISTRY_DIR = path.join(os.homedir(), '.antigravity-mcp');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');


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

async function findCdpPort(workspaceName) {
    // Standard Chromium/Electron debug ports + Antigravity common ranges
    const PORTS = [
        9222, 9229,                                              // standard --remote-debugging-port defaults
        ...Array.from({ length: 15 }, (_, i) => 9000 + i),      // 9000-9014 (Antigravity common)
        ...Array.from({ length: 7 }, (_, i) => 8997 + i),       // 8997-9003
        ...Array.from({ length: 51 }, (_, i) => 7800 + i),      // 7800-7850
    ];

    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            const workbench = list.find((t) =>
                t.url && t.url.includes('workbench.html') &&
                t.type === 'page' &&
                !(t.url && t.url.includes('jetski'))
            );

            if (workbench) {
                if (!workspaceName || workbench.title.includes(workspaceName)) {
                    return port;
                }
            }
        } catch {
            // Ignore
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
    let cdpPort = null;

    function updateStatusBar() {
        if (!cdpPort) {
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
        if (isEnabled && cdpPort) {
            const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
            startAutoAccept(cdpPort, log, config.get('nativePollInterval', 500), config.get('cdpPollInterval', 1500));
            log(`Auto-accept loops running on port ${cdpPort}`);
        } else {
            stopAutoAccept();
            if (!cdpPort) {
                log('Auto-accept unavailable: no CDP port');
            } else {
                log('Auto-accept paused');
            }
        }
        updateStatusBar();
    }

    // ─── Toggle Command (always registered) ───────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.toggle', async () => {
        if (!cdpPort) {
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

    cdpPort = await findCdpPort(workspaceName);
    if (!cdpPort) {
        log(`Error: Could not find CDP port for workspace: ${workspacePath}`);
        updateStatusBar();
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

        registry[workspacePath] = {
            port: cdpPort,
            pid: process.pid,
            lastActive: Date.now()
        };

        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    };

    register();
    log(`Registered workspace ${workspacePath} with CDP port ${cdpPort}`);

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

function deactivate() {
    stopAutoAccept();
}

module.exports = {
    activate,
    deactivate
};
