import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import net from "net";
import { readRegistryObject } from "./registry-io.js";

const DEFAULT_PORT = 9000;
const CDP_PORT_RANGE_MIN = 9000;
const CDP_PORT_RANGE_MAX = 9014;

// ---------------------------------------------------------------------------
// Helpers carried over from the original module (unchanged)
// ---------------------------------------------------------------------------

function resolveCdpBindAddress(): string {
    const override = process.env.ANTIGRAVITY_CDP_BIND_ADDRESS?.trim();
    if (override) return override;
    return "127.0.0.1";
}

function parsePort(value?: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return undefined;
    return parsed;
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

export function resolveLaunchPort(): number {
    return (
        parsePort(process.env.ANTIGRAVITY_LAUNCH_PORT) ??
        parsePort(process.env.ANTIGRAVITY_CDP_PORT) ??
        DEFAULT_PORT
    );
}

export function resolveAntigravityExecutable(): string | undefined {
    const explicit = process.env.ANTIGRAVITY_EXECUTABLE?.trim();
    if (explicit) return explicit;

    if (process.platform === "win32") {
        const username = process.env.USERNAME || process.env.USER || "";
        const localAppData = process.env.LOCALAPPDATA || `C:\\Users\\${username}\\AppData\\Local`;
        const candidates = [
            path.win32.join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
            path.win32.join(localAppData, "Programs", "Cursor", "Cursor.exe"),
        ];
        return candidates.find((item) => fileExists(item));
    }

    if (process.platform === "darwin") {
        const candidates = [
            "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
            "/Applications/Antigravity.app/Contents/MacOS/Electron",
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "/Applications/Cursor.app/Contents/MacOS/Cursor",
        ];
        return candidates.find((item) => fileExists(item));
    }

    const linuxCandidates = [
        "/usr/bin/antigravity",
        "/usr/local/bin/antigravity",
        "/usr/bin/cursor",
        "/usr/local/bin/cursor",
    ];
    return linuxCandidates.find((item) => fileExists(item));
}

export function buildLaunchArgs(params: { targetDir: string; port: number }): string[] {
    const bindAddress = resolveCdpBindAddress();
    const args = [
        params.targetDir,
        "--new-window",
        `--remote-debugging-port=${params.port}`,
        `--remote-debugging-address=${bindAddress}`,
    ];
    const extra = process.env.ANTIGRAVITY_LAUNCH_EXTRA_ARGS?.trim();
    if (extra) {
        args.push(...extra.split(/\s+/).filter(Boolean));
    }
    return args;
}

// ---------------------------------------------------------------------------
// TCP port availability check (ported from sidecar extension.js:992)
// ---------------------------------------------------------------------------

export async function isTcpPortAvailable(host: string, port: number, timeoutMs = 600): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                server.close(() => resolve(ok));
            } catch {
                resolve(ok);
            }
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        server.on("error", () => finish(false));
        server.listen({ host, port, exclusive: true }, () => finish(true));
    });
}

// ---------------------------------------------------------------------------
// Port allocation (ported from sidecar extension.js:944)
// ---------------------------------------------------------------------------

function collectRegistryOccupiedPorts(registry: Record<string, unknown>): Set<number> {
    const occupied = new Set<number>();
    try {
        for (const [key, raw] of Object.entries(registry || {})) {
            if (key.startsWith("__")) continue;
            const entry = raw as Record<string, unknown> | null;
            const ep = entry?.local_endpoint as Record<string, unknown> | undefined;
            const port = ep && Number(ep.port);
            if (typeof port === "number" && Number.isFinite(port) && port > 0) occupied.add(port);
        }
    } catch {
        // Ignore malformed registry payloads.
    }
    return occupied;
}

function buildPortCandidateOrder(lo: number, hi: number, preferredPort: number): number[] {
    const ordered: number[] = [];
    if (Number.isFinite(preferredPort) && preferredPort >= lo && preferredPort <= hi) {
        ordered.push(preferredPort);
    }
    for (let port = lo; port <= hi; port++) {
        if (port === preferredPort) continue;
        ordered.push(port);
    }
    return ordered;
}

export async function allocateAvailablePort(
    bindAddress: string,
    preferredPort: number,
): Promise<number | null> {
    const registry = readRegistryObject() ?? {};
    const occupied = collectRegistryOccupiedPorts(registry);
    const candidates = buildPortCandidateOrder(CDP_PORT_RANGE_MIN, CDP_PORT_RANGE_MAX, preferredPort);

    for (const port of candidates) {
        if (occupied.has(port)) continue;
        if (await isTcpPortAvailable(bindAddress, port)) return port;
    }
    return null;
}

// ---------------------------------------------------------------------------
// PowerShell quoting helper (ported from sidecar extension.js:1058)
// ---------------------------------------------------------------------------

