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
import { type DiscoverCDPError } from "./cdp.js";
import { type AskTask } from "./task-runtime.js";
declare function claimWorkspaceTask(workspaceKey: string, task: AskTask): void;
declare function shouldAttemptColdStartLaunch(launchAttempted: boolean, errorCode: DiscoverCDPError["code"] | undefined): boolean;
declare function handleStop(targetDir?: string): Promise<string>;
declare function handleListWorkspaces(): Promise<string>;
export declare const __testExports: {
    activeAskTasks: Map<string, AskTask>;
    activeWorkspaceRoutes: Map<string, {
        wsUrl: string;
        workspaceKey: string;
    }>;
    claimWorkspaceTask: typeof claimWorkspaceTask;
    shouldAttemptColdStartLaunch: typeof shouldAttemptColdStartLaunch;
    handleStop: typeof handleStop;
    handleListWorkspaces: typeof handleListWorkspaces;
    NO_WORKSPACE_GUIDANCE: string;
};
export {};
//# sourceMappingURL=index.d.ts.map