export type AskTaskStatus = "queued" | "discovering" | "connecting" | "injecting" | "running" | "extracting" | "completed" | "failed" | "cancelled";
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
export declare class RetryableError extends Error {
    constructor(message: string);
}
export declare function isTaskTerminal(status: AskTaskStatus): boolean;
export declare function createAskTask(prompt: string): AskTask;
export declare function transitionAskTask(task: AskTask, status: AskTaskStatus, note?: string): void;
export declare function incrementTaskAttempt(task: AskTask, phase: string): number;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>;
export declare function withRetry<T>(fn: () => Promise<T>, options: {
    maxAttempts: number;
    baseDelayMs: number;
    jitterMs?: number;
    isRetryable?: (err: unknown) => boolean;
    onRetry?: (ctx: {
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        error: unknown;
    }) => void;
}): Promise<T>;
//# sourceMappingURL=task-runtime.d.ts.map