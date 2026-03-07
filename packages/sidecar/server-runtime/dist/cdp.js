/**
 * CDP Registry Routing & Connection Module
 *
 * Replaces the previous port-scanning logic.
 * Now reads the CDP port for a specific target directory
 * from the registry managed by antigravity-mcp-sidecar.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import WebSocket from "ws";
import { readRegistryObject as _readRegistry, getRegistryFilePath as _getRegistryFilePath, COMPATIBLE_SCHEMA_VERSIONS, entrySupportsCurrentSchema, REGISTRY_CONTROL_KEY, CONTROL_NO_CDP_PROMPT_KEY, NO_CDP_PROMPT_COOLDOWN_MS, } from "@antigravity-mcp/core";
const READY_STATE = "ready";
function isFreshTimestamp(value, maxAgeMs) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return false;
    return Date.now() - value <= maxAgeMs;
}
/** Normalize path the same way the sidecar does (for workspace_id hashing). */
function normalizePathForId(rawPath) {
    let p = rawPath.trim();
    if (!p)
        return "";
    // Resolve relative paths and symlinks before normalizing.
    try {
        p = fs.realpathSync(p);
    }
    catch { /* path may not exist locally; fall back to resolve */ }
    p = path.resolve(p);
    p = p.replace(/\\/g, "/");
    p = p.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ":");
    if (p.length > 1 && p.endsWith("/"))
        p = p.slice(0, -1);
    return p;
}
export function computeWorkspaceId(rawPath) {
    const normalized = normalizePathForId(rawPath);
    return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}
