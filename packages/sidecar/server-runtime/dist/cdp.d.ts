/**
 * CDP Registry Routing & Connection Module
 *
 * Replaces the previous port-scanning logic.
 * Now reads the CDP port for a specific target directory
 * from the registry managed by antigravity-mcp-sidecar.
 */
import type { CDPTarget, ExecutionContext, RegistryEntry, RegistryQuotaModel, RegistryQuotaSnapshot, RegistryLsEndpoint, RegistryV1Endpoint, RegistryV1QuotaMeta, CDPConnection, RegistryCdpCandidate, RegistryCdpProbeItem, RegistryCdpActiveEndpoint, RegistryCdpState, DiscoveredCDP, DiscoverErrorCode, DiscoverCDPError, DiscoverCDPResult, DiscoverCDPOptions } from "@antigravity-mcp/core";
export type { CDPTarget, ExecutionContext, RegistryEntry, RegistryQuotaModel, RegistryQuotaSnapshot, RegistryLsEndpoint, RegistryV1Endpoint, RegistryV1QuotaMeta, CDPConnection, RegistryCdpCandidate, RegistryCdpProbeItem, RegistryCdpActiveEndpoint, RegistryCdpState, DiscoveredCDP, DiscoverErrorCode, DiscoverCDPError, DiscoverCDPResult, DiscoverCDPOptions, };
export declare function computeWorkspaceId(rawPath: string): string;
export declare function discoverCDPDetailed(targetDir?: string, options?: DiscoverCDPOptions): Promise<DiscoverCDPResult>;
export declare function discoverCDP(targetDir?: string): Promise<{
    port: number;
    ip: string;
    target: CDPTarget;
    registry?: RegistryEntry;
    matchMode: "exact" | "auto_fallback";
    workspaceKey: string;
} | null>;
export declare function connectCDP(wsUrl: string): Promise<CDPConnection>;
export declare function evaluateInAllContexts(cdp: CDPConnection, expression: string, awaitPromise?: boolean): Promise<any>;
//# sourceMappingURL=cdp.d.ts.map