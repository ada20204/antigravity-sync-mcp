/**
 * agy-tasks — async task runtime for the Antigravity CLI.
 *
 * Wraps enqueueAgyRun (globally serialized, cancellable) in a start/poll/cancel
 * model so long agy runs don't block the MCP call. Each task gets a run id; poll
 * returns a rolling tail while running and the full result once done.
 *
 * Design borrowed from bill-kopp-ai-dev/antigravity-cli-mcp (async task model),
 * but kept on our serialized lock so concurrent starts can't race agy.
 */

import {
    enqueueAgyRun,
    AgyCancelledError,
    type AgyRunOptions,
    type AgyRunResult,
} from "./agy-cli.js";

const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_RUNS = 50;

// NOTE: this CLI task model is deliberately independent from — and simpler than —
// the CDP path's AskTask / AskTaskStatus (task-runtime.ts). The CDP path tracks
// fine-grained phases (discovering/connecting/injecting/extracting) of a remote
// IDE session; the CLI path is a single PTY process, so these 5 states suffice.
// The divergence (incl. "done" here vs "completed" there) is intentional, not an
// accidental duplicate — the two backends have genuinely different lifecycles.
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskEntry {
    id: string;
    status: TaskStatus;
    prompt: string;
    startedAt: number;
    finishedAt?: number;
    result?: AgyRunResult;
    error?: string;
}

/** Byte-bounded rolling buffer: keeps only the most recent ~maxBytes of output. */
export class RollingBuffer {
    private chunks: string[] = [];
    private size = 0;
    constructor(private readonly maxBytes: number = DEFAULT_TAIL_BYTES) {}

    append(text: string): void {
        this.chunks.push(text);
        this.size += Buffer.byteLength(text, "utf8");
        while (this.size > this.maxBytes && this.chunks.length > 1) {
            this.size -= Buffer.byteLength(this.chunks.shift() as string, "utf8");
        }
    }

    tail(): string {
        return this.chunks.join("");
    }
}

interface ActiveRun {
    record: TaskEntry;
    cancel: () => void;
    buffer: RollingBuffer;
}

const active = new Map<string, ActiveRun>();
const finished = new Map<string, TaskEntry>(); // insertion order = LRU

function log(message: string): void {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    process.stderr.write(`[${ts}] [agy-task] ${message}\n`);
}

let counter = 0;
function nextRunId(): string {
    counter += 1;
    return `agy-${Date.now().toString(36)}-${counter}`;
}

function finalize(id: string, status: TaskStatus, result?: AgyRunResult, error?: string): void {
    const entry = active.get(id);
    const record = entry?.record ?? finished.get(id);
    if (!record) {
        log(`WARNING: finalize(${id}) found no record; terminal state lost`);
        return;
    }
    record.status = status;
    record.finishedAt = Date.now();
    log(`${id} -> ${status}`);
    if (result) record.result = result;
    if (error) record.error = error;
    active.delete(id);
    finished.set(id, record);
    while (finished.size > MAX_RUNS) {
        const oldest = finished.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        finished.delete(oldest);
    }
}

/** Start an async agy task. Returns a run id immediately; poll for the result. */
export function startTask(prompt: string, options: AgyRunOptions = {}): string {
    const id = nextRunId();
    const record: TaskEntry = { id, status: "queued", prompt, startedAt: Date.now() };
    const buffer = new RollingBuffer();
    log(`${id} queued`);

    const handle = enqueueAgyRun(prompt, {
        ...options,
        onProgress: (chunk) => {
            if (record.status === "queued") {
                record.status = "running";
                log(`${id} running`);
            }
            buffer.append(chunk);
            options.onProgress?.(chunk);
        },
    });

    active.set(id, { record, cancel: handle.cancel, buffer });

    handle.promise.then(
        (result) => finalize(id, "done", result),
        (err) => {
            const status = err instanceof AgyCancelledError ? "cancelled" : "failed";
            finalize(id, status, undefined, err instanceof Error ? err.message : String(err));
        }
    );

    return id;
}

export interface PollResult {
    id: string;
    status: TaskStatus;
    /** Rolling tail of output while running. */
    tail?: string;
    /** Full result once done. */
    result?: AgyRunResult;
    error?: string;
    startedAt: number;
    finishedAt?: number;
}

export function pollTask(id: string): PollResult | null {
    const entry = active.get(id);
    if (entry) {
        return {
            id,
            status: entry.record.status,
            tail: entry.buffer.tail(),
            startedAt: entry.record.startedAt,
        };
    }
    const record = finished.get(id);
    if (record) {
        return {
            id,
            status: record.status,
            result: record.result,
            error: record.error,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
        };
    }
    return null;
}

export type CancelOutcome = "cancelling" | "already-finished" | "not-found";

export function cancelTask(id: string): CancelOutcome {
    const entry = active.get(id);
    if (entry) {
        entry.cancel();
        return "cancelling";
    }
    if (finished.has(id)) return "already-finished";
    return "not-found";
}

export function listTasks(): TaskEntry[] {
    return [
        ...[...active.values()].map((entry) => entry.record),
        ...finished.values(),
    ];
}

/** Test-only: clear all task state. */
export function __resetTasksForTest(): void {
    active.clear();
    finished.clear();
    counter = 0;
}
