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

// --- Constants ---

const KEEPALIVE_INTERVAL = 25000; // 25 seconds (from gemini-mcp-tool)
const POLL_INTERVAL = 1000; // 1 second
const MAX_TIMEOUT = 5 * 60 * 1000; // 5 minutes default
const VERSION = "0.1.0";

// --- Logging ---

function log(msg: string) {
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    process.stderr.write(`[${ts}] ${msg}\n`);
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
    progressToken?: string | number
): Promise<string> {
    // 1. Discover CDP
    log("Discovering CDP target...");
    await sendProgressNotification(progressToken, 0, "🔍 Discovering Antigravity...");

    const discovered = await discoverCDP();
    if (!discovered) {
        throw new Error(
            "CDP not found. Ensure Antigravity is running with debug ports enabled. " +
            "Default: port 9000. Or set ANTIGRAVITY_CDP_PORT environment variable."
        );
    }
    log(`Found target: ${discovered.target.title} on port ${discovered.port}`);

    // 2. Connect
    log("Connecting to CDP...");
    await sendProgressNotification(progressToken, 5, "🔗 Connecting to Antigravity...");
    const cdp = await connectCDP(discovered.target.webSocketDebuggerUrl);
    log(`Connected. ${cdp.contexts.length} execution contexts available.`);

    try {
        // 3. Inject message
        log(`Injecting prompt (${prompt.length} chars)...`);
        await sendProgressNotification(
            progressToken,
            10,
            "📝 Sending prompt to Antigravity..."
        );
        const injectResult = await injectMessage(cdp, prompt);

        if (!injectResult.ok) {
            throw new Error(
                `Failed to inject message: ${injectResult.reason || injectResult.error}`
            );
        }
        log(`Message injected via ${injectResult.method}`);

        // 4. Polling loop
        log("Entering polling loop...");
        const startTime = Date.now();
        let progressCount = 15;
        let totalAccepted = 0;
        let totalBlocked = 0;

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
                log("Max timeout reached, extracting whatever is available...");
                break;
            }

            // Poll completion status
            const status = await pollCompletionStatus(cdp);

            // Auto-accept any blocking dialogs
            const acceptResult = await autoAcceptPoll(cdp, DEFAULT_BANNED_COMMANDS);
            if (acceptResult.clicked > 0) {
                totalAccepted += acceptResult.clicked;
                log(`Auto-accepted ${acceptResult.clicked} action(s) (total: ${totalAccepted})`);
            }
            if (acceptResult.blocked > 0) {
                totalBlocked += acceptResult.blocked;
                log(`Blocked ${acceptResult.blocked} dangerous command(s) (total: ${totalBlocked})`);
            }

            // Check if generation completed
            if (!status.isGenerating) {
                // Wait a bit more to ensure it's truly done (not just a brief pause)
                await new Promise((r) => setTimeout(r, 2000));
                const recheck = await pollCompletionStatus(cdp);
                if (!recheck.isGenerating) {
                    log("Generation complete.");
                    break;
                }
            }

            // Progress keepalive (every ~25 seconds)
            if (elapsed % KEEPALIVE_INTERVAL < POLL_INTERVAL) {
                progressCount = Math.min(progressCount + 5, 90);
                const msg = progressMessages[msgIdx % progressMessages.length];
                const detail =
                    totalAccepted > 0 ? ` (auto-accepted ${totalAccepted} actions)` : "";
                await sendProgressNotification(
                    progressToken,
                    progressCount,
                    `${msg}${detail}`
                );
                msgIdx++;
            }

            // Wait before next poll
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        }

        // 5. Extract response
        log("Extracting response...");
        await sendProgressNotification(
            progressToken,
            95,
            "📋 Extracting Antigravity's response..."
        );
        const response = await extractLatestResponse(cdp);

        // Final progress
        await sendProgressNotification(
            progressToken,
            100,
            "✅ Task complete"
        );

        const summary =
            totalAccepted > 0 || totalBlocked > 0
                ? `\n\n[MCP Bridge: Auto-accepted ${totalAccepted} action(s), blocked ${totalBlocked} dangerous command(s)]`
                : "";

        return response + summary;
    } finally {
        cdp.close();
        log("CDP connection closed.");
    }
}

async function handleStop(): Promise<string> {
    const discovered = await discoverCDP();
    if (!discovered) {
        return "No Antigravity CDP target found.";
    }

    const cdp = await connectCDP(discovered.target.webSocketDebuggerUrl);
    try {
        const result = await stopGeneration(cdp);
        if (result.success) {
            return `Generation stopped successfully (method: ${result.method}).`;
        }
        return `Could not stop generation: ${result.error}`;
    } finally {
        cdp.close();
    }
}

async function handlePing(
    message?: string
): Promise<string> {
    const discovered = await discoverCDP();
    const cdpStatus = discovered
        ? `Connected — ${discovered.target.title} on port ${discovered.port}`
        : "Not found — ensure Antigravity is running with debug ports";

    return [
        `antigravity-mcp-server v${VERSION}`,
        `CDP Status: ${cdpStatus}`,
        message ? `Echo: ${message}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

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
                    resultText = await handleAskAntigravity(args.prompt, progressToken);
                    break;

                case "antigravity-stop":
                    resultText = await handleStop();
                    break;

                case "ping":
                    resultText = await handlePing(args.message);
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("antigravity-mcp-server listening on stdio");
}

main().catch((error) => {
    log(`Fatal error: ${error}`);
    process.exit(1);
});
