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
import crypto from "crypto";
import WebSocket from "ws";

const REGISTRY_DIR = ".config/antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOCAL_REGISTRY_FILE = path.join(os.homedir(), REGISTRY_DIR, REGISTRY_FILE_NAME);

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

export interface RegistryQuotaModel {
    label?: string;
    modelId?: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted?: boolean;
    resetTime?: string;
    resetInMs?: number;
}

export interface RegistryQuotaSnapshot {
    timestamp?: number;
    source?: string;
    promptCredits?: {
        available?: number;
        monthly?: number;
        usedPercentage?: number;
        remainingPercentage?: number;
    };
    models?: RegistryQuotaModel[];
    lastError?: string;
}

export interface RegistryLsEndpoint {
    port?: number;
    csrfToken?: string;
    lastDetectedAt?: number;
    sourceHost?: string;
}

export interface RegistryV1Endpoint {
    host?: string;
    port?: number;
    mode?: string;
}

export interface RegistryV1QuotaMeta {
    source?: string;
    stale?: boolean;
    refreshed_at?: number;
    refresh_interval_ms?: number;
}

export interface RegistryEntry {
    // v1 fields
    schema_version?: number;
    workspace_id?: string;
    workspace_paths?: { normalized?: string; raw?: string };
    role?: string;
    source_of_truth?: string;
    source_endpoint?: RegistryV1Endpoint;
    local_endpoint?: RegistryV1Endpoint;
    state?: string;
    verified_at?: number;
    ttl_ms?: number;
    priority?: number;
    quota_meta?: RegistryV1QuotaMeta;
    // v0 fields
    port?: number;
    ip?: string;
    pid?: number;
    lastActive?: number;
    ls?: RegistryLsEndpoint;
    quota?: RegistryQuotaSnapshot;
    quotaError?: string;
    cdp?: RegistryCdpState;
}

export interface RegistryCdpCandidate {
    host?: string;
    port?: number;
}

export interface RegistryCdpProbeItem {
    host?: string;
    port?: number;
    stage?: string;
    ok?: boolean;
    source?: string;
    error?: string;
}

export interface RegistryCdpActiveEndpoint {
    host?: string;
    port?: number;
    source?: string;
    verifiedAt?: number;
}

export interface RegistryCdpState {
    generation?: number;
    state?: "idle" | "probing" | "ready" | "error" | string;
    updatedAt?: number;
    verifiedAt?: number;
    active?: RegistryCdpActiveEndpoint;
    candidates?: RegistryCdpCandidate[];
    probeSummary?: RegistryCdpProbeItem[];
    lastError?: string;
}

export interface DiscoveredCDP {
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
}

function isFreshTimestamp(value: unknown, maxAgeMs: number): boolean {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    return Date.now() - value <= maxAgeMs;
}

/** Normalize path the same way the sidecar does (for workspace_id hashing). */
function normalizePathForId(rawPath: string): string {
    let p = rawPath.trim();
    if (!p) return "";
    p = p.replace(/\\/g, "/");
    p = p.replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ":");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
}

export function computeWorkspaceId(rawPath: string): string {
    const normalized = normalizePathForId(rawPath);
    return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

function readRegistryObject(): Record<string, RegistryEntry> | null {
    try {
        if (!fs.existsSync(LOCAL_REGISTRY_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(LOCAL_REGISTRY_FILE, "utf-8"));
        if (parsed && typeof parsed === "object") {
            return parsed as Record<string, RegistryEntry>;
        }
    } catch (e) {
        console.error(`[CDP] Failed to read registry '${LOCAL_REGISTRY_FILE}': ${(e as Error).message}`);
    }
    return null;
}

// --- discoverCDP (Registry-based) ---

/**
 * Find the CDP WebSocket URL for the given target directory.
 * Reads from ~/.config/antigravity-mcp/registry.json instead of port scanning.
 */
export async function discoverCDP(targetDir?: string): Promise<{
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
} | null> {
    let cdpPort: number | undefined;
    let cdpIp: string | undefined;
    let matchedRegistryEntry: RegistryEntry | undefined;

    // 1. Check environment variables first
    const envPort = process.env.ANTIGRAVITY_CDP_PORT;
    const envHost = process.env.ANTIGRAVITY_CDP_HOST?.trim();
    if (envHost) {
        cdpIp = envHost;
    }
    if (envPort) {
        cdpPort = parseInt(envPort, 10);
    } else {
        // 2. Match by workspace_id from registry
        const registry = readRegistryObject();
        if (registry && targetDir) {
            const targetId = computeWorkspaceId(path.resolve(targetDir));
            const v1Candidates = Object.values(registry)
                .filter((e) => e.schema_version === 1 && e.workspace_id === targetId);

            if (v1Candidates.length > 0) {
                // Prefer role=host, then highest priority
                v1Candidates.sort((a, b) => {
                    const roleScore = (e: RegistryEntry) => (e.role === "host" ? 1 : 0);
                    const diff = roleScore(b) - roleScore(a);
                    if (diff !== 0) return diff;
                    return (b.priority ?? 0) - (a.priority ?? 0);
                });

                const matched = v1Candidates[0];
                matchedRegistryEntry = matched;

                // Use local_endpoint directly
                const le = matched.local_endpoint;
                const isReady =
                    matched.state === "ready" &&
                    le?.port != null &&
                    Number.isFinite(le.port) &&
                    isFreshTimestamp(matched.verified_at, matched.ttl_ms ?? 30000);

                if (isReady && le?.port) {
                    cdpPort = le.port;
                    cdpIp = le.host ?? "127.0.0.1";
                }
            }
        }
    }

    if (!cdpPort) {
        return null;
    }

    // 3. Connect to the local_endpoint
    try {
        const response = await fetch(`http://${cdpIp}:${cdpPort}/json/list`);
        const list: CDPTarget[] = await response.json() as any;
        const workbench = list.find((t) =>
            t.url?.includes("workbench.html") &&
            t.type === "page" &&
            !t.url?.includes("jetski")
        );
        const fallbackPage = list.find((t) =>
            t.type === "page" &&
            !!t.webSocketDebuggerUrl &&
            !t.url?.includes("jetski")
        );

        if (workbench || fallbackPage) {
            return {
                port: cdpPort,
                ip: cdpIp ?? "127.0.0.1",
                target: (workbench || fallbackPage)!,
                registry: matchedRegistryEntry,
            };
        }
    } catch (error) {
        console.error(
            `[CDP] Failed to connect to ${cdpIp}:${cdpPort}: ${(error as Error).message}`
        );
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
