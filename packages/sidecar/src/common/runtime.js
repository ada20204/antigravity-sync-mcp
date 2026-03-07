function resolveRuntimeRole(remoteName) {
    const forced = String(process.env.ANTIGRAVITY_SIDECAR_ROLE || '').trim().toLowerCase();
    if (forced === 'host' || forced === 'remote') return forced;
    if (remoteName) return 'remote';
    return 'host';
}

function clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function formatAgeMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

function createErrorInfo(code, message, details) {
    return {
        code: String(code || 'unknown_error'),
        message: String(message || 'unknown error'),
        at: Date.now(),
        details: details && typeof details === 'object' ? details : undefined,
    };
}

function mapCdpStateToRegistryState(state) {
    switch (state) {
        case 'idle': return 'app_down';
        case 'launching': return 'launching';
        case 'probing': return 'app_up_cdp_not_ready';
        case 'app_up_no_cdp': return 'app_up_no_cdp';
        case 'app_down': return 'app_down';
        case 'ready': return 'ready';
        case 'error': return 'error';
        default: return 'app_down';
    }
}

module.exports = {
    resolveRuntimeRole,
    clampNumber,
    formatAgeMs,
    createErrorInfo,
    mapCdpStateToRegistryState,
};
