export declare function resolveLaunchPort(): number;
export declare function resolveAntigravityExecutable(): string | undefined;
export declare function buildLaunchArgs(params: {
    targetDir: string;
    port: number;
}): string[];
export declare function isTcpPortAvailable(host: string, port: number, timeoutMs?: number): Promise<boolean>;
export declare function allocateAvailablePort(bindAddress: string, preferredPort: number): Promise<number | null>;
export declare function psQuote(value: string): string;
export declare function atomicWindowsLaunch(executable: string, args: string[], killFirst: boolean, log?: (msg: string) => void): Promise<void>;
export declare function verifyCdpReady(host: string, port: number, timeoutMs?: number): Promise<boolean>;
export interface LaunchResult {
    started: boolean;
    executable?: string;
    port?: number;
    killed?: number;
    cdpVerified?: boolean;
    error?: string;
}
export declare function launchAntigravityForWorkspace(params: {
    targetDir: string;
    killExisting?: boolean;
    log?: (message: string) => void;
}): Promise<LaunchResult>;
//# sourceMappingURL=launch-antigravity.d.ts.map