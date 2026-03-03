import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const DEFAULT_PORT = 9000;

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

async function killExistingAntigravity(
    executablePath: string,
    log?: (msg: string) => void
): Promise<number> {
    const { execSync } = await import("child_process");

    if (process.platform === "win32") {
        const exeName = path.win32.basename(executablePath);
        try {
            const out = execSync(
                `taskkill /IM "${exeName}" /F /T`,
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
            );
            const killed = (out.match(/SUCCESS/gi) || []).length;
            log?.(`Killed ${killed} existing ${exeName} process(es)`);
            return killed;
        } catch {
            return 0;
        }
    }

    if (process.platform === "darwin") {
        // On macOS, kill by app name (e.g., "Antigravity" or "Cursor")
        const appName = executablePath.includes("Antigravity") ? "Antigravity" : "Cursor";
        try {
            const out = execSync(
                `pkill -9 -i "${appName}"`,
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
            );
            log?.(`Killed existing ${appName} process(es)`);
            // pkill doesn't output count, assume success means at least 1
            return 1;
        } catch {
            return 0;
        }
    }

    // Linux: kill by process name
    const processName = path.basename(executablePath);
    try {
        const out = execSync(
            `pkill -9 "${processName}"`,
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        log?.(`Killed existing ${processName} process(es)`);
        return 1;
    } catch {
        return 0;
    }
}

export async function launchAntigravityForWorkspace(params: {
    targetDir: string;
    killExisting?: boolean;
    log?: (message: string) => void;
}): Promise<{ started: boolean; executable?: string; port?: number; killed?: number; error?: string }> {
    const executable = resolveAntigravityExecutable();
    if (!executable) {
        return {
            started: false,
            error: "Antigravity executable not found. Set ANTIGRAVITY_EXECUTABLE.",
        };
    }

    const port = resolveLaunchPort();

    let killed = 0;
    if (params.killExisting !== false) {
        killed = await killExistingAntigravity(executable, params.log);
        if (killed > 0) {
            // Brief pause to let the OS release the port
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    const args = buildLaunchArgs({
        targetDir: params.targetDir,
        port,
    });

    try {
        let child;
        // On macOS, use 'open' command for .app bundles to ensure proper initialization
        if (process.platform === "darwin" && executable.endsWith(".app")) {
            // Extract app name from path (e.g., "/Applications/Antigravity.app" -> "Antigravity")
            const appName = path.basename(executable, ".app");
            child = spawn("open", ["-a", appName, "--args", ...args], {
                detached: true,
                stdio: "ignore",
                shell: false,
            });
        } else if (process.platform === "darwin" && executable.includes(".app/Contents/")) {
            // If executable points inside .app bundle, extract the .app path and use 'open'
            const appMatch = executable.match(/^(.+\.app)\//);
            if (appMatch) {
                const appPath = appMatch[1];
                const appName = path.basename(appPath, ".app");
                child = spawn("open", ["-a", appName, "--args", ...args], {
                    detached: true,
                    stdio: "ignore",
                    shell: false,
                });
            } else {
                // Fallback to direct execution
                child = spawn(executable, args, {
                    detached: true,
                    stdio: "ignore",
                    shell: false,
                });
            }
        } else {
            // Windows/Linux: direct execution
            child = spawn(executable, args, {
                detached: true,
                stdio: "ignore",
                shell: false,
            });
        }
        child.unref();
        params.log?.(
            `Launched Antigravity: executable='${executable}', port=${port}, targetDir='${params.targetDir}'`
        );
        return { started: true, executable, port, killed };
    } catch (error) {
        return {
            started: false,
            executable,
            port,
            killed,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
