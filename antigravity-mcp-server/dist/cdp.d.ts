/**
 * CDP Discovery & Connection Module
 *
 * Ported from:
 * - OmniAntigravityRemoteChat/src/server.js (discoverCDP, connectCDP)
 * - auto-accept-agent/extension/main_scripts/cdp-handler.js (port ranges)
 */
import WebSocket from "ws";
export interface CDPTarget {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    type: string;
}
export interface ExecutionContext {
    id: number;
    name: string;
    origin: string;
}
export interface CDPConnection {
    ws: WebSocket;
    call: (method: string, params?: Record<string, unknown>) => Promise<any>;
    contexts: ExecutionContext[];
    close: () => void;
}
/**
 * Scan ports to find an Antigravity workbench CDP target.
 * Priority: ANTIGRAVITY_CDP_PORT env var > default 9000±3 > fallback 7800-7850
 */
export declare function discoverCDP(): Promise<{
    port: number;
    target: CDPTarget;
} | null>;
/**
 * Establish a CDP WebSocket connection.
 * Enables Runtime domain and tracks execution contexts.
 * Ported from OmniRemoteChat server.js lines 241-300.
 */
export declare function connectCDP(wsUrl: string): Promise<CDPConnection>;
/**
 * Try evaluating a script in every known execution context.
 * Returns the first successful non-error result.
 * Ported from Omni's captureSnapshot / injectMessage pattern.
 */
export declare function evaluateInAllContexts(cdp: CDPConnection, expression: string, awaitPromise?: boolean): Promise<any>;
//# sourceMappingURL=cdp.d.ts.map