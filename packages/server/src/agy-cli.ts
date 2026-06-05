/**
 * agy-cli — drive the Antigravity CLI (`agy`) in print mode and capture its reply.
 *
 * Why a PTY is required (and gemini-mcp-tool gets away without one):
 * `agy -p` writes nothing and never exits when stdin/stdout are not a TTY — it
 * only produces output under a real pseudo-terminal, unlike gemini CLI which
 * supports headless pipes. Even under a PTY, agy keeps running after printing
 * its answer, so we detect completion by output going idle, then kill it.
 *
 * Uses node-pty (a Node addon) to keep this a pure-TypeScript implementation
 * with no external interpreter at runtime.
 */

import * as pty from "node-pty";
import { execFile } from "child_process";
import { existsSync, statSync, chmodSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

// Last agy version this wrapper was verified against. agy ships a private,
// fast-moving format; warn (once, non-blocking) if the local binary differs so
// breakage from upstream changes is loud rather than silent.
const VERIFIED_AGY_VERSION = "1.0.5";
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
                "PTY/print behavior may have changed."
            );
        }
    });
}

/**
 * node-pty ships a prebuilt `spawn-helper`, but npm extraction can drop its
 * executable bit, which makes pty.spawn fail with "posix_spawnp failed". Restore
 * the bit best-effort before the first spawn so deploys self-heal after install.
 */
let spawnHelperChecked = false;
function ensureSpawnHelperExecutable(): void {
    if (spawnHelperChecked || process.platform === "win32") return;
    spawnHelperChecked = true;
    try {
        const requireFromHere = createRequire(import.meta.url);
        const ptyRoot = path.resolve(path.dirname(requireFromHere.resolve("node-pty")), "..");
        const helper = path.join(
            ptyRoot,
            "prebuilds",
            `${process.platform}-${process.arch}`,
            "spawn-helper"
        );
        if (existsSync(helper) && !(statSync(helper).mode & 0o111)) {
            chmodSync(helper, 0o755);
        }
    } catch {
        // best-effort; spawn will surface a clear error if the helper is unusable
    }
}

/**
 * Resolve the `agy` executable. node-pty does not use a shell, so a bare "agy"
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
    /** Idle window (ms) with no new output before the reply is considered complete. */
    idleMs?: number;
    /** Hard ceiling (ms) for the whole run. */
    hardTimeoutMs?: number;
    /**
     * Pass agy --sandbox (terminal restrictions). NOTE: community testing reports
     * --sandbox is effectively a no-op in -p/print mode (does not constrain FS/network),
     * so it is NOT a real security boundary — do not rely on it for isolation.
     */
    sandbox?: boolean;
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

/** Handle for an in-flight agy run: its eventual result plus a cancel trigger. */
export interface AgyRunHandle {
    promise: Promise<AgyRunResult>;
    cancel: () => void;
}

const DEFAULT_IDLE_MS = 3000;
const DEFAULT_HARD_MS = 5 * 60 * 1000;
const PRINT_TIMEOUT_MARGIN_S = 10;
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024; // 10MB cap; stop appending past this to avoid OOM

/**
 * Interpret captured PTY output into a result, or throw a typed error.
 * Pure function (no I/O) so the auth/timeout/empty branches are unit-testable.
 */
export function interpretAgyResult(raw: string, timedOut: boolean): AgyRunResult {
    const text = stripAnsi(raw).trim();
    if (/Authentication required\.|Waiting for authentication/.test(text)) {
        throw new AgyAuthRequiredError();
    }
    if (/Error:\s*timed out waiting for response/i.test(text)) {
        throw new AgyTimeoutError();
    }
    if (!text && !timedOut) {
        throw new Error("agy CLI produced no reply: no output captured");
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
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    const hardMs = options.hardTimeoutMs ?? DEFAULT_HARD_MS;
    const printTimeoutS = Math.max(5, Math.ceil(hardMs / 1000) - PRINT_TIMEOUT_MARGIN_S);

    let cancelImpl: () => void = () => {};
    const promise = new Promise<AgyRunResult>((resolve, reject) => {
        ensureSpawnHelperExecutable();
        const agyBin = resolveAgyBin();
        checkAgyVersion(agyBin);
        const agyArgs = ["--print-timeout", `${printTimeoutS}s`];
        if (options.sandbox) agyArgs.push("--sandbox");
        agyArgs.push("-p", prompt);
        let child: pty.IPty;
        try {
            child = pty.spawn(agyBin, agyArgs, {
                name: "xterm-color",
                cols: 120,
                rows: 40,
                env: process.env as Record<string, string>,
            });
        } catch (error) {
            reject(
                new Error(
                    `Failed to spawn agy via PTY (resolved bin: ${agyBin}): ${(error as Error).message}. ` +
                    "Ensure agy is installed, or set AGY_BIN to its absolute path."
                )
            );
            return;
        }

        let raw = "";
        let settled = false;
        let sawOutput = false;
        let lastDataAt = Date.now();
        let timedOut = false;
        let truncated = false;
        let cancelled = false;

        // agy ignores gentle signals (node-pty's default SIGHUP leaves it running),
        // so go straight to SIGKILL. agy may fork children (git, language tools);
        // node-pty children are session leaders (pgid == pid), so kill the whole
        // process group via -pid first, then the leader + raw pid as backstops.
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
            if (pid) {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    // already gone
                }
            }
        };

        const finish = () => {
            if (settled) return;
            settled = true;
            clearInterval(idleTimer);
            clearTimeout(hardTimer);
            forceKill();
            if (cancelled) {
                reject(new AgyCancelledError());
                return;
            }
            try {
                resolve({ ...interpretAgyResult(raw, timedOut), truncated });
            } catch (error) {
                reject(error);
            }
        };
        cancelImpl = () => {
            cancelled = true;
            finish();
        };

        const idleTimer = setInterval(() => {
            if (sawOutput && Date.now() - lastDataAt > idleMs) finish();
        }, 500);

        const hardTimer = setTimeout(() => {
            timedOut = true;
            finish();
        }, hardMs);

        child.onData((chunk: string) => {
            sawOutput = true;
            lastDataAt = Date.now();
            if (!truncated) {
                raw += chunk;
                if (raw.length > MAX_OUTPUT_CHARS) {
                    raw = raw.slice(0, MAX_OUTPUT_CHARS);
                    truncated = true;
                }
            }
            options.onProgress?.(chunk);
        });

        child.onExit(() => {
            finish();
        });
    });

    return { promise, cancel: () => cancelImpl() };
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
