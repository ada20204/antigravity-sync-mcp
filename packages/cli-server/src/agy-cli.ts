/**
 * agy-cli — drive the Antigravity CLI (`agy`) in print mode and capture its reply.
 *
 * Runs `agy -p` as a plain subprocess with stdin closed (stdio "ignore" = EOF).
 * With a clean end-of-input, agy prints its full reply to stdout and SELF-EXITS
 * on completion — that process exit is a deterministic completion signal, so no
 * pseudo-terminal and no idle heuristic are needed. (Closing stdin is the key;
 * the earlier "non-TTY hangs / empty stdout" symptom was a missing stdin EOF.)
 */

import { spawn, execFile } from "child_process";
import { existsSync } from "fs";
import os from "os";
import path from "path";

// Last agy version this wrapper was verified against. agy ships a private,
// fast-moving format; warn (once, non-blocking) if the local binary differs so
// breakage from upstream changes is loud rather than silent.
const VERIFIED_AGY_VERSION = "1.0.15";
let versionChecked = false;

function logAgy(message: string): void {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    process.stderr.write(`[${ts}] [agy-cli] ${message}\n`);
}

function checkAgyVersion(bin: string): void {
    if (versionChecked) return;
    versionChecked = true;
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
            logAgy(`WARNING: could not probe agy version: ${err.message}`);
            return;
        }
        const version = stdout.trim().split(/\s+/).pop() ?? "";
        if (version && version !== VERIFIED_AGY_VERSION) {
            logAgy(
                `WARNING: agy ${version} differs from verified ${VERIFIED_AGY_VERSION}; ` +
                "print behavior may have changed."
            );
        }
    });
}

/**
 * Resolve the `agy` executable. spawn does not use a shell, so a bare "agy"
 * fails unless it is on the launching process's PATH — which often excludes
 * ~/.local/bin under a GUI-launched MCP host. Honor AGY_BIN, then search PATH
 * plus common install dirs.
 */
let cachedAgyBin: string | null = null;
export function resolveAgyBin(): string {
    if (cachedAgyBin) return cachedAgyBin;
    const override = process.env.AGY_BIN;
    if (override && existsSync(override)) {
        cachedAgyBin = override;
        return override;
    }
    const dirs = [
        ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
        path.join(os.homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ];
    for (const dir of dirs) {
        if (!dir) continue;
        const candidate = path.join(dir, "agy");
        if (existsSync(candidate)) {
            cachedAgyBin = candidate;
            return candidate;
        }
    }
    return "agy"; // last resort; spawn will fail with a clear error
}

// Strip ANSI escape sequences a PTY injects (cursor moves, colors, OSC).
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(/\r/g, "");
}

export interface AgyRunOptions {
    /** Hard ceiling (ms) for the whole run. */
    hardTimeoutMs?: number;
    /**
     * Pass agy --sandbox (terminal restrictions). NOTE: community testing reports
     * --sandbox is effectively a no-op in -p/print mode (does not constrain FS/network),
     * so it is NOT a real security boundary — do not rely on it for isolation.
     */
    sandbox?: boolean;
    /**
     * Model for this run (agy --model). Must match a name from `agy models`
     * (e.g. "Gemini 3.1 Pro (High)"); agy SILENTLY ignores unknown names and
     * falls back to the active CLI model — it does not error.
     */
    model?: string;
    /** Directory to add to agy's workspace (agy --add-dir). */
    workDir?: string;
    /** Streaming progress callback with newly captured (raw) output. */
    onProgress?: (chunk: string) => void;
}

export interface AgyRunResult {
    text: string;
    raw: string;
    timedOut: boolean;
    /** True if output exceeded MAX_OUTPUT_CHARS and was truncated. */
    truncated?: boolean;
}

export class AgyAuthRequiredError extends Error {
    constructor() {
        super(
            "Antigravity CLI is not authenticated. Run `agy` in a terminal once to complete " +
            "Google OAuth login, then retry."
        );
        this.name = "AgyAuthRequiredError";
    }
}

export class AgyTimeoutError extends Error {
    constructor() {
        super(
            "Antigravity CLI timed out before completing (agy --print-timeout fired). " +
            "The task is likely too deep for the current model — try a larger timeoutMs or a simpler prompt."
        );
        this.name = "AgyTimeoutError";
    }
}

export class AgyCancelledError extends Error {
    constructor() {
        super("Antigravity CLI run was cancelled.");
        this.name = "AgyCancelledError";
    }
}

export class AgySandboxUnsupportedError extends Error {
    constructor() {
        super(
            "agy --sandbox is a no-op in -p/print mode (does not constrain filesystem or network). " +
            "Refusing to pass it so callers are not given a false sense of isolation. " +
            "Remove the sandbox flag, or run agy under a real OS-level sandbox."
        );
        this.name = "AgySandboxUnsupportedError";
    }
}

/** Handle for an in-flight agy run: its eventual result plus a cancel trigger. */
export interface AgyRunHandle {
    promise: Promise<AgyRunResult>;
    cancel: () => void;
}

