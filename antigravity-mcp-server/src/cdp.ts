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

const REGISTRY_DIR = ".antigravity-mcp";
const REGISTRY_FILE_NAME = "registry.json";
const LOCAL_REGISTRY_FILE = path.join(os.homedir(), REGISTRY_DIR, REGISTRY_FILE_NAME);
const WSL_ROUTE_FILE = "/proc/net/route";
const WSL_RESOLV_CONF = "/etc/resolv.conf";

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

export interface RegistryEntry {
    port?: number;
    ip?: string;
    pid?: number;
    lastActive?: number;
    ls?: RegistryLsEndpoint;
    quota?: RegistryQuotaSnapshot;
    quotaError?: string;
}

export interface DiscoveredCDP {
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
}

function isWslRuntime(): boolean {
    return os.release().toLowerCase().includes("microsoft");
}

function isLocalhost(ip?: string): boolean {
    if (!ip) return false;
    const lower = ip.toLowerCase();
    return lower === "127.0.0.1" || lower === "localhost" || lower === "::1";
}

function toWslPathFromWindowsPath(inputPath: string): string | null {
    const normalized = inputPath.replace(/\\/g, "/");
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (!match) return null;
    const drive = match[1].toLowerCase();
    const rest = match[2];
    return path.posix.normalize(`/mnt/${drive}/${rest}`);
}

export function normalizeRegistryPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    const windowsAsWsl = toWslPathFromWindowsPath(trimmed);
    if (windowsAsWsl) {
        return windowsAsWsl;
    }

    let normalized = trimmed.replace(/\\/g, "/");
    if (!normalized.startsWith("/")) {
        normalized = `/${normalized}`;
    }
    return path.posix.normalize(normalized);
}