export function psQuote(value: string): string {
    return String(value || "").replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Atomic Windows launch via PowerShell
// ---------------------------------------------------------------------------

function deriveProcessName(executablePath: string): string {
    return path.win32.basename(executablePath, path.win32.extname(executablePath));
}

export async function atomicWindowsLaunch(
    executable: string,
    args: string[],
    killFirst: boolean,
    log?: (msg: string) => void,
): Promise<void> {
    const exe = psQuote(executable);
    const argList = args.map((item) => `'${psQuote(item)}'`).join(",");

    let script: string;
    if (killFirst) {
        const processName = deriveProcessName(executable);
        script =
            `$ErrorActionPreference='SilentlyContinue'; ` +
            `Get-Process '${psQuote(processName)}' -ErrorAction SilentlyContinue | Stop-Process -Force; ` +
            `$deadline = (Get-Date).AddSeconds(8); ` +
            `while ((Get-Date) -lt $deadline) { ` +
            `  if (-not (Get-Process '${psQuote(processName)}' -ErrorAction SilentlyContinue)) { break }; ` +
            `  Start-Sleep -Milliseconds 200 ` +
            `}; ` +
            `Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`;
    } else {
        script = `Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`;
    }

    log?.(`PowerShell launch script: ${script}`);

    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
}

// ---------------------------------------------------------------------------
// Wait for process to disappear (macOS/Linux)
// ---------------------------------------------------------------------------

async function waitForProcessGone(
    processPattern: string,
    timeoutMs = 5000,
    intervalMs = 200,
): Promise<boolean> {
    const { execSync } = await import("child_process");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            execSync(`pgrep -i "${processPattern}"`, { stdio: "ignore" });
            await new Promise((r) => setTimeout(r, intervalMs));
        } catch {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// CDP readiness verification
// ---------------------------------------------------------------------------

export async function verifyCdpReady(
    host: string,
    port: number,
    timeoutMs = 10_000,
): Promise<boolean> {
    const started = Date.now();
    const interval = 500;
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(`http://${host}:${port}/json/version`);
            if (res.ok) return true;
        } catch {
            // Not ready yet
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return false;
}

// ---------------------------------------------------------------------------
// Main: launchAntigravityForWorkspace (rewritten)
// ---------------------------------------------------------------------------

export interface LaunchResult {
    started: boolean;
    executable?: string;
    port?: number;
    killed?: number;
    cdpVerified?: boolean;
    error?: string;
}

export async function launchAntigravityForWorkspace(params: {
    targetDir: string;
    killExisting?: boolean;
    log?: (message: string) => void;
}): Promise<LaunchResult> {
    const { log } = params;

    // 1. Resolve executable
    const executable = resolveAntigravityExecutable();
    if (!executable) {
        return {
            started: false,
            error: "Antigravity executable not found. Set ANTIGRAVITY_EXECUTABLE.",
        };
    }

    // 2. Allocate port
    const bindAddress = resolveCdpBindAddress();
    const preferredPort = resolveLaunchPort();
    const port = await allocateAvailablePort(bindAddress, preferredPort);
    if (port == null) {
        return {
            started: false,
            executable,
            error: `All CDP ports ${CDP_PORT_RANGE_MIN}-${CDP_PORT_RANGE_MAX} are occupied.`,
        };
    }
    log?.(`Allocated CDP port ${port} (preferred=${preferredPort})`);

    const args = buildLaunchArgs({ targetDir: params.targetDir, port });
    const killFirst = params.killExisting !== false;

    // 3. Platform-specific launch
    try {
        if (process.platform === "win32") {
            await atomicWindowsLaunch(executable, args, killFirst, log);
        } else if (process.platform === "darwin") {
            if (killFirst) {
                const { execSync } = await import("child_process");
                const appName = executable.includes("Antigravity") ? "Antigravity" : "Cursor";
                try {
                    execSync(`pkill -9 -i "${appName}"`, { stdio: "ignore" });
                    log?.(`Sent SIGKILL to ${appName}`);
                } catch {
                    // No matching process
                }
                const gone = await waitForProcessGone(appName);
                log?.(`Process ${appName} ${gone ? "confirmed gone" : "may still be running"}`);
            }

            const appMatch = executable.match(/^(.+\.app)/);
            if (appMatch) {
                const appName = path.basename(appMatch[1], ".app");
                const child = spawn("open", ["-a", appName, "--args", ...args], {
                    detached: true,
                    stdio: "ignore",
                    shell: false,
                });
                child.unref();
            } else {
                const child = spawn(executable, args, {
                    detached: true,
                    stdio: "ignore",
                    shell: false,
                });
                child.unref();
            }
        } else {
            // Linux
            if (killFirst) {
                const { execSync } = await import("child_process");
                const processName = path.basename(executable).toLowerCase();
                try {
                    execSync(`pkill -9 "${processName}"`, { stdio: "ignore" });
                    log?.(`Sent SIGKILL to ${processName}`);
                } catch {
                    // No matching process
                }
                const gone = await waitForProcessGone(processName);
                log?.(`Process ${processName} ${gone ? "confirmed gone" : "may still be running"}`);
            }

            const child = spawn(executable, args, {
                detached: true,
                stdio: "ignore",
                shell: false,
            });
            child.unref();
        }

        log?.(
            `Launched Antigravity: executable='${executable}', port=${port}, targetDir='${params.targetDir}'`
        );
    } catch (error) {
        return {
            started: false,
            executable,
            port,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    // 4. Verify CDP readiness
    log?.(`Verifying CDP on ${bindAddress}:${port} (timeout 10s)...`);
    const cdpVerified = await verifyCdpReady(bindAddress, port, 10_000);
    if (cdpVerified) {
        log?.(`CDP verified on ${bindAddress}:${port}`);
    } else {
        log?.(`CDP not responding on ${bindAddress}:${port} after 10s`);
    }

    return {
        started: true,
        executable,
        port,
        cdpVerified,
        ...(!cdpVerified && { error: `CDP not responding on port ${port} after 10s` }),
    };
}
