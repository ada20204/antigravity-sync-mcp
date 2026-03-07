export type AskTaskStatus =
    | "queued"
    | "discovering"
    | "connecting"
    | "injecting"
    | "running"
    | "extracting"
    | "completed"
    | "failed"
    | "cancelled";

export interface AskTaskHistoryEntry {
    status: AskTaskStatus;
    ts: number;
    note?: string;
}

export interface AskTask {
    id: string;
    status: AskTaskStatus;
    promptLength: number;
    createdAt: number;
    updatedAt: number;
    history: AskTaskHistoryEntry[];
    attempts: Record<string, number>;
    lastError?: string;
}

const TERMINAL_STATUSES: ReadonlySet<AskTaskStatus> = new Set([
    "completed",
    "failed",
    "cancelled",
]);

export class RetryableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RetryableError";
    }
}

export function isTaskTerminal(status: AskTaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

export function createAskTask(prompt: string): AskTask {
    const now = Date.now();
    const id = `ask-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        id,
        status: "queued",
        promptLength: prompt.length,
        createdAt: now,
        updatedAt: now,
        history: [{ status: "queued", ts: now }],
        attempts: {},
    };
}

export function transitionAskTask(task: AskTask, status: AskTaskStatus, note?: string): void {
    const now = Date.now();
    task.status = status;
    task.updatedAt = now;
    task.history.push({ status, ts: now, note });
    if (status === "failed" && note) {
        task.lastError = note;
    }
}

export function incrementTaskAttempt(task: AskTask, phase: string): number {
    const next = (task.attempts[phase] || 0) + 1;
    task.attempts[phase] = next;
    return next;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxAttempts: number;
        baseDelayMs: number;
        jitterMs?: number;
        isRetryable?: (err: unknown) => boolean;
        onRetry?: (ctx: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
    }
): Promise<T> {
    const {
        maxAttempts,
        baseDelayMs,
        jitterMs = 100,
        isRetryable = (err: unknown) => err instanceof RetryableError,
        onRetry,
    } = options;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isRetryable(err) || attempt >= maxAttempts) {
                throw err;
            }

            const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
            onRetry?.({ attempt, maxAttempts, delayMs, error: err });
            await sleep(delayMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
