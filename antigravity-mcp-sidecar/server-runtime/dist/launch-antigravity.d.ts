export declare function resolveLaunchPort(): number;
export declare function resolveAntigravityExecutable(): string | undefined;
export declare function buildLaunchArgs(params: {
    targetDir: string;
    port: number;
}): string[];
export declare function launchAntigravityForWorkspace(params: {
    targetDir: string;
    killExisting?: boolean;
    log?: (message: string) => void;
}): Promise<{
    started: boolean;
    executable?: string;
    port?: number;
    killed?: number;
    error?: string;
}>;
//# sourceMappingURL=launch-antigravity.d.ts.map