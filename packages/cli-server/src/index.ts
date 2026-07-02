#!/usr/bin/env node

/**
 * antigravity-cli-mcp — standalone MCP server for the Antigravity CLI (`agy`).
 *
 * Drives the agy binary directly as a subprocess (no IDE/CDP). Independent from
 * the CDP server (packages/server) — they only share this monorepo. Exposes the
 * sync ask tool and the async task model.
 */

import { pathToFileURL } from "url";
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

import { runAgyPrompt, buildChangeModePrompt } from "./agy-cli.js";
import { startTask, pollTask, cancelTask, listTasks } from "./agy-tasks.js";

const VERSION = "0.1.15";

const server = new Server(
    { name: "antigravity-cli-mcp", version: VERSION },
    { capabilities: { tools: {}, logging: {} } }
);

function log(msg: string): void {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    process.stderr.write(`[${ts}] [agy-cli-mcp] ${msg}\n`);
}

async function sendProgressNotification(
    progressToken: string | number | undefined,
    progress: number,
    message: string
): Promise<void> {
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

const TOOLS: Tool[] = [
    {
        name: "ask-antigravity-cli",
        description:
            "Send a prompt to the Antigravity CLI (`agy`) in headless print mode and return its reply. " +
            "Drives the `agy` binary directly as a subprocess (no IDE/CDP), so no workspace needs to be open.\n\n" +
            "Requirements: `agy` must be installed and already logged in (run `agy` once in a terminal to complete " +
            "Google OAuth).",
        inputSchema: {
            type: "object" as const,
            properties: {
                prompt: {
                    type: "string",
                    description: "The task or question to send to the Antigravity CLI. Use @path to reference files.",
                },
                model: {
                    type: "string",
                    description:
                        "Model for this run (must match a name from `agy models`, e.g. \"Gemini 3.1 Pro (High)\"). " +
                        "CAUTION: agy silently ignores unknown names and falls back to the active CLI model. " +
                        "Omit to use the active CLI model.",
                },
                workDir: {
                    type: "string",
                    description: "Absolute directory to add to agy's workspace (agy --add-dir), scoping the run to that directory.",
                },
                sandbox: {
                    type: "boolean",
                    description:
                        "REFUSED: agy --sandbox is a no-op in -p/print mode (no filesystem/network isolation). " +
                        "Passing true returns an error rather than giving a false sense of security.",
                },
                changeMode: {
                    type: "boolean",
                    description:
                        "Return structured OLD/NEW edit blocks (directly applicable) instead of free-form text (default false)",
                },
                timeoutMs: {
                    type: "number",
                    description: "Optional hard timeout in milliseconds (default 300000 = 5 minutes)",
                },
            },
            required: ["prompt"],
        },
    },
    {
        name: "start-antigravity-task",
        description:
            "Start a long-running Antigravity CLI task asynchronously and return a runId immediately " +
            "(non-blocking). Use this instead of ask-antigravity-cli for deep tasks that may take minutes. " +
            "Poll with poll-antigravity-task to get progress/result; cancel with cancel-antigravity-task. " +
            "Runs are globally serialized (agy is not concurrency-safe), so a started task may sit queued briefly.",
        inputSchema: {
            type: "object" as const,
            properties: {
                prompt: { type: "string", description: "The task to send to the Antigravity CLI. Use @path to reference files." },
                model: {
                    type: "string",
                    description:
                        "Model for this run (must match a name from `agy models`; agy silently ignores unknown names). " +
                        "Omit to use the active CLI model.",
                },
                workDir: { type: "string", description: "Absolute directory to add to agy's workspace (agy --add-dir)" },
                sandbox: { type: "boolean", description: "REFUSED: agy --sandbox is a no-op in -p mode; passing true returns an error" },
                changeMode: { type: "boolean", description: "Return structured OLD/NEW edit blocks instead of free-form text" },
                timeoutMs: { type: "number", description: "Optional hard timeout in ms (default 300000 = 5 minutes)" },
            },
            required: ["prompt"],
        },
    },
    {
        name: "poll-antigravity-task",
        description:
            "Poll an async Antigravity task by runId. While running: returns status + a rolling tail of output. " +
            "Once finished: returns status (done/failed/cancelled) + full result or error.",
        inputSchema: {
            type: "object" as const,
            properties: {
                runId: { type: "string", description: "The runId returned by start-antigravity-task" },
            },
            required: ["runId"],
        },
    },
    {
        name: "cancel-antigravity-task",
        description: "Cancel an async Antigravity task by runId (force-kills the agy process group if running).",
        inputSchema: {
            type: "object" as const,
            properties: {
                runId: { type: "string", description: "The runId returned by start-antigravity-task" },
            },
            required: ["runId"],
        },
    },
    {
        name: "list-antigravity-tasks",
        description: "List Antigravity CLI tasks (running + recent finished, newest-bounded LRU).",
        inputSchema: {
            type: "object" as const,
            properties: {},
        },
    },
];

async function handleAskAntigravityCli(
    params: { prompt: string; model?: string; workDir?: string; timeoutMs?: number; sandbox?: boolean; changeMode?: boolean },
    progressToken?: string | number
): Promise<string> {
    await sendProgressNotification(progressToken, 0, "🚀 Starting Antigravity CLI...");
    let progress = 5;
    let lastNotify = Date.now();
    const effectivePrompt = params.changeMode ? buildChangeModePrompt(params.prompt) : params.prompt;
    const result = await runAgyPrompt(effectivePrompt, {
        sandbox: params.sandbox === true,
        model: params.model,
        workDir: params.workDir,
        hardTimeoutMs:
            typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined,
        onProgress: () => {
            const now = Date.now();
            if (now - lastNotify < 2000) return;
            lastNotify = now;
            progress = Math.min(progress + 5, 90);
            void sendProgressNotification(progressToken, progress, "🧠 Antigravity CLI is responding...");
        },
    });
    await sendProgressNotification(progressToken, 100, "✅ Done");
    return result.timedOut
        ? `[Antigravity CLI timed out — partial reply below]\n\n${result.text}`
        : result.text;
}

function handleStartTask(params: {
    prompt: string;
    model?: string;
    workDir?: string;
    sandbox?: boolean;
    changeMode?: boolean;
    timeoutMs?: number;
}): string {
    const effectivePrompt = params.changeMode ? buildChangeModePrompt(params.prompt) : params.prompt;
    const runId = startTask(effectivePrompt, {
        sandbox: params.sandbox === true,
        model: params.model,
        workDir: params.workDir,
        hardTimeoutMs:
            typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined,
    });
    return JSON.stringify(
        { runId, status: "started", hint: "Poll with poll-antigravity-task using this runId." },
        null,
        2
    );
}

function handlePollTask(runId: string): string {
    const poll = pollTask(runId);
    if (!poll) return JSON.stringify({ runId, error: "not_found" }, null, 2);
    if (poll.status === "queued" || poll.status === "running") {
        return JSON.stringify({ runId, status: poll.status, tail: poll.tail ?? "" }, null, 2);
    }
    return JSON.stringify(
        {
            runId,
            status: poll.status,
            result: poll.result?.text,
            timedOut: poll.result?.timedOut,
            truncated: poll.result?.truncated,
            error: poll.error,
        },
        null,
        2
    );
}

function handleCancelTask(runId: string): string {
    return JSON.stringify({ runId, outcome: cancelTask(runId) }, null, 2);
}

function handleListTasks(): string {
    const tasks = listTasks().map((t) => ({
        id: t.id,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
    }));
    return JSON.stringify({ count: tasks.length, tasks }, null, 2);
}

server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => ({ tools: TOOLS })
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
                case "ask-antigravity-cli":
                    if (!args.prompt || typeof args.prompt !== "string") {
                        throw new Error("Missing required argument: prompt");
                    }
                    resultText = await handleAskAntigravityCli(
                        {
                            prompt: args.prompt,
                            model: typeof args.model === "string" && args.model ? args.model : undefined,
                            workDir: typeof args.workDir === "string" && args.workDir ? args.workDir : undefined,
                            sandbox: args.sandbox === true,
                            changeMode: args.changeMode === true,
                            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
                        },
                        progressToken
                    );
                    break;
                case "start-antigravity-task":
                    if (!args.prompt || typeof args.prompt !== "string") {
                        throw new Error("Missing required argument: prompt");
                    }
                    resultText = handleStartTask({
                        prompt: args.prompt,
                        model: typeof args.model === "string" && args.model ? args.model : undefined,
                        workDir: typeof args.workDir === "string" && args.workDir ? args.workDir : undefined,
                        sandbox: args.sandbox === true,
                        changeMode: args.changeMode === true,
                        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
                    });
                    break;
                case "poll-antigravity-task":
                    if (!args.runId || typeof args.runId !== "string") {
                        throw new Error("Missing required argument: runId");
                    }
                    resultText = handlePollTask(args.runId);
                    break;
                case "cancel-antigravity-task":
                    if (!args.runId || typeof args.runId !== "string") {
                        throw new Error("Missing required argument: runId");
                    }
                    resultText = handleCancelTask(args.runId);
                    break;
                case "list-antigravity-tasks":
                    resultText = handleListTasks();
                    break;
                default:
                    throw new Error(`Unknown tool: ${toolName}`);
            }
            return { content: [{ type: "text", text: resultText }], isError: false };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(`Error in tool '${toolName}': ${errorMessage}`);
            return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
        }
    }
);

async function main(): Promise<void> {
    log("Initializing antigravity-cli-mcp...");
    process.stdin.resume();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("antigravity-cli-mcp listening on stdio");
}

const isDirectRun = process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;

if (isDirectRun) {
    main().catch((error) => {
        log(`Fatal error: ${error}`);
        process.exit(1);
    });
}
