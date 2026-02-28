import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_PORT = 9000;

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

function findWindowsExecutableCandidates(): string[] {
    const candidates: string[] = [];
    const usersRoot = "/mnt/c/Users";
    if (!fileExists(usersRoot)) return candidates;

    try {
        const users = fs.readdirSync(usersRoot, { withFileTypes: true });
        for (const user of users) {
            if (!user.isDirectory()) continue;
            candidates.push(
                path.posix.join(usersRoot, user.name, "AppData/Local/Programs/Antigravity/Antigravity.exe")
            );
            candidates.push(
                path.posix.join(usersRoot, user.name, "AppData/Local/Programs/Cursor/Cursor.exe")
            );
        }
    } catch {
        // best effort
    }
    return candidates;
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

    const linuxCandidates = [
        ...findWindowsExecutableCandidates(),
        "/mnt/c/Program Files/Antigravity/Antigravity.exe",
    ];
    return linuxCandidates.find((item) => fileExists(item));
}

export function buildLaunchArgs(params: { targetDir: string; port: number }): string[] {
    const args = [
        params.targetDir,
        "--new-window",
        `--remote-debugging-port=${params.port}`,
        "--remote-debugging-address=0.0.0.0",
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
    if (process.platform !== "win32") return 0;
    const exeName = path.win32.basename(executablePath);
    try {
        const { execSync } = await import("child_process");
        const out = execSync(
            `taskkill /IM "${exeName}" /F /T`,
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const killed = (out.match(/SUCCESS/gi) || []).length;
        log?.(`Killed ${killed} existing ${exeName} process(es)`);
        return killed;
    } catch {
        // No existing process — that's fine
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
        const child = spawn(executable, args, {
            detached: true,
            stdio: "ignore",
            shell: false,
        });
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