function dedupe(items: Array<string | undefined | null>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        if (!item) continue;
        const value = item.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function getRegistryFileCandidates(): string[] {
    const candidates: Array<string | undefined> = [LOCAL_REGISTRY_FILE];

    if (!isWslRuntime()) {
        return dedupe(candidates);
    }

    if (process.env.USERPROFILE) {
        const converted = toWslPathFromWindowsPath(process.env.USERPROFILE);
        if (converted) {
            candidates.push(path.posix.join(converted, REGISTRY_DIR, REGISTRY_FILE_NAME));
        }
    }

    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
        const converted = toWslPathFromWindowsPath(
            `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        );
        if (converted) {
            candidates.push(path.posix.join(converted, REGISTRY_DIR, REGISTRY_FILE_NAME));
        }
    }

    // Fallback: probe all Windows user profiles under /mnt/c/Users.
    const usersDir = "/mnt/c/Users";
    try {
        if (fs.existsSync(usersDir)) {
            for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                candidates.push(
                    path.posix.join(usersDir, entry.name, REGISTRY_DIR, REGISTRY_FILE_NAME)
                );
            }
        }
    } catch {
        // Ignore candidate expansion failures.
    }

    return dedupe(candidates);
}

function readRegistryObject(): Record<string, RegistryEntry> | null {
    for (const filePath of getRegistryFileCandidates()) {
        try {
            if (!fs.existsSync(filePath)) continue;
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            if (parsed && typeof parsed === "object") {
                return parsed as Record<string, RegistryEntry>;
            }
        } catch (e) {
            console.error(`[CDP] Failed to read registry '${filePath}': ${(e as Error).message}`);
        }
    }
    return null;
}

export function inferWslGatewayFromRouteTable(routeTable: string): string | null {
    const lines = routeTable.split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const destination = parts[1];
        const gatewayHex = parts[2];
        if (destination !== "00000000" || !/^[0-9A-Fa-f]{8}$/.test(gatewayHex)) continue;

        const b1 = parseInt(gatewayHex.slice(6, 8), 16);
        const b2 = parseInt(gatewayHex.slice(4, 6), 16);
        const b3 = parseInt(gatewayHex.slice(2, 4), 16);
        const b4 = parseInt(gatewayHex.slice(0, 2), 16);
        return `${b1}.${b2}.${b3}.${b4}`;
    }
    return null;
}

function readWslGatewayIp(): string | undefined {
    if (!isWslRuntime()) return undefined;
    try {
        if (!fs.existsSync(WSL_ROUTE_FILE)) return undefined;
        const routeTable = fs.readFileSync(WSL_ROUTE_FILE, "utf-8");
        return inferWslGatewayFromRouteTable(routeTable) || undefined;
    } catch {
        return undefined;
    }
}

function readNameserverIp(): string | undefined {
    try {
        if (!fs.existsSync(WSL_RESOLV_CONF)) return undefined;
        const content = fs.readFileSync(WSL_RESOLV_CONF, "utf-8");
        const match = content.match(/^nameserver\s+([0-9.]+)\s*$/m);
        return match?.[1];
    } catch {
        return undefined;
    }
}

export function getCandidateCdpIps(params: {
    registryIp?: string;
    isWsl: boolean;
    nameserverIp?: string;
    gatewayIp?: string;
}): string[] {
    const { registryIp, isWsl, nameserverIp, gatewayIp } = params;
    const ip = registryIp?.trim();

    if (isWsl && (!ip || isLocalhost(ip))) {
        return dedupe([gatewayIp, nameserverIp, ip, "127.0.0.1", "localhost"]);
    }

    if (isWsl) {
        return dedupe([ip, gatewayIp, nameserverIp, "127.0.0.1", "localhost"]);
    }

    return dedupe([ip, "127.0.0.1"]);
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
    registry?: RegistryEntry;
} | null> {
    // 1. Resolve target mapping from env/registry
    const isWsl = isWslRuntime();
    const nameserverIp = readNameserverIp();
    const gatewayIp = readWslGatewayIp();

    let cdpPort: number | undefined;
    let cdpIp: string | undefined;
    let matchedRegistryEntry: RegistryEntry | undefined;

    const envPort = process.env.ANTIGRAVITY_CDP_PORT;
    if (envPort) {
        cdpPort = parseInt(envPort, 10);
    } else {
        const registry = readRegistryObject();
        if (registry) {
            const entries = Object.entries(registry);
            const targetAbsPath = targetDir ? normalizeRegistryPath(path.resolve(targetDir)) : undefined;

            let matched: RegistryEntry | undefined;
            if (targetAbsPath) {
                // Exact match first
                for (const [rawKey, entry] of entries) {
                    if (normalizeRegistryPath(rawKey) === targetAbsPath) {
                        matched = entry;
                        break;
                    }
                }

                // Longest prefix match for subfolders
                if (!matched) {
                    let bestPrefixLength = -1;
                    for (const [rawKey, entry] of entries) {
                        const normalizedKey = normalizeRegistryPath(rawKey);
                        if (!targetAbsPath.startsWith(normalizedKey)) continue;
                        if (normalizedKey.length <= bestPrefixLength) continue;
                        bestPrefixLength = normalizedKey.length;
                        matched = entry;
                    }
                }
            } else if (entries.length > 0) {
                matched = entries[0][1];
            }

            if (matched?.port && Number.isFinite(matched.port)) {
                cdpPort = matched.port;
                matchedRegistryEntry = matched;
                if (matched.ip) {
                    cdpIp = matched.ip;
                }
            }
        }
    }

    if (!cdpPort) {
        return null;
    }

    // 2. Probe candidate IPs until one yields a valid workbench target
    const candidateIps = getCandidateCdpIps({
        registryIp: cdpIp,
        isWsl,
        nameserverIp,
        gatewayIp,
    });

    for (const ip of candidateIps) {
        try {
            const response = await fetch(`http://${ip}:${cdpPort}/json/list`);
            const list: CDPTarget[] = await response.json() as any;
            const workbench = list.find((t) =>
                t.url?.includes("workbench.html") &&
                t.type === "page" &&
                !t.url?.includes("jetski")
            );

            if (workbench) {
                return { port: cdpPort, ip, target: workbench, registry: matchedRegistryEntry };
            }
        } catch {
            // Try next candidate.
        }
    }

    console.error(
        `[CDP] Target ${candidateIps.join(",")}:${cdpPort} from registry is unreachable.`
    );
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
