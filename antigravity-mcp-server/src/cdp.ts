/**
 * CDP Registry Routing & Connection Module
 *
 * Replaces the previous port-scanning logic.
 * Now reads the CDP port for a specific target directory
 * from the registry managed by antigravity-mcp-sidecar.
 */

import fs from "fs";
import path from "path";
import os from "os";
import WebSocket from "ws";

const REGISTRY_FILE = path.join(os.homedir(), ".antigravity-mcp", "registry.json");

// --- Types ---

export interface CDPTarget {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    type: string;
}

export interface ExecutionContext {
    id: number;
    name: string;
    origin: string;
}

export interface CDPConnection {
    ws: WebSocket;
    call: (method: string, params?: Record<string, unknown>) => Promise<any>;
    contexts: ExecutionContext[];
    close: () => void;
}

// --- discoverCDP (Registry-based) ---

/**
 * Find the CDP WebSocket URL for the given target directory.
 * Reads from ~/.antigravity-mcp/registry.json instead of port scanning.
 */
export async function discoverCDP(targetDir?: string): Promise<{
    port: number;
    ip: string;
    target: CDPTarget;
} | null> {
    // 1. Resolve Target Directory Map from Registry
    let cdpPort: number | undefined;
    let cdpIp: string = '127.0.0.1';

    // Option A: Use environment override if explicitly provided
    const envPort = process.env.ANTIGRAVITY_CDP_PORT;
    if (envPort) {
        cdpPort = parseInt(envPort, 10);
    } else if (targetDir) {
        // Option B: Registry lookup
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
                const targetAbsPath = path.resolve(targetDir);

                // Exact match
                if (registry[targetAbsPath]) {
                    cdpPort = registry[targetAbsPath].port;
                    if (registry[targetAbsPath].ip) cdpIp = registry[targetAbsPath].ip;
                } else {
                    // Fallback: Prefix match (e.g. if target is a subfolder)
                    for (const key of Object.keys(registry)) {
                        if (targetAbsPath.startsWith(key)) {
                            cdpPort = registry[key].port;
                            if (registry[key].ip) cdpIp = registry[key].ip;
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`[CDP] Failed to read registry: ${(e as Error).message}`);
        }
    } else {
        // Option C: Legacy fallback (No target/env provided)
        // Just take the first one in the registry
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
                const keys = Object.keys(registry);
                if (keys.length > 0) {
                    cdpPort = registry[keys[0]].port;
                    if (registry[keys[0]].ip) cdpIp = registry[keys[0]].ip;
                }
            }
        } catch { }
    }

    if (!cdpPort) {
        return null;
    }

    // 2. Fetch target from the exact port and IP
    try {
        const response = await fetch(`http://${cdpIp}:${cdpPort}/json/list`);
        const list: CDPTarget[] = await response.json() as any;

        const workbench = list.find((t) =>
            t.url?.includes("workbench.html") &&
            t.type === "page" &&
            !t.url?.includes("jetski")
        );

        if (workbench) {
            return { port: cdpPort, ip: cdpIp, target: workbench };
        }
    } catch (e) {
        console.error(`[CDP] Target ${cdpIp}:${cdpPort} from registry is unreachable.`);
    }

    return null;
}

// --- connectCDP ---

export async function connectCDP(wsUrl: string): Promise<CDPConnection> {
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (reason: any) => void;
            timeoutId: ReturnType<typeof setTimeout>;
        }
    >();
    const contexts: ExecutionContext[] = [];
    const CDP_CALL_TIMEOUT = 30000;

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg.toString());

            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const pending = pendingCalls.get(data.id)!;
                clearTimeout(pending.timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) pending.reject(data.error);
                else pending.resolve(data.result);
            }

            if (data.method === "Runtime.executionContextCreated") {
                contexts.push(data.params.context);
            } else if (data.method === "Runtime.executionContextDestroyed") {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex((c) => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === "Runtime.executionContextsCleared") {
                contexts.length = 0;
            }
        } catch { }
    });

    const call = (
        method: string,
        params?: Record<string, unknown>
    ): Promise<any> =>
        new Promise((resolve, reject) => {
            const id = idCounter++;
            const timeoutId = setTimeout(() => {
                if (pendingCalls.has(id)) {
                    pendingCalls.delete(id);
                    reject(new Error(`CDP call ${method} timed out`));
                }
            }, CDP_CALL_TIMEOUT);

            pendingCalls.set(id, { resolve, reject, timeoutId });
            ws.send(JSON.stringify({ id, method, params }));
        });

    await call("Runtime.enable", {});
    await new Promise((r) => setTimeout(r, 1000));

    const close = () => {
        for (const [, pending] of pendingCalls) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error("Connection closed"));
        }
        pendingCalls.clear();
        ws.close();
    };

    return { ws, call, contexts, close };
}

export async function evaluateInAllContexts(
    cdp: CDPConnection,
    expression: string,
    awaitPromise = false
): Promise<any> {
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise,
                contextId: ctx.id,
            });

            if (result.exceptionDetails) continue;

            if (result.result && result.result.value !== undefined) {
                const val = result.result.value;
                if (val && typeof val === "object" && val.error) continue;
                return val;
            }
        } catch { }
    }
    return null;
}
