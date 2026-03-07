const TERMINAL_STATUSES = new Set([
    "completed",
    "failed",
    "cancelled",
]);
export class RetryableError extends Error {
    constructor(message) {
        super(message);
        this.name = "RetryableError";
    }
}
export function isTaskTerminal(status) {
    return TERMINAL_STATUSES.has(status);
}
export function createAskTask(prompt) {
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
export function transitionAskTask(task, status, note) {
    const now = Date.now();
    task.status = status;
    task.updatedAt = now;
    task.history.push({ status, ts: now, note });
    if (status === "failed" && note) {
        task.lastError = note;
    }
}
export function incrementTaskAttempt(task, phase) {
    const next = (task.attempts[phase] || 0) + 1;
    task.attempts[phase] = next;
    return next;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function withTimeout(promise, timeoutMs, label) {
    let timeoutId;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
}
export async function withRetry(fn, options) {
    const { maxAttempts, baseDelayMs, jitterMs = 100, isRetryable = (err) => err instanceof RetryableError, onRetry, } = options;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
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
//# sourceMappingURL=task-runtime.js.map