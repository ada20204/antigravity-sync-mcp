/**
 * CDP Registry Routing & Connection Module
 *
 * Replaces the previous port-scanning logic.
 * Now reads the CDP port for a specific target directory
 * from the registry managed by antigravity-mcp-sidecar.
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
export interface RegistryQuotaModel {
    label?: string;
    modelId?: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted?: boolean;
    isSelected?: boolean;
    resetTime?: string;
    resetInMs?: number;
}
export interface RegistryQuotaSnapshot {
    timestamp?: number;
    source?: string;
    promptCredits?: {
        available?: number;
        monthly?: number;
        usedPercentage?: number;
        remainingPercentage?: number;
    };
    models?: RegistryQuotaModel[];
    activeModelId?: string;
    lastError?: string;
}
export interface RegistryLsEndpoint {
    port?: number;
    csrfToken?: string;
    lastDetectedAt?: number;
    sourceHost?: string;
}
export interface RegistryV1Endpoint {
    host?: string;
    port?: number;
    mode?: string;
}
export interface RegistryV1QuotaMeta {
    source?: string;
    stale?: boolean;
    refreshed_at?: number;
    refresh_interval_ms?: number;
}
export interface RegistryEntry {
    schema_version?: number;
    protocol?: {
        schema_version?: number;
        compatible_schema_versions?: number[];
        writer_role?: string;
        writer_node_id?: string;
        updated_at?: number;
    };
    workspace_id?: string;
    original_workspace_id?: string;
    workspace_paths?: {
        normalized?: string;
        raw?: string;
    };
    node_id?: string;
    role?: string;
    source_of_truth?: string;
    source_endpoint?: RegistryV1Endpoint;
    local_endpoint?: RegistryV1Endpoint;
    state?: string;
    verified_at?: number;
    ttl_ms?: number;
    priority?: number;
    quota_meta?: RegistryV1QuotaMeta;
    last_error?: {
        code?: string;
        message?: string;
        at?: number;
        details?: Record<string, unknown>;
    };
    port?: number;
    ip?: string;
    pid?: number;
    lastActive?: number;
    ls?: RegistryLsEndpoint;
    quota?: RegistryQuotaSnapshot;
    quotaError?: string;
    cdp?: RegistryCdpState;
}
export interface RegistryCdpCandidate {
    host?: string;
    port?: number;
}
export interface RegistryCdpProbeItem {
    host?: string;
    port?: number;
    stage?: string;
    ok?: boolean;
    source?: string;
    error?: string;
}
export interface RegistryCdpActiveEndpoint {
    host?: string;
    port?: number;
    source?: string;
    verifiedAt?: number;
}
export interface RegistryCdpState {
    generation?: number;
    state?: "idle" | "probing" | "ready" | "error" | string;
    updatedAt?: number;
    verifiedAt?: number;
    active?: RegistryCdpActiveEndpoint;
    candidates?: RegistryCdpCandidate[];
    probeSummary?: RegistryCdpProbeItem[];
    lastError?: string;
}
export interface DiscoveredCDP {
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
}
export type DiscoverErrorCode = "registry_missing" | "workspace_not_found" | "schema_mismatch" | "entry_not_ready" | "entry_stale" | "endpoint_missing" | "endpoint_unreachable" | "cdp_target_not_found" | "invalid_env_port";
export interface DiscoverCDPError {
    code: DiscoverErrorCode;
    message: string;
    workspaceId?: string;
    state?: string;
    details?: Record<string, unknown>;
}
export interface DiscoverCDPResult {
    ok: boolean;
    discovered?: DiscoveredCDP;
    error?: DiscoverCDPError;
}
export declare function computeWorkspaceId(rawPath: string): string;
export declare function discoverCDPDetailed(targetDir?: string): Promise<DiscoverCDPResult>;
export declare function discoverCDP(targetDir?: string): Promise<{
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
} | null>;
export declare function connectCDP(wsUrl: string): Promise<CDPConnection>;
export declare function evaluateInAllContexts(cdp: CDPConnection, expression: string, awaitPromise?: boolean): Promise<any>;
//# sourceMappingURL=cdp.d.ts.map