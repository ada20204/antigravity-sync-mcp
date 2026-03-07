// Registry and CDP types shared across packages

/** A Chrome DevTools Protocol browser target (tab/page/worker). */
export interface CDPTarget {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    type: string;
}

/** A V8 execution context within a CDP target. */
export interface ExecutionContext {
    id: number;
    name: string;
    origin: string;
}

/** An active CDP WebSocket connection with a helper call() method. */
export interface CDPConnection {
    ws: unknown; // WebSocket — typed as unknown to avoid ws dependency in core
    call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    contexts: ExecutionContext[];
    close: () => void;
}

/** Per-model quota information from the Antigravity quota snapshot. */
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

/** A point-in-time snapshot of quota usage reported by the Antigravity sidecar. */
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

/** The /ls endpoint descriptor stored in a registry entry. */
export interface RegistryLsEndpoint {
    port?: number;
    csrfToken?: string;
    lastDetectedAt?: number;
    sourceHost?: string;
}

/** A v1 network endpoint (host + port + optional mode). */
export interface RegistryV1Endpoint {
    host?: string;
    port?: number;
    mode?: string;
}

/** Metadata about the last quota refresh for a registry entry. */
export interface RegistryV1QuotaMeta {
    source?: string;
    stale?: boolean;
    refreshed_at?: number;
    refresh_interval_ms?: number;
}

/** A candidate CDP endpoint discovered during probing. */
export interface RegistryCdpCandidate {
    host?: string;
    port?: number;
}

/** Result of a single CDP probe attempt. */
export interface RegistryCdpProbeItem {
    host?: string;
    port?: number;
    stage?: string;
    ok?: boolean;
    source?: string;
    error?: string;
}

/** The currently active (verified) CDP endpoint for a workspace. */
export interface RegistryCdpActiveEndpoint {
    host?: string;
    port?: number;
    source?: string;
    verifiedAt?: number;
}

/** Full CDP discovery state stored inside a registry entry. */
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

/**
 * A single workspace entry in the Antigravity sidecar registry.
 * Written by the sidecar and read by the MCP server to locate CDP endpoints.
 */
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
    workspace_paths?: { normalized?: string; raw?: string };
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

/** A successfully discovered CDP endpoint with its associated registry entry. */
export interface DiscoveredCDP {
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
    matchMode: "exact" | "auto_fallback";
    workspaceKey: string;
}

/** Error codes returned by the CDP discovery process. */
export type DiscoverErrorCode =
    | "registry_missing"
    | "no_workspace_ever_opened"
    | "workspace_not_found"
    | "schema_mismatch"
    | "entry_not_ready"
    | "entry_stale"
    | "endpoint_missing"
    | "endpoint_unreachable"
    | "cdp_target_not_found"
    | "invalid_env_port";

/** A structured error from the CDP discovery process. */
export interface DiscoverCDPError {
    code: DiscoverErrorCode;
    message: string;
    workspaceId?: string;
    state?: string;
    details?: Record<string, unknown>;
}

/** The result of a CDP discovery attempt. */
export interface DiscoverCDPResult {
    ok: boolean;
    discovered?: DiscoveredCDP;
    error?: DiscoverCDPError;
}

/** Options controlling CDP discovery behaviour. */
export interface DiscoverCDPOptions {
    exactWorkspaceOnly?: boolean;
}
