#!/usr/bin/env node

/**
 * antigravity-mcp-server — Main Entry Point
 *
 * MCP server that bridges external AI agents to a local Antigravity
 * instance via Chrome DevTools Protocol (CDP).
 *
 * Architecture ported from:
 * - gemini-mcp-tool (MCP Server + StdioTransport + Progress Keepalive)
 * - OmniAntigravityRemoteChat (CDP Discovery + DOM Injection)
 * - auto-accept-agent (Auto-click confirmation dialogs)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolRequest,
    type ListToolsRequest,
    type Tool,
    type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { discoverCDP, connectCDP, type CDPConnection } from "./cdp.js";
import {
    injectMessage,
    pollCompletionStatus,
    extractLatestResponse,
    stopGeneration,
} from "./scripts.js";
import { autoAcceptPoll, DEFAULT_BANNED_COMMANDS } from "./auto-accept.js";
import {
    createAskTask,
    incrementTaskAttempt,
    isTaskTerminal,
    RetryableError,
    transitionAskTask,
    type AskTask,
    withRetry,
    withTimeout,
} from "./task-runtime.js";

// --- Constants ---

const KEEPALIVE_INTERVAL = 25000; // 25 seconds (from gemini-mcp-tool)
const POLL_INTERVAL = 1000; // 1 second
const MAX_TIMEOUT = 5 * 60 * 1000; // 5 minutes default
const DISCOVER_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 15000;
const INJECT_TIMEOUT_MS = 10000;
const EXTRACT_TIMEOUT_MS = 10000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const VERSION = "0.1.0";
let activeAskTask: AskTask | null = null;

// --- Logging ---

function log(msg: string) {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    process.stderr.write(`[${ts}] ${msg}\n`);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isTransientError(error: unknown): boolean {
    const msg = toErrorMessage(error).toLowerCase();
    return (
        msg.includes("timed out") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("socket hang up") ||
        msg.includes("network") ||
        msg.includes("busy")
    );
}

// --- MCP Server Setup ---

const server = new Server(
    { name: "antigravity-mcp-server", version: VERSION },
    {
        capabilities: {
            tools: {},
            logging: {},
        },
    }
);

// --- Tool Definitions ---

const TOOLS: Tool[] = [
    {
        name: "ask-antigravity",
        description:
            "Send a prompt to Antigravity and wait for the AI to complete its response. " +
            "Antigravity will autonomously accept file changes and run commands (with safety checks). " +
            "Returns the final AI response text.",
        inputSchema: {
            type: "object" as const,
            properties: {
                prompt: {
                    type: "string",
                    description: "The task or question to send to Antigravity",
                },
            },
            required: ["prompt"],
        },
    },
    {
        name: "antigravity-stop",
        description:
            "Stop the current AI generation in Antigravity. Use this to cancel a long-running task.",
        inputSchema: {
            type: "object" as const,
            properties: {},
        },
    },
    {
        name: "ping",
        description:
            "Test connectivity to the MCP server and check if Antigravity CDP is available.",
        inputSchema: {
            type: "object" as const,
            properties: {
                message: {
                    type: "string",
                    description: "Optional message to echo back",
                },
            },
        },
    },
];

// --- Progress Notification ---

async function sendProgressNotification(
    progressToken: string | number | undefined,
    progress: number,
    message: string
) {
    if (!progressToken) return;
    try {
        await server.notification({
            method: "notifications/progress",
            params: { progressToken, progress, message } as any,
        });
    } catch {
        // Client may not support progress
    }
}

// --- Tool Handlers ---

async function handleAskAntigravity(
    prompt: string,
    targetDir?: string,
    progressToken?: string | number
): Promise<string> {
    if (activeAskTask && !isTaskTerminal(activeAskTask.status)) {
        throw new Error(
            `Another ask-antigravity task is running (id=${activeAskTask.id}, status=${activeAskTask.status}). ` +
            "Wait for completion or call antigravity-stop first."
        );
    }

    const task = createAskTask(prompt);
    activeAskTask = task;
    const setStatus = (status: AskTask["status"], note?: string) => {
        transitionAskTask(task, status, note);
        const notePart = note ? ` (${note})` : "";
        log(`[${task.id}] status=${status}${notePart}`);
    };

    const onRetry = (phase: string) => (ctx: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => {
        log(
            `[${task.id}] ${phase} attempt ${ctx.attempt}/${ctx.maxAttempts} failed: ${toErrorMessage(ctx.error)}; ` +
            `retrying in ${ctx.delayMs}ms`
        );
    };

    let cdp: CDPConnection | null = null;

    try {
        // 1. Discover CDP
        setStatus("discovering");
        log(`[${task.id}] Discovering CDP target for ${targetDir || "default registry entry"}...`);
        await sendProgressNotification(progressToken, 0, "🔍 Discovering Antigravity...");

        const discovered = await withRetry(
            async () => {
                incrementTaskAttempt(task, "discover");
                const found = await withTimeout(discoverCDP(targetDir), DISCOVER_TIMEOUT_MS, "discoverCDP");
                if (!found) {
                    throw new RetryableError(
                        "CDP not found for target dir. Ensure Antigravity is running with debug ports enabled, " +
                        "and the sidecar extension has registered the workspace."
                    );
                }
                return found;
            },
            {
                maxAttempts: RETRY_MAX_ATTEMPTS,
                baseDelayMs: RETRY_BASE_DELAY_MS,
                onRetry: onRetry("discover"),
            }
        );
        log(`[${task.id}] Found target: ${discovered.target.title} on port ${discovered.port}`);

        // 2. Connect
        setStatus("connecting");
        await sendProgressNotification(progressToken, 5, "🔗 Connecting to Antigravity...");
        cdp = await withRetry(
            async () => {
                incrementTaskAttempt(task, "connect");
                try {
                    return await withTimeout(
                        connectCDP(discovered.target.webSocketDebuggerUrl),
                        CONNECT_TIMEOUT_MS,
                        "connectCDP"
                    );
                } catch (error) {
                    if (isTransientError(error)) {
                        throw new RetryableError(toErrorMessage(error));
                    }
                    throw error;
                }
            },
            {
                maxAttempts: RETRY_MAX_ATTEMPTS,
                baseDelayMs: RETRY_BASE_DELAY_MS,
                onRetry: onRetry("connect"),
            }
        );
        log(`[${task.id}] Connected. ${cdp.contexts.length} execution contexts available.`);
        const liveCdp = cdp;
        if (!liveCdp) {
            throw new Error("CDP connection was not established");
        }

        // 3. Inject message
        setStatus("injecting");
        log(`[${task.id}] Injecting prompt (${prompt.length} chars)...`);
        await sendProgressNotification(
            progressToken,
            10,
            "📝 Sending prompt to Antigravity..."
        );
        const injectResult = await withRetry(
            async () => {
                incrementTaskAttempt(task, "inject");
                const result = await withTimeout(
                    injectMessage(liveCdp, prompt),
                    INJECT_TIMEOUT_MS,
                    "injectMessage"
                );
                if (!result.ok) {
                    const reason = result.reason || result.error || "unknown";
                    if (reason === "busy" || reason === "editor_not_found" || reason === "no_context") {
                        throw new RetryableError(`inject failed: ${reason}`);
                    }
                    throw new Error(`Failed to inject message: ${reason}`);
                }
                return result;
            },
            {
                maxAttempts: RETRY_MAX_ATTEMPTS + 1,
                baseDelayMs: RETRY_BASE_DELAY_MS,
                onRetry: onRetry("inject"),
            }
        );
        log(`[${task.id}] Message injected via ${injectResult.method}`);

        // 4. Polling loop
        setStatus("running");
        log(`[${task.id}] Entering polling loop...`);
        const startTime = Date.now();
        let progressCount = 15;

        const progressMessages = [
            "🧠 Antigravity is analyzing your request...",
            "📊 Antigravity is processing and generating code...",
            "✨ Antigravity is writing changes...",
            "⏱️ Large task in progress (this is normal)...",
            "🔍 Still working... Antigravity takes time for quality results...",
        ];
        let msgIdx = 0;

        while (true) {
            const elapsed = Date.now() - startTime;

            // Timeout check
            if (elapsed > MAX_TIMEOUT) {
                log(`[${task.id}] Max timeout reached, extracting whatever is available...`);
                break;
            }

            // Poll completion status
            const status = await pollCompletionStatus(liveCdp);

            // Check if generation completed
            if (!status.isGenerating) {
                // Wait a bit more to ensure it's truly done (not just a brief pause)
                await new Promise((r) => setTimeout(r, 2000));
                const recheck = await pollCompletionStatus(liveCdp);
                if (!recheck.isGenerating) {
                    log(`[${task.id}] Generation complete.`);
                    break;
                }
            }

            // Progress keepalive (every ~25 seconds)
            if (elapsed % KEEPALIVE_INTERVAL < POLL_INTERVAL) {
                progressCount = Math.min(progressCount + 5, 90);
                const msg = progressMessages[msgIdx % progressMessages.length];
                await sendProgressNotification(
                    progressToken,
                    progressCount,
                    msg
                );
                msgIdx++;
            }

            // Wait before next poll
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        }

        // 5. Extract response
        setStatus("extracting");
        log(`[${task.id}] Extracting response...`);
        await sendProgressNotification(
            progressToken,
            95,
            "📋 Extracting Antigravity's response..."
        );
        const response = await withTimeout(
            extractLatestResponse(liveCdp, prompt),
            EXTRACT_TIMEOUT_MS,
            "extractLatestResponse"
        );
        setStatus("completed");

        // Final progress
        await sendProgressNotification(
            progressToken,
            100,
            "✅ Task complete"
        );

        return response;
    } catch (error) {
        setStatus("failed", toErrorMessage(error));
        throw error;
    } finally {
        if (cdp) {
            cdp.close();
            log(`[${task.id}] CDP connection closed.`);
        }
        activeAskTask = null;
    }
}

async function handleStop(targetDir?: string): Promise<string> {
    const discovered = await discoverCDP(targetDir);
    if (!discovered) {
        return "No Antigravity CDP target found for target directory.";
    }

    const cdp = await connectCDP(discovered.target.webSocketDebuggerUrl);
    try {
        const result = await stopGeneration(cdp);
        if (result.success) {
            if (activeAskTask && !isTaskTerminal(activeAskTask.status)) {
                transitionAskTask(activeAskTask, "cancelled", "stop requested");
            }
            return `Generation stopped successfully (method: ${result.method}).`;
        }
        return `Could not stop generation: ${result.error}`;
    } finally {
        cdp.close();
    }
}

async function handlePing(
    message?: string,
    targetDir?: string
): Promise<string> {
    const discovered = await discoverCDP(targetDir);
    const cdpStatus = discovered
        ? `Connected — ${discovered.target.title} on ${discovered.ip}:${discovered.port}`
        : "Not found — ensure Antigravity is running with debug ports";

    return [
        `antigravity-mcp-server v${VERSION}`,
        `CDP Status: ${cdpStatus}`,
        message ? `Echo: ${message}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

// --- Parse CLI Args ---
const argvTargetDirIndex = process.argv.indexOf("--target-dir");
const globalTargetDir = argvTargetDirIndex !== -1 ? process.argv[argvTargetDirIndex + 1] : undefined;

// --- MCP Request Handlers ---

server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
        return { tools: TOOLS };
    }
);

server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
        const toolName = request.params.name;
        const args = (request.params.arguments as Record<string, any>) || {};
        const progressToken = (request.params as any)._meta?.progressToken;

        log(`Tool invoked: ${toolName}`);

        try {
            let resultText: string;

            switch (toolName) {
                case "ask-antigravity":
                    if (!args.prompt || typeof args.prompt !== "string") {
                        throw new Error("Missing required argument: prompt");
                    }
                    resultText = await handleAskAntigravity(args.prompt, globalTargetDir, progressToken);
                    break;

                case "antigravity-stop":
                    resultText = await handleStop(globalTargetDir);
                    break;

                case "ping":
                    resultText = await handlePing(args.message, globalTargetDir);
                    break;

                default:
                    throw new Error(`Unknown tool: ${toolName}`);
            }

            return {
                content: [{ type: "text", text: resultText }],
                isError: false,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            log(`Error in tool '${toolName}': ${errorMessage}`);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
                isError: true,
            };
        }
    }
);

// --- Main ---

async function main() {
    log("Initializing antigravity-mcp-server...");
    // Keep stdio MCP server alive even when stdin starts paused in some Node runtimes.
    process.stdin.resume();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("antigravity-mcp-server listening on stdio");
}

main().catch((error) => {
    log(`Fatal error: ${error}`);
    process.exit(1);
});
