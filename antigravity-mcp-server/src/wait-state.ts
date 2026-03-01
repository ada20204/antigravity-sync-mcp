import type { DiscoveredCDP } from "./cdp.js";
import {
    callLsJson,
    isTrajectoryTerminal,
    openReactiveStream,
    resolveActiveCascadeId,
    resolveLsEndpoint,
    type ReactiveStreamHandle,
} from "./ls-client.js";

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

const TRAJECTORY_POLL_INTERVAL_MS = 1500;
const MAX_TRAJECTORY_ERRORS = 3;

function createDomFallbackEngine(note: string): WaitStateEngine {
    return {
        check: async () => ({ completed: false, lsUsable: false, note }),
        close: () => undefined,
    };
}

export async function createWaitStateEngine(params: {
    discovered: DiscoveredCDP;
    log?: (message: string) => void;
}): Promise<WaitStateEngine> {
    const { discovered, log } = params;
    if (!resolveLsEndpoint(discovered)) {
        return createDomFallbackEngine("ls_endpoint_unavailable");
    }

    const cascadeId = await resolveActiveCascadeId(discovered).catch(() => undefined);
    if (!cascadeId) {
        return createDomFallbackEngine("cascade_id_unavailable");
    }

    let stream: ReactiveStreamHandle | null = null;
    let streamInitError: string | undefined;
    try {
        stream = await openReactiveStream(discovered, cascadeId);
        if (stream) {
            log?.(`Wait source initialized: StreamCascadeReactiveUpdates (cascade=${cascadeId})`);
        }
    } catch (error) {
        streamInitError = error instanceof Error ? error.message : String(error);
        log?.(`Reactive stream unavailable: ${streamInitError}`);
    }

    let lastTrajectoryPollAt = 0;
    let trajectoryErrors = 0;

    const check = async (elapsedMs: number): Promise<WaitCheckResult> => {
        if (stream?.state.terminal) {
            return {
                completed: true,
                source: "ls_stream",
                lsUsable: true,
            };
        }

        if (elapsedMs - lastTrajectoryPollAt < TRAJECTORY_POLL_INTERVAL_MS) {
            const hasAnyLsSource = !!stream || trajectoryErrors < MAX_TRAJECTORY_ERRORS;
            return {
                completed: false,
                lsUsable: hasAnyLsSource,
                note: streamInitError,
            };
        }
        lastTrajectoryPollAt = elapsedMs;

        try {
            const data = await callLsJson(discovered, "GetCascadeTrajectory", { cascadeId });
            trajectoryErrors = 0;
            if (isTrajectoryTerminal(data)) {
                return {
                    completed: true,
                    source: "ls_trajectory",
                    lsUsable: true,
                };
            }
            return {
                completed: false,
                lsUsable: true,
            };
        } catch (error) {
            trajectoryErrors += 1;
            const message = error instanceof Error ? error.message : String(error);
            const lsUsable = !!stream || trajectoryErrors < MAX_TRAJECTORY_ERRORS;
            return {
                completed: false,
                lsUsable,
                note: message,
            };
        }
    };

    return {
        cascadeId,
        check,
        close: () => {
            stream?.close();
        },
    };
}

