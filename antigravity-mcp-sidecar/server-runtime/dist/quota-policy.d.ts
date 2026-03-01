import type { RegistryQuotaSnapshot } from "./cdp.js";
export type AskMode = "fast" | "plan";
export interface ModelSelectionInput {
    requestedModel?: string;
    mode?: string;
    quota?: RegistryQuotaSnapshot;
    nowMs?: number;
    staleAfterMs?: number;
}
export interface ModelSelectionResult {
    selectedModel: string;
    mode: AskMode;
    chain: string[];
    skipped: Array<{
        model: string;
        reason: string;
    }>;
    staleQuota: boolean;
}
export declare function buildCandidateChain(mode: AskMode, requestedModel?: string): string[];
export declare function selectModelWithQuotaPolicy(input: ModelSelectionInput): ModelSelectionResult;
//# sourceMappingURL=quota-policy.d.ts.map