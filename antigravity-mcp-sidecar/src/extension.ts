import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";

const REGISTRY_DIR = path.join(os.homedir(), ".antigravity-mcp");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "registry.json");

// Helper: HTTP GET JSON
function getJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("timeout"));
        });
    });
}

/**
 * Scan common Antigravity debug ports to find this window's CDP port.
 */
async function findCdpPort(): Promise<number | null> {
    const PORTS = Array.from({ length: 7 }, (_, i) => 8997 + i).concat(
        Array.from({ length: 51 }, (_, i) => 7800 + i)
    );

    const workspaceName = vscode.workspace.name || "";

    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            const workbench = list.find((t: any) =>
                t.url?.includes("workbench.html") &&
                t.type === "page" &&
                !t.url?.includes("jetski")
            );

            if (workbench) {
                // If we have a workspace name, try to match it in the title.
                // If no workspace name, just take the first one (single window mode).
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

export async function activate(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return; // Fast exit if no workspace
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;

    // Find CDP port
    const cdpPort = await findCdpPort();
    if (!cdpPort) {
        console.error(`[antigravity-mcp-sidecar] Could not find CDP port for workspace: ${workspacePath}`);
        return;
    }

    // Ensure registry directory exists
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }

    // Update registry.json
    const register = () => {
        let registry: any = {};
        if (fs.existsSync(REGISTRY_FILE)) {
            try {
                registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
            } catch {
                registry = {};
            }
        }

        registry[workspacePath] = {
            port: cdpPort,
            pid: process.pid,
            lastActive: Date.now()
        };

        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf-8");
    };

    register();

    console.log(`[antigravity-mcp-sidecar] Registered workspace ${workspacePath} with CDP port ${cdpPort}`);

    // Cleanup on deactivate via Disposable
    context.subscriptions.push({
        dispose: () => {
            if (fs.existsSync(REGISTRY_FILE)) {
                try {
                    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
                    if (registry[workspacePath]?.pid === process.pid) {
                        delete registry[workspacePath];
                        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf-8");
                        console.log(`[antigravity-mcp-sidecar] Deregistered workspace ${workspacePath}`);
                    }
                } catch { }
            }
        }
    });
}

export function deactivate() { }
