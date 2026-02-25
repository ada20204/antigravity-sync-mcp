/**
 * CDP Discovery & Connection Module
 *
 * Ported from:
 * - OmniAntigravityRemoteChat/src/server.js (discoverCDP, connectCDP)
 * - auto-accept-agent/extension/main_scripts/cdp-handler.js (port ranges)
 */
import http from "http";
import WebSocket from "ws";
// --- Port Ranges ---
// Antigravity's internal default debug port (confirmed by auto-accept-agent)
const DEFAULT_PORTS = Array.from({ length: 7 }, (_, i) => 8997 + i); // 8997-9003
// User-configured via --remote-debugging-port (documented in OmniRemoteChat)
const FALLBACK_PORTS = Array.from({ length: 51 }, (_, i) => 7800 + i); // 7800-7850
// --- Helper: HTTP GET JSON ---
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
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
// --- discoverCDP ---
/**
 * Scan ports to find an Antigravity workbench CDP target.
 * Priority: ANTIGRAVITY_CDP_PORT env var > default 9000±3 > fallback 7800-7850
 */
export async function discoverCDP() {
    // Build port list with priority
    const ports = [];
    // 1. Environment variable override
    const envPort = process.env.ANTIGRAVITY_CDP_PORT;
    if (envPort) {
        const p = parseInt(envPort, 10);
        if (!isNaN(p))
            ports.push(p);
    }
    // 2. Default ports (Antigravity internal: 9000±3)
    ports.push(...DEFAULT_PORTS);
    // 3. Fallback ports (user-configured: 7800-7850)
    ports.push(...FALLBACK_PORTS);
    // Deduplicate
    const uniquePorts = [...new Set(ports)];
    for (const port of uniquePorts) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            // Filter: only page/webview types with a WebSocket URL
            const pages = list.filter((t) => t.webSocketDebuggerUrl &&
                (t.type === "page" || t.type === "webview") &&
                !(t.url || "").startsWith("devtools://") &&
                !(t.url || "").startsWith("chrome-devtools://"));
            // Priority 1: workbench.html (main editor window)
            const workbench = pages.find((t) => t.url?.includes("workbench.html") && !t.url?.includes("jetski"));
            if (workbench) {
                return { port, target: workbench };
            }
            // Priority 2: Any non-internal page as fallback
            if (pages.length > 0) {
                return { port, target: pages[0] };
            }
        }
        catch {
            // Port not responding, continue
        }
    }
    return null;
}
// --- connectCDP ---
/**
 * Establish a CDP WebSocket connection.
 * Enables Runtime domain and tracks execution contexts.
 * Ported from OmniRemoteChat server.js lines 241-300.
 */
export async function connectCDP(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
    });
    let idCounter = 1;
    const pendingCalls = new Map();
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000;
    // Single centralized message handler
    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const pending = pendingCalls.get(data.id);
                clearTimeout(pending.timeoutId);
                pendingCalls.delete(data.id);
                if (data.error)
                    pending.reject(data.error);
                else
                    pending.resolve(data.result);
            }
            // Handle execution context events
            if (data.method === "Runtime.executionContextCreated") {
                contexts.push(data.params.context);
            }
            else if (data.method === "Runtime.executionContextDestroyed") {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex((c) => c.id === id);
                if (idx !== -1)
                    contexts.splice(idx, 1);
            }
            else if (data.method === "Runtime.executionContextsCleared") {
                contexts.length = 0;
            }
        }
        catch {
            // Ignore parse errors
        }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);
        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });
    // Enable Runtime to discover contexts
    await call("Runtime.enable", {});
    // Give contexts time to populate
    await new Promise((r) => setTimeout(r, 1000));
    const close = () => {
        // Clean up pending calls
        for (const [, pending] of pendingCalls) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error("Connection closed"));
        }
        pendingCalls.clear();
        ws.close();
    };
    return { ws, call, contexts, close };
}
// --- evaluateInAllContexts ---
/**
 * Try evaluating a script in every known execution context.
 * Returns the first successful non-error result.
 * Ported from Omni's captureSnapshot / injectMessage pattern.
 */
export async function evaluateInAllContexts(cdp, expression, awaitPromise = false) {
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise,
                contextId: ctx.id,
            });
            if (result.exceptionDetails)
                continue;
            if (result.result && result.result.value !== undefined) {
                const val = result.result.value;
                if (val && typeof val === "object" && val.error)
                    continue;
                return val;
            }
        }
        catch {
            // Context may be dead, try next
        }
    }
    return null;
}
//# sourceMappingURL=cdp.js.map