const DEFAULT_HARD_MS = 5 * 60 * 1000;
const PRINT_TIMEOUT_MARGIN_S = 10;
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024; // 10MB cap; stop appending past this to avoid OOM

/**
 * Interpret captured output into a result, or throw a typed error.
 * Pure function (no I/O) so the auth/timeout/empty branches are unit-testable.
 * stderrTail is included in the empty-output error: agy intermittently
 * self-exits with empty stdout, and its stderr is the only diagnostic.
 */
export function interpretAgyResult(raw: string, timedOut: boolean, stderrTail = ""): AgyRunResult {
    const text = stripAnsi(raw).trim();
    if (/Authentication required\.|Waiting for authentication/.test(text)) {
        throw new AgyAuthRequiredError();
    }
    if (/Error:\s*timed out waiting for response/i.test(text)) {
        throw new AgyTimeoutError();
    }
    if (!text && !timedOut) {
        const stderr = stripAnsi(stderrTail).trim();
        throw new Error(
            "agy CLI produced no reply: no output captured" +
            (stderr ? `. agy stderr tail:\n${stderr}` : "")
        );
    }
    return { text, raw, timedOut };
}

// agy is not concurrency-safe: every call rewrites the shared top-level index
// files (~/.gemini/antigravity-cli/cache/last_conversations.json + history.jsonl),
// so parallel runs race and one silently yields no output (verified: 3 concurrent
// -> 1 dropped). A global mutex serializes ALL agy runs (sync + async task model).
let mutexTail: Promise<void> = Promise.resolve();
function acquireAgyLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
        release = resolve;
    });
    const wait = mutexTail.then(() => release);
    mutexTail = mutexTail.then(() => next);
    return wait;
}

/**
 * Enqueue an agy run behind the global serialization lock and return a handle.
 * cancel() works both while queued (skips execution) and while running (kills agy).
 */
export function enqueueAgyRun(prompt: string, options: AgyRunOptions = {}): AgyRunHandle {
    // Refuse --sandbox up front: it is a no-op in -p mode, so accepting it would
    // hand back a false sense of isolation. Fail loud instead of pretending.
    if (options.sandbox) {
        return { promise: Promise.reject(new AgySandboxUnsupportedError()), cancel: () => {} };
    }
    let cancelled = false;
    let activeCancel: (() => void) | null = null;
    const cancel = () => {
        cancelled = true;
        activeCancel?.();
    };
    const promise = (async () => {
        const release = await acquireAgyLock();
        try {
            if (cancelled) throw new AgyCancelledError();
            const handle = startAgyRun(prompt, options);
            activeCancel = handle.cancel;
            return await handle.promise;
        } finally {
            release();
        }
    })();
    return { promise, cancel };
}

/**
 * Run a single prompt and return the cleaned reply (serialized, sync-style).
 */
export function runAgyPrompt(prompt: string, options: AgyRunOptions = {}): Promise<AgyRunResult> {
    return enqueueAgyRun(prompt, options).promise;
}

/**
 * Start a single `agy -p` run in a PTY. Returns a handle exposing the eventual
 * result and a cancel() that force-kills the run. NOT serialized and intentionally
 * NOT exported: external callers must use enqueueAgyRun / runAgyPrompt so the
 * global concurrency guard is never bypassed.
 */
