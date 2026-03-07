import type { DiscoveredCDP } from "./cdp.js";
export interface WaitCheckResult {
    completed: boolean;
    source?: "ls_stream" | "ls_trajectory";
    lsUsable: boolean;
    note?: string;
}
export interface WaitStateEngine {
    cascadeId?: string;
    check: (elapsedMs: number) => Promise<WaitCheckResult>;
    close: () => void;
}
export declare function createWaitStateEngine(params: {
    discovered: DiscoveredCDP;
    log?: (message: string) => void;
}): Promise<WaitStateEngine>;
//# sourceMappingURL=wait-state.d.ts.map