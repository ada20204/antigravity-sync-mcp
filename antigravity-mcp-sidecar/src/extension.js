const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { startAutoAccept, stopAutoAccept } = require('./auto-accept');

const REGISTRY_DIR = path.join(os.homedir(), '.antigravity-mcp');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');


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
    const PORTS = Array.from({ length: 7 }, (_, i) => 8997 + i).concat(
        Array.from({ length: 51 }, (_, i) => 7800 + i)
    );

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
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const workspaceName = vscode.workspace.name || "";

    const cdpPort = await findCdpPort(workspaceName);
    if (!cdpPort) {
        console.error(`[antigravity-mcp-sidecar] Could not find CDP port for workspace: ${workspacePath}`);
        return;
    }

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
    console.log(`[antigravity-mcp-sidecar] Registered workspace ${workspacePath} with CDP port ${cdpPort}`);

    startAutoAccept(cdpPort);
    console.log(`[antigravity-mcp-sidecar] Started auto-accept loops on CDP port ${cdpPort}`);

    context.subscriptions.push({
        dispose: () => {
            stopAutoAccept();
            if (fs.existsSync(REGISTRY_FILE)) {
                try {
                    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
                    if (registry[workspacePath] && registry[workspacePath].pid === process.pid) {
                        delete registry[workspacePath];
                        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
                        console.log(`[antigravity-mcp-sidecar] Deregistered workspace ${workspacePath}`);
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
