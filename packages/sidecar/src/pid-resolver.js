/**
 * PID Resolver
 *
 * Unified PID resolution from port ownership (lsof/netstat).
 * Returns structured results with source metadata instead of bare PID values.
 */

const path = require('path');

/**
 * Parse Windows netstat output to find the PID listening on a given port.
 * @param {string} output - Raw netstat -ano output
 * @param {number} port - Target port
 * @returns {number|null}
 */
function parseWindowsNetstatListeningPid(output, port) {
    const targetSuffix = ':' + String(port);
    for (const rawLine of String(output || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = String(parts[1] || '');
        const state = String(parts[3] || '').toUpperCase();
        const pid = parseInt(parts[4], 10);
        if (!localAddress.endsWith(targetSuffix)) continue;
        if (state !== 'LISTENING') continue;
        if (!Number.isFinite(pid) || pid <= 0) continue;
        return pid;
    }
    return null;
}

/**
 * Parse POSIX lsof output to find the PID listening on a given port.
 * @param {string} output - Raw lsof -t output
 * @returns {number|null}
 */
function parsePosixLsofListeningPid(output) {
    const pid = parseInt(String(output || '').trim().split('\n')[0], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Attempt to resolve the PID that owns a listening TCP port.
 * @param {number} port
 * @param {object} [dependencies] - Injectable dependencies for testing
 * @returns {number|null}
 */
function attemptResolvePid(port, dependencies = {}) {
    const platform = dependencies.platform || process.platform;
    const execSyncImpl = dependencies.execSync || require('child_process').execSync;

    try {
        if (platform === 'win32') {
            const out = execSyncImpl('netstat -ano -p TCP', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
            return parseWindowsNetstatListeningPid(String(out || ''), port);
        }
        const out = execSyncImpl('lsof -nP -iTCP:' + port + ' -sTCP:LISTEN -t', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return parsePosixLsofListeningPid(out);
    } catch {
        return null;
    }
}

/**
 * Resolve the PID listening on a given port with structured result.
 *
 * @param {number} port - TCP port to look up
 * @param {object} [options]
 * @param {number} [options.retries=1] - Number of attempts (1 = single attempt, no retry)
 * @param {number} [options.delayMs=500] - Delay between retries
 * @param {object} [options.dependencies] - Injectable dependencies for testing
 * @returns {{ pid: number|null, source: string, attempts: number }}
 */
function resolveListeningPidForPort(port, options = {}) {
    const { retries = 1, delayMs = 500, dependencies = {} } = options;

    if (!Number.isFinite(port) || port <= 0) {
        return { pid: null, source: 'unresolved', attempts: 0 };
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        const pid = attemptResolvePid(port, dependencies);
        if (pid) {
            return { pid, source: 'port_owner', attempts: attempt };
        }
        if (attempt < retries && delayMs > 0) {
            const sleepImpl = dependencies.sleepSync;
            if (sleepImpl) {
                sleepImpl(delayMs);
            }
            // In production without sleepSync, single-attempt is the default.
            // Multi-retry with delay is used in async contexts via the worker.
        }
    }

    return { pid: null, source: 'unresolved', attempts: retries };
}

module.exports = {
    resolveListeningPidForPort,
    parseWindowsNetstatListeningPid,
    parsePosixLsofListeningPid,
    attemptResolvePid,
};
