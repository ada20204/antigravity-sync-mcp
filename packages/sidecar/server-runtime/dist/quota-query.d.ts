import type { DiscoveredCDP, RegistryQuotaSnapshot } from "./cdp.js";
export declare function extractActiveModelId(conversation: unknown): string | null;
export declare function fetchLiveQuotaSnapshot(discovered: DiscoveredCDP): Promise<RegistryQuotaSnapshot>;
export interface QuotaSummary {
    activeModelName: string | null;
    activeModelRemaining: number | null;
    promptRemaining: number | null;
    minModelRemaining: number | null;
    modelCount: number;
    exhaustedCount: number;
}
export declare function summarizeQuota(quota: RegistryQuotaSnapshot | undefined): QuotaSummary | null;
export declare function formatQuotaReport(params: {
    quota: RegistryQuotaSnapshot | undefined;
    source: string;
    targetDir?: string;
    liveError?: string;
}): string;
//# sourceMappingURL=quota-query.d.ts.map