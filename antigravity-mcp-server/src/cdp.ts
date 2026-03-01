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
const SUPPORTED_SCHEMA_VERSIONS = [2];
const READY_STATE = "ready";

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
    schema_version?: number;
    protocol?: {
        schema_version?: number;
        compatible_schema_versions?: number[];
        writer_role?: string;
        writer_node_id?: string;
        updated_at?: number;
    };
    workspace_id?: string;
    original_workspace_id?: string;
    workspace_paths?: { normalized?: string; raw?: string };
    node_id?: string;
    role?: string;
    source_of_truth?: string;
    source_endpoint?: RegistryV1Endpoint;
    local_endpoint?: RegistryV1Endpoint;
    state?: string;
    verified_at?: number;
    ttl_ms?: number;
    priority?: number;
    quota_meta?: RegistryV1QuotaMeta;
    last_error?: {
        code?: string;
        message?: string;
        at?: number;
        details?: Record<string, unknown>;
    };
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

export type DiscoverErrorCode =
    | "registry_missing"
    | "workspace_not_found"
    | "schema_mismatch"
    | "entry_not_ready"
    | "entry_stale"
    | "endpoint_missing"
    | "endpoint_unreachable"
    | "cdp_target_not_found"
    | "invalid_env_port";

export interface DiscoverCDPError {
    code: DiscoverErrorCode;
    message: string;
    workspaceId?: string;
    state?: string;
    details?: Record<string, unknown>;
}