function startAgyRun(prompt: string, options: AgyRunOptions = {}): AgyRunHandle {
    const hardMs = options.hardTimeoutMs ?? DEFAULT_HARD_MS;
    const printTimeoutS = Math.max(5, Math.ceil(hardMs / 1000) - PRINT_TIMEOUT_MARGIN_S);

    let cancelImpl: () => void = () => {};
    const promise = new Promise<AgyRunResult>((resolve, reject) => {
        const agyBin = resolveAgyBin();
        checkAgyVersion(agyBin);
        // sandbox refused at enqueue time. stdin is closed (ignore = EOF) so agy
        // gets a clean end-of-input and SELF-EXITS on completion — that process
        // exit is our deterministic completion signal. No idle heuristic, no PTY.
        const agyArgs = ["--print-timeout", `${printTimeoutS}s`];
        if (options.workDir) agyArgs.push("--add-dir", options.workDir);
        if (options.model) agyArgs.push("--model", options.model);
        agyArgs.push("-p", prompt);
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(agyBin, agyArgs, {
                stdio: ["ignore", "pipe", "pipe"],
                detached: true, // own process group, so -pid kills agy + its children
                env: process.env,
            });
        } catch (error) {
            reject(
                new Error(
                    `Failed to spawn agy (resolved bin: ${agyBin}): ${(error as Error).message}. ` +
                    "Ensure agy is installed, or set AGY_BIN to its absolute path."
                )
            );
            return;
        }

        let raw = "";
        let stderrTail = "";
        let settled = false;
        let timedOut = false;
        let truncated = false;
        let cancelled = false;

        // agy may fork children (git, language tools). Spawned detached, so kill
        // the whole process group via -pid, then the pid itself as a backstop.
        const forceKill = () => {
            const pid = child.pid;
            if (pid) {
                try {
                    process.kill(-pid, "SIGKILL");
                } catch {
                    // group already gone
                }
            }
            try {
                child.kill("SIGKILL");
            } catch {
                // already gone
            }
        };

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            if (cancelled) {
                reject(new AgyCancelledError());
                return;
            }
            try {
                resolve({ ...interpretAgyResult(raw, timedOut, stderrTail), truncated });
            } catch (error) {
                reject(error);
            }
        };
        cancelImpl = () => {
            cancelled = true;
            forceKill();
            finish();
        };

        const hardTimer = setTimeout(() => {
            timedOut = true;
            forceKill();
            finish();
        }, hardMs);

        child.stdout?.on("data", (d: Buffer) => {
            const chunk = d.toString();
            if (!truncated) {
                raw += chunk;
                if (raw.length > MAX_OUTPUT_CHARS) {
                    raw = raw.slice(0, MAX_OUTPUT_CHARS);
                    truncated = true;
                }
            }
            options.onProgress?.(chunk);
        });

        // Keep only the last ~2KB of stderr: enough for agy's final error line
        // without buffering a whole debug log.
        child.stderr?.on("data", (d: Buffer) => {
            stderrTail = (stderrTail + d.toString()).slice(-2048);
        });

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            reject(
                new Error(
                    `Failed to spawn agy (resolved bin: ${agyBin}): ${error.message}. ` +
                    "Ensure agy is installed, or set AGY_BIN to its absolute path."
                )
            );
        });

        // Process exit = deterministic completion. No idle heuristic needed.
        child.on("close", () => finish());
    });

    return { promise, cancel: () => cancelImpl() };
}

/**
 * Parse `agy models` output into a list of model names.
 * Pure function (no I/O) so it is unit-testable.
 */
export function parseAgyModelsOutput(stdout: string): string[] {
    return stdout
        .split("\n")
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean);
}

/**
 * List the models the local agy CLI can use (`agy models`).
 * Read-only and near-instant; does not touch conversation state, so it is
 * intentionally NOT serialized behind the global agy mutex.
 * stdin MUST be closed (stdio "ignore"), same contract as the -p path: with an
 * open stdin pipe `agy models` blocks waiting for input instead of exiting.
 */
export function listAgyModels(timeoutMs = 15000): Promise<string[]> {
    const agyBin = resolveAgyBin();
    return new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(agyBin, ["models"], {
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
            });
        } catch (error) {
            reject(
                new Error(
                    `Failed to list agy models (resolved bin: ${agyBin}): ${(error as Error).message}. ` +
                    "Ensure agy is installed, or set AGY_BIN to its absolute path."
                )
            );
            return;
        }

        let stdout = "";
        let stderrTail = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            reject(new Error(`agy models timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2048); });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(
                new Error(
                    `Failed to list agy models (resolved bin: ${agyBin}): ${error.message}. ` +
                    "Ensure agy is installed, or set AGY_BIN to its absolute path."
                )
            );
        });
        child.on("close", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const models = parseAgyModelsOutput(stdout);
            if (models.length === 0) {
                const stderr = stripAnsi(stderrTail).trim();
                reject(new Error("agy models produced no output" + (stderr ? `. agy stderr tail:\n${stderr}` : "")));
                return;
            }
            resolve(models);
        });
    });
}

const CHANGE_MODE_INSTRUCTIONS = `[CHANGEMODE INSTRUCTIONS]
You are generating code modifications that will be processed by an automated system.
The output format is critical because it enables programmatic application of changes.

CRITICAL REQUIREMENTS:
1. Output edits in the EXACT format below — no deviations.
2. The OLD string MUST be findable with Ctrl+F — a unique, exact match.
3. Include enough surrounding lines to make the OLD string unique.
4. Copy the OLD content EXACTLY as it appears — whitespace, indentation, line breaks.
5. Never use partial lines — always include complete lines.

OUTPUT FORMAT (follow exactly):
**FILE: [filename]:[line_number]**
\`\`\`
OLD:
[exact code to be replaced - must match file content precisely]
NEW:
[new code to insert - complete and functional]
\`\`\`

EXAMPLE:
**FILE: src/utils/helper.js:100**
\`\`\`
OLD:
function getMessage() {
  return "Hello World";
}
NEW:
function getMessage() {
  return "Hello Universe!";
}
\`\`\`

USER REQUEST:
`;

/**
 * Wrap a user prompt with structured-edit (changeMode) instructions so agy
 * returns OLD/NEW edit blocks an agent can apply directly. Mirrors the
 * gemini-mcp-tool changeMode contract. `file:path` is normalized to `@path`.
 */
export function buildChangeModePrompt(userPrompt: string): string {
    const normalized = userPrompt.replace(/file:(\S+)/g, "@$1");
    return CHANGE_MODE_INSTRUCTIONS + normalized + "\n";
}
