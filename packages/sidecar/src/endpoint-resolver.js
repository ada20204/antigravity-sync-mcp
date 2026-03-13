/**
 * Endpoint Resolver
 *
 * Unified CDP endpoint (port) selection logic with source metadata.
 * Extracts and consolidates the port selection chain from extension.js.
 */

/**
 * Select the best CDP port for a worker launch, returning both port and source.
 *
 * Priority order:
 * 1. For restart: current active CDP port (source: 'current')
 * 2. For restart: registry candidate port (source: 'registry')
 * 3. Allocated port from range (source: 'allocated')
 * 4. Fixed port (source: 'fixed')
 *
 * @param {object} params
 * @param {string} params.action - 'launch' or 'restart'
 * @param {number|null} params.currentCdpPort - Currently active CDP port
 * @param {number|null} params.registryCdpPort - Port from registry candidate
 * @param {number|null} params.allocatedPort - Dynamically allocated port
 * @param {number|null} params.fixedPort - User-configured fixed port
 * @returns {{ port: number|null, source: string }}
 */
function selectWorkerLaunchPort(params = {}) {
    const { action, currentCdpPort, registryCdpPort, allocatedPort, fixedPort } = params;

    if (action === 'restart' && Number.isFinite(currentCdpPort) && currentCdpPort > 0) {
        return { port: currentCdpPort, source: 'current' };
    }
    if (action === 'restart' && Number.isFinite(registryCdpPort) && registryCdpPort > 0) {
        return { port: registryCdpPort, source: 'registry' };
    }
    if (Number.isFinite(allocatedPort) && allocatedPort > 0) {
        return { port: allocatedPort, source: 'allocated' };
    }
    if (Number.isFinite(fixedPort) && fixedPort > 0) {
        return { port: fixedPort, source: 'fixed' };
    }
    return { port: null, source: 'unresolved' };
}

/**
 * Find the best registry CDP candidate for a workspace.
 *
 * Scores entries by workspace key match, workspace ID match, and path match,
 * then by state (ready > other) and active CDP presence.
 *
 * @param {object} registry - Registry object keyed by workspace path
 * @param {string} workspacePath - Current workspace path
 * @param {string} workspaceId - Current workspace ID
 * @param {object} [options]
 * @param {function} [options.normalizeWorkspacePath] - Path normalizer
 * @param {string} [options.registryControlKey] - Key to skip in registry
 * @returns {object|null} Candidate with { host, port, source, match, state, lastActive, score }
 */
function getRegistryActiveCdpCandidate(registry, workspacePath, workspaceId, options = {}) {
    const normalizeWorkspacePath = options.normalizeWorkspacePath || ((p) => p);
    const REGISTRY_CONTROL_KEY = options.registryControlKey || '__control__';

    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
    const entries = Object.entries(registry || {});
    let bestCandidate = null;

    for (const [key, entry] of entries) {
        if (key === REGISTRY_CONTROL_KEY || !entry || typeof entry !== 'object') continue;
        let matchScore = 0;
        if (key === workspacePath) matchScore += 8;
        if (entry.workspace_id === workspaceId) matchScore += 6;
        if (entry.workspace_paths && entry.workspace_paths.raw === workspacePath) matchScore += 5;
        if (entry.workspace_paths && entry.workspace_paths.normalized === normalizedWorkspacePath) matchScore += 4;
        if (matchScore <= 0) continue;

        const active = entry.cdp && entry.cdp.active && typeof entry.cdp.active === 'object'
            ? entry.cdp.active
            : null;
        const host = active && active.host ? active.host : entry.ip;
        const port = active && Number.isFinite(active.port) ? active.port : entry.port;
        if (!Number.isFinite(port) || port <= 0) continue;

        const lastActive = Number.isFinite(entry.lastActive) ? entry.lastActive : 0;
        const stateScore = entry.state === 'ready' ? 3 : 0;
        const activeScore = active ? 2 : 0;
        const candidate = {
            host: host || '127.0.0.1',
            port,
            source: active && active.source ? active.source : 'registry',
            match: key === workspacePath ? 'workspace-key' : (entry.workspace_id === workspaceId ? 'workspace-id' : 'workspace-path'),
            state: entry.state || null,
            lastActive,
            score: matchScore + stateScore + activeScore,
        };

        if (
            !bestCandidate ||
            candidate.score > bestCandidate.score ||
            (candidate.score === bestCandidate.score && candidate.lastActive > bestCandidate.lastActive)
        ) {
            bestCandidate = candidate;
        }
    }
    return bestCandidate;
}

module.exports = {
    selectWorkerLaunchPort,
    getRegistryActiveCdpCandidate,
};