export interface DiscoverCDPResult {
    ok: boolean;
    discovered?: DiscoveredCDP;
    error?: DiscoverCDPError;
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
    const registryFile = process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || LOCAL_REGISTRY_FILE;
    try {
        if (!fs.existsSync(registryFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
        if (parsed && typeof parsed === "object") {
            return parsed as Record<string, RegistryEntry>;
        }
    } catch (e) {
        console.error(`[CDP] Failed to read registry '${registryFile}': ${(e as Error).message}`);
    }
    return null;
}

function discoverError(
    code: DiscoverErrorCode,
    message: string,
    extras?: Partial<DiscoverCDPError>
): DiscoverCDPResult {
    return {
        ok: false,
        error: {
            code,
            message,
            workspaceId: extras?.workspaceId,
            state: extras?.state,
            details: extras?.details,
        },
    };
}

function listRegistryEntries(registry: Record<string, RegistryEntry>): RegistryEntry[] {
    return Object.entries(registry)
        .filter(([key, value]) => !key.startsWith("__") && !!value && typeof value === "object")
        .map(([, value]) => value);
}

function rankRegistryEntries(entries: RegistryEntry[]): RegistryEntry[] {
    return [...entries].sort((a, b) => {
        const readyScore = (x: RegistryEntry) => (x.state === READY_STATE ? 1 : 0);
        const freshScore = (x: RegistryEntry) =>
            isFreshTimestamp(x.verified_at, x.ttl_ms ?? 30000) ? 1 : 0;
        const roleScore = (x: RegistryEntry) => (x.role === "host" ? 1 : 0);
        const byReady = readyScore(b) - readyScore(a);
        if (byReady !== 0) return byReady;
        const byFresh = freshScore(b) - freshScore(a);
        if (byFresh !== 0) return byFresh;
        const byRole = roleScore(b) - roleScore(a);
        if (byRole !== 0) return byRole;
        return (b.priority ?? 0) - (a.priority ?? 0);
    });
}

function entrySupportsSchema(entry: RegistryEntry): boolean {
    const declared = new Set<number>();
    if (Number.isFinite(Number(entry.schema_version))) {
        declared.add(Number(entry.schema_version));
    }
    if (Array.isArray(entry.protocol?.compatible_schema_versions)) {
        for (const raw of entry.protocol.compatible_schema_versions) {
            const version = Number(raw);
            if (Number.isFinite(version)) declared.add(version);
        }
    }
    if (declared.size === 0) return false;
    return [...declared].some((version) => SUPPORTED_SCHEMA_VERSIONS.includes(version));
}

async function resolveTargetFromEndpoint(ip: string, port: number): Promise<CDPTarget | null> {
    const response = await fetch(`http://${ip}:${port}/json/list`);
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
    return workbench || fallbackPage || null;
}

export async function discoverCDPDetailed(targetDir?: string): Promise<DiscoverCDPResult> {
    const targetId = targetDir ? computeWorkspaceId(path.resolve(targetDir)) : undefined;
    const envPortRaw = process.env.ANTIGRAVITY_CDP_PORT;
    const envHost = process.env.ANTIGRAVITY_CDP_HOST?.trim() || "127.0.0.1";

    // Env override remains highest precedence.
    if (envPortRaw && envPortRaw.trim()) {
        const envPort = Number.parseInt(envPortRaw, 10);
        if (!Number.isFinite(envPort) || envPort < 1 || envPort > 65535) {
            return discoverError("invalid_env_port", `Invalid ANTIGRAVITY_CDP_PORT: ${envPortRaw}`);
        }
        try {
            const target = await resolveTargetFromEndpoint(envHost, envPort);
            if (!target) {
                return discoverError("cdp_target_not_found", `No CDP page target on ${envHost}:${envPort}`);
            }
            return {
                ok: true,
                discovered: {
                    ip: envHost,
                    port: envPort,
                    target,
                },
            };
        } catch (error) {
            return discoverError("endpoint_unreachable", `CDP endpoint unreachable on ${envHost}:${envPort}`, {
                details: { error: (error as Error).message },
            });
        }
    }

    const registry = readRegistryObject();
    if (!registry) {
        const registryFile = process.env.ANTIGRAVITY_REGISTRY_FILE?.trim() || LOCAL_REGISTRY_FILE;
        return discoverError("registry_missing", `Registry not found: ${registryFile}`, {
            workspaceId: targetId,
        });
    }

    const entries = listRegistryEntries(registry);
    if (entries.length === 0) {
        return discoverError("workspace_not_found", "Registry has no workspace entries", {
            workspaceId: targetId,
        });
    }

    const scoped = targetId
        ? entries.filter(
              (entry) =>
                  entry.workspace_id === targetId ||
                  entry.original_workspace_id === targetId
          )
        : entries;
    if (scoped.length === 0) {
        return discoverError("workspace_not_found", `No registry entry matched workspace id ${targetId}`, {
            workspaceId: targetId,
        });
    }

    const withSupportedSchema = scoped.filter((entry) => entrySupportsSchema(entry));
    if (withSupportedSchema.length === 0) {
        const seenSchemas = [...new Set(scoped.map((entry) => Number(entry.schema_version)))].filter((n) => Number.isFinite(n));
        return discoverError("schema_mismatch", `Unsupported schema_version in registry (supported=${SUPPORTED_SCHEMA_VERSIONS.join(",")})`, {
            workspaceId: targetId,
            details: { seen_schema_versions: seenSchemas },
        });
    }

    const ranked = rankRegistryEntries(withSupportedSchema);
    const matched = ranked[0];
    if (!matched) {
        return discoverError("workspace_not_found", "No usable registry entry found after ranking", {
            workspaceId: targetId,
        });
    }

    if (matched.state !== READY_STATE) {
        return discoverError(
            "entry_not_ready",
            `Registry entry is not ready (state=${matched.state ?? "unknown"})`,
            {
                workspaceId: matched.workspace_id ?? targetId,
                state: matched.state,
                details: {
                    last_error: matched.last_error,
                    role: matched.role,
                },
            }
        );
    }

    if (!isFreshTimestamp(matched.verified_at, matched.ttl_ms ?? 30000)) {
        return discoverError("entry_stale", "Registry entry is stale", {
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            details: {
                verified_at: matched.verified_at,
                ttl_ms: matched.ttl_ms ?? 30000,
            },
        });
    }

    const endpoint = matched.local_endpoint;
    if (!endpoint?.port || !Number.isFinite(endpoint.port)) {
        return discoverError("endpoint_missing", "Registry entry has no valid local_endpoint", {
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
        });
    }

    const ip = endpoint.host || "127.0.0.1";
    const port = Number(endpoint.port);
    try {
        const target = await resolveTargetFromEndpoint(ip, port);
        if (!target) {
            return discoverError("cdp_target_not_found", `No CDP page target on ${ip}:${port}`, {
                workspaceId: matched.workspace_id ?? targetId,
                state: matched.state,
            });
        }
        return {
            ok: true,
            discovered: {
                ip,
                port,
                target,
                registry: matched,
            },
        };
    } catch (error) {
        return discoverError("endpoint_unreachable", `Failed to connect to ${ip}:${port}`, {
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            details: { error: (error as Error).message },
        });
    }
}

export async function discoverCDP(targetDir?: string): Promise<{
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
} | null> {
    const result = await discoverCDPDetailed(targetDir);
    if (!result.ok || !result.discovered) return null;
    return result.discovered;
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

    // Define close() before any awaited calls so it can be used in the error path.
    const close = () => {
        for (const [, pending] of pendingCalls) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error("Connection closed"));
        }
        pendingCalls.clear();
        ws.close();
    };

    ws.on("message", (msg) => {
        // Separate JSON parse from routing: a malformed frame cannot be routed,
        // but should not silently swallow subsequent valid messages' handler logic.
        let data: any;
        try {
            data = JSON.parse(msg.toString());
        } catch {
            // Malformed CDP frame — skip without affecting pending calls.
            return;
        }

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

    // Initialize Runtime domain. Close WebSocket before rethrowing on failure.
    try {
        await call("Runtime.enable", {});
        await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
        close();
        throw error;
    }

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