function readRegistryObject() {
    return _readRegistry();
}
function getRegistryFilePath() {
    return _getRegistryFilePath();
}
function writeRegistryObject(registryFile, payload) {
    try {
        fs.writeFileSync(registryFile, JSON.stringify(payload, null, 2), "utf-8");
    }
    catch (e) {
        console.error(`[CDP] Failed to write registry '${registryFile}': ${e.message}`);
    }
}
function upsertNoCdpPromptRequest(params) {
    const { registry, registryFile, workspaceId, state, reasonCode, reasonMessage } = params;
    if (!workspaceId)
        return;
    const now = Date.now();
    const requestId = `no_cdp_${workspaceId}`;
    const rawControl = registry[REGISTRY_CONTROL_KEY];
    const control = rawControl && typeof rawControl === "object" ? { ...rawControl } : {};
    const rawRequests = control[CONTROL_NO_CDP_PROMPT_KEY];
    const requests = rawRequests && typeof rawRequests === "object" ? { ...rawRequests } : {};
    const existing = requests[requestId];
    if (existing && typeof existing === "object") {
        const updatedAt = Number(existing.updated_at || existing.created_at || 0);
        if (Number.isFinite(updatedAt) && now - updatedAt < NO_CDP_PROMPT_COOLDOWN_MS) {
            return;
        }
    }
    requests[requestId] = {
        id: requestId,
        type: "cdp_not_ready",
        source: "server",
        workspace_id: workspaceId,
        state: state || "unknown",
        reason_code: reasonCode,
        reason_message: reasonMessage,
        status: "pending",
        created_at: existing && typeof existing === "object" ? Number(existing.created_at || now) : now,
        updated_at: now,
    };
    control[CONTROL_NO_CDP_PROMPT_KEY] = requests;
    registry[REGISTRY_CONTROL_KEY] = control;
    writeRegistryObject(registryFile, registry);
}
function discoverError(code, message, extras) {
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
function listRegistryEntries(registry) {
    return Object.entries(registry)
        .filter(([key, value]) => !key.startsWith("__") && !!value && typeof value === "object")
        .map(([, value]) => value);
}
function computeWorkspaceKey(entry, ip, port) {
    return entry?.workspace_id ?? entry?.original_workspace_id ?? `${ip}:${port}`;
}
function rankRegistryEntries(entries) {
    return [...entries].sort((a, b) => {
        const readyScore = (x) => (x.state === READY_STATE ? 1 : 0);
        const freshScore = (x) => isFreshTimestamp(x.verified_at, x.ttl_ms ?? 30000) ? 1 : 0;
        const roleScore = (x) => (x.role === "host" ? 1 : 0);
        const byReady = readyScore(b) - readyScore(a);
        if (byReady !== 0)
            return byReady;
        const byFresh = freshScore(b) - freshScore(a);
        if (byFresh !== 0)
            return byFresh;
        const byRole = roleScore(b) - roleScore(a);
        if (byRole !== 0)
            return byRole;
        return (b.priority ?? 0) - (a.priority ?? 0);
    });
}
async function resolveTargetFromEndpoint(ip, port) {
    const response = await fetch(`http://${ip}:${port}/json/list`);
    const list = await response.json();
    const workbench = list.find((t) => t.url?.includes("workbench.html") &&
        t.type === "page" &&
        !t.url?.includes("jetski"));
    const fallbackPage = list.find((t) => t.type === "page" &&
        !!t.webSocketDebuggerUrl &&
        !t.url?.includes("jetski"));
    return workbench || fallbackPage || null;
}
export async function discoverCDPDetailed(targetDir, options = {}) {
    const { exactWorkspaceOnly = false } = options;
    const targetId = targetDir ? computeWorkspaceId(path.resolve(targetDir)) : undefined;
    const registryFile = getRegistryFilePath();
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
            const discovered = {
                ip: envHost,
                port: envPort,
                target,
                matchMode: "auto_fallback",
                workspaceKey: `${envHost}:${envPort}`,
            };
            console.error(`[CDP] discovery success: matchMode=${discovered.matchMode} workspaceKey=${discovered.workspaceKey}`);
            return {
                ok: true,
                discovered,
            };
        }
        catch (error) {
            return discoverError("endpoint_unreachable", `CDP endpoint unreachable on ${envHost}:${envPort}`, {
                details: { error: error.message },
            });
        }
    }
    if (!fs.existsSync(registryFile)) {
        return discoverError("no_workspace_ever_opened", `Registry not found: ${registryFile}`, {
            workspaceId: targetId,
        });
    }
    const registry = readRegistryObject();
    if (!registry) {
        return discoverError("registry_missing", `Registry could not be read: ${registryFile}`, {
            workspaceId: targetId,
        });
    }
    const entries = listRegistryEntries(registry);
    if (entries.length === 0) {
        return discoverError("no_workspace_ever_opened", "Registry has no workspace entries", {
            workspaceId: targetId,
        });
    }
    const withSupportedSchema = entries.filter((entry) => entrySupportsCurrentSchema(entry));
    if (withSupportedSchema.length === 0) {
        const seenSchemas = [...new Set(entries.map((entry) => Number(entry.schema_version)))].filter((n) => Number.isFinite(n));
        return discoverError("schema_mismatch", `Unsupported schema_version in registry (supported=${COMPATIBLE_SCHEMA_VERSIONS.join(",")})`, {
            workspaceId: targetId,
            details: { seen_schema_versions: seenSchemas },
        });
    }
    const exactMatches = targetId
        ? withSupportedSchema.filter((entry) => entry.workspace_id === targetId ||
            entry.original_workspace_id === targetId)
        : [];
    let matchMode = "auto_fallback";
    let discoveryPool = withSupportedSchema;
    if (targetId && exactMatches.length > 0) {
        matchMode = "exact";
        discoveryPool = exactMatches;
    }
    else if (targetId && exactWorkspaceOnly) {
        return discoverError("workspace_not_found", `No registry entry matched workspace id ${targetId}`, {
            workspaceId: targetId,
        });
    }
    const ranked = rankRegistryEntries(discoveryPool);
    const matched = ranked[0];
    if (!matched) {
        return discoverError("workspace_not_found", "No usable registry entry found after ranking", {
            workspaceId: targetId,
        });
    }
    if (matched.state !== READY_STATE) {
        upsertNoCdpPromptRequest({
            registry,
            registryFile,
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            reasonCode: "entry_not_ready",
            reasonMessage: `Registry entry is not ready (state=${matched.state ?? "unknown"})`,
        });
        return discoverError("entry_not_ready", `Registry entry is not ready (state=${matched.state ?? "unknown"})`, {
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            details: {
                last_error: matched.last_error,
                role: matched.role,
            },
        });
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
        upsertNoCdpPromptRequest({
            registry,
            registryFile,
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            reasonCode: "endpoint_missing",
            reasonMessage: "Registry entry has no valid local_endpoint",
        });
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
            upsertNoCdpPromptRequest({
                registry,
                registryFile,
                workspaceId: matched.workspace_id ?? targetId,
                state: matched.state,
                reasonCode: "cdp_target_not_found",
                reasonMessage: `No CDP page target on ${ip}:${port}`,
            });
            return discoverError("cdp_target_not_found", `No CDP page target on ${ip}:${port}`, {
                workspaceId: matched.workspace_id ?? targetId,
                state: matched.state,
            });
        }
        const discovered = {
            ip,
            port,
            target,
            registry: matched,
            matchMode,
            workspaceKey: computeWorkspaceKey(matched, ip, port),
        };
        console.error(`[CDP] discovery success: matchMode=${discovered.matchMode} workspaceKey=${discovered.workspaceKey}`);
        return {
            ok: true,
            discovered,
        };
    }
    catch (error) {
        upsertNoCdpPromptRequest({
            registry,
            registryFile,
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            reasonCode: "endpoint_unreachable",
            reasonMessage: `Failed to connect to ${ip}:${port}`,
        });
        return discoverError("endpoint_unreachable", `Failed to connect to ${ip}:${port}`, {
            workspaceId: matched.workspace_id ?? targetId,
            state: matched.state,
            details: { error: error.message },
        });
    }
}
export async function discoverCDP(targetDir) {
    const result = await discoverCDPDetailed(targetDir);
    if (!result.ok || !result.discovered)
        return null;
    return result.discovered;
}
// --- connectCDP ---
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
        let data;
        try {
            data = JSON.parse(msg.toString());
        }
        catch {
            // Malformed CDP frame — skip without affecting pending calls.
            return;
        }
        if (data.id !== undefined && pendingCalls.has(data.id)) {
            const pending = pendingCalls.get(data.id);
            clearTimeout(pending.timeoutId);
            pendingCalls.delete(data.id);
            if (data.error)
                pending.reject(data.error);
            else
                pending.resolve(data.result);
        }
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
    });
    const call = (method, params) => new Promise((resolve, reject) => {
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
    }
    catch (error) {
        close();
        throw error;
    }
    return { ws, call, contexts, close };
}
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
        catch { }
    }
    return null;
}
//# sourceMappingURL=cdp.js.map