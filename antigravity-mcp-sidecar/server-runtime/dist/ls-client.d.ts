import { type DiscoveredCDP, type RegistryLsEndpoint } from "./cdp.js";
export interface ReactiveStreamState {
    connected: boolean;
    ended: boolean;
    terminal: boolean;
    lastEventAt: number;
    lastReason?: string;
    error?: string;
}
export interface ReactiveStreamHandle {
    state: ReactiveStreamState;
    close: () => void;
}
export declare function resolveLsEndpoint(discovered: DiscoveredCDP): RegistryLsEndpoint | undefined;
export declare function callLsJson(discovered: DiscoveredCDP, method: string, body: Record<string, unknown>): Promise<any>;
export declare function resolveActiveCascadeId(discovered: DiscoveredCDP): Promise<string | undefined>;
export declare function isTrajectoryTerminal(payload: unknown): boolean;
export declare function openReactiveStream(discovered: DiscoveredCDP, cascadeId: string): Promise<ReactiveStreamHandle | null>;
//# sourceMappingURL=ls-client.d.ts.map