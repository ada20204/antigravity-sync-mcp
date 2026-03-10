const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { exec, spawn } = require('child_process');
const net = require('net');
const { createHash, randomBytes } = require('crypto');
const { promisify } = require('util');
const {
    resolveRuntimeRole,
    clampNumber,
    formatAgeMs,
    createErrorInfo,
    mapCdpStateToRegistryState,
} = require('./common/runtime');
const {
    getJson,
    dedupeStrings,
    parsePortCandidates,
    isStrictCdpPortSpec,
    buildPortCandidateOrder,
    collectRegistryOccupiedPorts,
    trimProbeSummary,
    buildCandidateMatrix,
    previewTokens,
    summarizeProbePlan,
} = require('./common/port-utils');
const {
    MCP_HOME_DIR,
    MCP_BIN_DIR,
    MCP_METADATA_FILE,
    getBundledServerEntryPath,
    getLauncherPaths,
    ensureMcpLauncher,
    splitArgs,
    resolveDefaultExecutablePath,
    resolveCdpBindAddress,
    buildLaunchArgsForWorkspace,
    createExecutableKillMatcher,
    createRestartPrimitive,
} = require('./services/launcher');
const { buildAiConfigPrompt } = require('./core/ai-config');
const {
    extractActiveModelId,
    normalizeQuotaSnapshot,
    summarizeQuota,
} = require('./core/quota');
const { fetchQuotaSnapshot } = require('./services/quota-service');
const { createRegistryService } = require('./services/registry-service');
const { createHostBridgeServer, createRemoteBridgeClient } = require('./services/bridge-service');
const { createAccountCommandAdapter } = require('./services/account-command-adapter');
const { createAccountControlService } = require('./services/account-control');
const { createAccountControlApi } = require('./services/account-control-api');
const { createSwitchStatusStore } = require('./services/switch-status-store');
const { createRestartWorkerStore } = require('./services/restart-worker-store');
const { updateStatusBar: renderStatusBar } = require('./ui/status-bar');
const {
    getQuotaLevel,
    updateQuotaStatusBar: renderQuotaStatusBar,
    formatQuotaTooltip,
    formatQuotaReport,
} = require('./ui/quota-view');
const { registerCommands } = require('./commands/register-commands');
const { startAutoAccept, stopAutoAccept } = require('./auto-accept');
const {
    createNodeId,
    createStructuredLogger,
    createTraceId,
    LOG_RETENTION_MS,
} = require('./structured-log');
const {
    NonceCache,
    ensureBridgeToken,
    verifyControlRequest,
    DEFAULT_MAX_SKEW_MS,
} = require('./bridge-auth');

const {
    SCHEMA_VERSION,
    COMPATIBLE_SCHEMA_VERSIONS,
    REGISTRY_CONTROL_KEY,
    CONTROL_NO_CDP_PROMPT_KEY,
    getConfigDir,
    getRegistryFilePath,
    computeWorkspaceId,
    normalizeWorkspacePath,
} = require('../vendor/core');

const REGISTRY_DIR = getConfigDir();
const REGISTRY_FILE = getRegistryFilePath();
const HOST_CONTROL_POLL_INTERVAL_MS = 2_500;
const QUOTA_POLL_INTERVAL_MS = 60_000;
const CDP_HEARTBEAT_INTERVAL_MS = 30_000;
const CDP_PROBE_TIMEOUT_MS = 250;
const CDP_MAX_HOSTS = 8;
const CDP_PROBE_SUMMARY_LIMIT = 40;
const DEFAULT_CDP_PORT_SPEC = '9000-9014';
const CDP_PORT_RANGE_MIN = 9000;
const CDP_PORT_RANGE_MAX = 9014;
const HOST_BRIDGE_PORT = 18900;
const HOST_BRIDGE_BIND_HOST = '127.0.0.1';
const BRIDGE_VERSION = 1;
const DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT = 15;
const DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT = 5;
const DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES = 30;
const CDP_HEARTBEAT_REPEAT_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const NO_CDP_PROMPT_REQUEST_TTL_MS = 5 * 60 * 1000;
const LOG_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const execAsync = promisify(exec);
let outputChannel;
let structuredLogger;
const registryService = createRegistryService({
    fs,
    registryDir: REGISTRY_DIR,
    registryFile: REGISTRY_FILE,
    registryControlKey: REGISTRY_CONTROL_KEY,
    controlNoCdpPromptKey: CONTROL_NO_CDP_PROMPT_KEY,
});
const { getControlRecord, readRegistryObject, writeRegistryObject } = registryService;

function log(msg, fields) {
    if (!structuredLogger) {
        const time = new Date().toLocaleTimeString();
        const fullMsg = `[${time}] ${msg}`;
        console.log(fullMsg);
        if (outputChannel) outputChannel.appendLine(fullMsg);
        return;
    }
    structuredLogger.info(msg, fields);
}

function warn(msg, fields) {
    if (!structuredLogger) return log(msg, fields);
    structuredLogger.warn(msg, fields);
}

function errorLog(msg, fields) {
    if (!structuredLogger) return log(msg, fields);
    structuredLogger.error(msg, fields);
}

function shortError(error) {
    const message = error && error.message ? error.message : String(error || 'unknown');
    return message.slice(0, 180);
}

function createUnavailableAccountCommandAdapter({ switchMessage, addAnotherAccountMessage }) {
    return {
        async runSwitchAccountCommand() {
            vscode.window.showErrorMessage(`Sidecar: ${switchMessage}`);
        },
        async runAddAnotherAccountCommand() {
            vscode.window.showErrorMessage(`Sidecar: ${addAnotherAccountMessage}`);
        },
        async runAccountStatusCommand() {
            vscode.window.showErrorMessage(`Sidecar: ${switchMessage}`);
        },
        async runDeleteAccountCommand() {
            vscode.window.showErrorMessage(`Sidecar: ${switchMessage}`);
        },
    };
}

function createSwitchWorkerLauncher({
    antigravityExecutablePath,
    getWorkspacePath,
    getLaunchArgs,
    getCdpPort,
    log,
    getDbPath,
    getBackupDir,
    getConfigDir,
    getAntigravityPid,
}) {
    return {
        async launchSwitchWorker({ requestId, targetEmail }) {
            const workspacePath = getWorkspacePath();
            const launchArgs = getLaunchArgs();
            const cdpPort = getCdpPort();
            const dbPath = getDbPath();
            const backupDir = getBackupDir();
            const configDir = getConfigDir();
            const antigravityPid = getAntigravityPid();
            if (!workspacePath) {
                throw new Error('workspace folder is required for account switch');
            }
            if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
                throw new Error('CDP port is required for account switch');
            }
            if (!dbPath) {
                throw new Error('Antigravity database path is required for account switch');
            }
            if (!backupDir) {
                throw new Error('Account backup directory is required for account switch');
            }
            if (!configDir) {
                throw new Error('Config directory is required for account switch');
            }
            if (!Number.isFinite(antigravityPid) || antigravityPid <= 0) {
                throw new Error('Antigravity PID is required for account switch');
            }
            if (!antigravityExecutablePath || !fs.existsSync(antigravityExecutablePath)) {
                throw new Error('Antigravity executable not found');
            }

            const scriptPath = path.join(__dirname, '..', 'scripts', 'switch-worker.js');
            const args = [
                scriptPath,
                '--request-id', requestId,
                '--target-email', targetEmail,
                '--workspace', workspacePath,
                '--port', String(cdpPort),
                '--db-path', dbPath,
                '--backup-dir', backupDir,
                '--antigravity-path', antigravityExecutablePath,
                '--pid', String(antigravityPid),
                '--config-dir', configDir,
                ...launchArgs.flatMap((arg) => ['--extra-arg', arg]),
            ];

            log('Preparing switch worker launch', {
                plane: 'ctrl',
                state: 'launching-worker',
                extra: {
                    request_id: requestId,
                    target_email: targetEmail,
                    workspace_path: workspacePath,
                    cdp_port: cdpPort,
                    executable: antigravityExecutablePath,
                    switch_worker_script: scriptPath,
                    db_path: dbPath,
                    backup_dir: backupDir,
                    config_dir: configDir,
                    antigravity_pid: antigravityPid,
                    extra_args: launchArgs,
                },
            });

            try {
                const child = spawn('node', args, {
                    detached: true,
                    stdio: 'ignore',
                });
                child.unref();

                log('Switch worker process started', {
                    plane: 'ctrl',
                    state: 'worker-started',
                    extra: {
                        request_id: requestId,
                        target_email: targetEmail,
                        worker_pid: child.pid || null,
                        spawn_command: 'node',
                        spawn_args: args,
                        db_path: dbPath,
                        backup_dir: backupDir,
                        config_dir: configDir,
                        antigravity_pid: antigravityPid,
                    },
                });
            } catch (error) {
                log(`Switch worker launch failed: ${shortError(error)}`, {
                    plane: 'ctrl',
                    state: 'worker-launch-failed',
                    error_code: 'switch_worker_spawn_failed',
                    extra: {
                        request_id: requestId,
                        target_email: targetEmail,
                        workspace_path: workspacePath,
                        cdp_port: cdpPort,
                        executable: antigravityExecutablePath,
                        switch_worker_script: scriptPath,
                        db_path: dbPath,
                        backup_dir: backupDir,
                        config_dir: configDir,
                        antigravity_pid: antigravityPid,
                        extra_args: launchArgs,
                        error_message: shortError(error),
                    },
                });
                throw error;
            }
        },
    };
}

function createAccountFeatures({
    activationDiagnostics,
    context,
    outputChannel,
    log,
    warn,
    restartAntigravity,
    antigravityExecutablePath,
    getWorkspacePath,
    getLaunchArgs,
    getCdpPort,
    getAntigravityPid,
    runtimeRole,
    executeManualLaunch,
    getLatestQuota,
    summarizeQuota,
    refreshQuota,
}) {
    const fallback = {
        accountCommandAdapter: createUnavailableAccountCommandAdapter({
            switchMessage: 'Account switch is unavailable.',
            addAnotherAccountMessage: 'Add Another Account is unavailable.',
        }),
        accountControlApi: null,
    };

    try {
        const accountSwitchConfigDir = activationDiagnostics.run('account:configDir', () => path.join(os.homedir(), '.config', 'antigravity-mcp'));
        const statusStore = activationDiagnostics.run('account:statusStore', () => createSwitchStatusStore({
            filePath: path.join(accountSwitchConfigDir, 'switch-status.json'),
        }));
        const accountService = activationDiagnostics.run('account:serviceModule', () => require('./services/account-service'));
        const antigravityDbPath = activationDiagnostics.run('account:dbPath', () => accountService.getAntigravityDbPath());
        const accountBackupDir = activationDiagnostics.run('account:backupDir', () => accountService.getAccountsDir());
        const switchWorkerLauncher = activationDiagnostics.run('account:workerLauncher', () => createSwitchWorkerLauncher({
            antigravityExecutablePath,
            getWorkspacePath,
            getLaunchArgs,
            getCdpPort,
            log,
            getDbPath: () => antigravityDbPath,
            getBackupDir: () => accountBackupDir,
            getConfigDir: () => accountSwitchConfigDir,
            getAntigravityPid: () => {
                const pid = typeof getAntigravityPid === 'function' ? getAntigravityPid() : null;
                return Number(pid);
            },
        }));
        const accountControl = activationDiagnostics.run('account:control', () => createAccountControlService({
            accountService,
            workerLauncher: switchWorkerLauncher,
            statusStore,
            randomId: () => randomBytes(16).toString('hex'),
        }));
        const launchRestartWorker = ({ requestId }) => {
            const workspacePath = getWorkspacePath();
            const cdpPort = getCdpPort();
            const configDir = accountSwitchConfigDir;
            const pid = typeof getAntigravityPid === 'function' ? getAntigravityPid() : null;

            if (!workspacePath) throw new Error('workspace folder is required for restart');
            if (!Number.isFinite(cdpPort) || cdpPort <= 0) throw new Error('CDP port is required for restart');
            if (!antigravityExecutablePath) throw new Error('Antigravity executable path is required for restart');

            const scriptPath = path.join(__dirname, '..', 'scripts', 'restart-worker.js');
            const args = [
                scriptPath,
                '--request-id', requestId,
                '--workspace', workspacePath,
                '--antigravity-path', antigravityExecutablePath,
                '--port', String(cdpPort),
                '--config-dir', configDir,
                '--wait-exit',
                ...getLaunchArgs().flatMap((arg) => ['--extra-arg', arg]),
            ];
            if (Number.isFinite(pid) && pid > 0) {
                args.push('--pid', String(pid));
            }

            const child = spawn('node', args, { detached: true, stdio: 'ignore' });
            child.unref();
            log(`Restart worker started (pid=${child.pid}, requestId=${requestId})`);
        };

        const accountCommandAdapter = activationDiagnostics.run('account:commandAdapter', () => createAccountCommandAdapter({
            controller: accountControl,
            vscodeApi: vscode,
            outputChannel,
            log,
            launchRestartWorker,
            getLatestQuota,
            summarizeQuota,
            refreshQuota,
        }));
        const accountControlApi = runtimeRole === 'host'
            ? activationDiagnostics.run('account:controlApi', () => createAccountControlApi({
                accountControl,
                log: (message) => log(message),
                warn: (message) => warn(message),
            }))
            : null;

        if (accountControlApi) {
            context.subscriptions.push({
                dispose: () => {
                    try {
                        accountControlApi.dispose();
                    } catch (error) {
                        warn(`AccountControlApi dispose failed: ${shortError(error)}`);
                    }
                },
            });

            const address = accountControlApi.getAddress();
            if (address && typeof address === 'object') {
                log(`Account switch API ready on ${address.address}:${address.port}`);
            } else {
                log('Account switch API ready.');
            }
        } else {
            activationDiagnostics.mark('account:controlApi:skipped', `runtimeRole=${runtimeRole}`);
        }

        return {
            accountCommandAdapter,
            accountControlApi,
        };
    } catch (error) {
        const message = shortError(error);
        warn(`Account feature initialization degraded: ${message}`);
        outputChannel.appendLine(`[Sidecar] account features degraded: ${message}`);
        return {
            ...fallback,
            accountCommandAdapter: createUnavailableAccountCommandAdapter({
                switchMessage: `Account switch unavailable: ${message}`,
                addAnotherAccountMessage: `Add Another Account unavailable: ${message}`,
            }),
        };
    }
}

function createActivationDiagnostics({ log, outputChannel }) {
    const steps = [];

    function write(line) {
        log(line);
    }

    function start(name, extra = '') {
        const entry = { name, startedAt: Date.now(), extra };
        steps.push(entry);
        write(`[diag] start ${name}${extra ? ` ${extra}` : ''}`);
        return entry;
    }

    function ok(entry, extra = '') {
        const durationMs = Date.now() - entry.startedAt;
        entry.status = 'ok';
        entry.durationMs = durationMs;
        write(`[diag] ok ${entry.name} duration_ms=${durationMs}${extra ? ` ${extra}` : ''}`);
    }

    function fail(entry, error) {
        const durationMs = Date.now() - entry.startedAt;
        entry.status = 'fail';
        entry.durationMs = durationMs;
        entry.error = shortError(error);
        write(`[diag] fail ${entry.name} duration_ms=${durationMs} error=${JSON.stringify(entry.error)}`);
    }

    function mark(name, extra = '') {
        write(`[diag] mark ${name}${extra ? ` ${extra}` : ''}`);
    }

    function run(name, fn, extra = '') {
        const entry = start(name, extra);
        try {
            const result = fn();
            ok(entry);
            return result;
        } catch (error) {
            fail(entry, error);
            throw error;
        }
    }

    function summary() {
        const compact = steps.map((step) => `${step.name}:${step.status || 'pending'}${step.durationMs != null ? `(${step.durationMs}ms)` : ''}`);
        write(`[diag] summary ${compact.join(', ')}`);
    }

    return {
        mark,
        run,
        summary,
    };
}

function looksLikeAntigravityVersion(versionPayload) {
    if (!versionPayload || typeof versionPayload !== 'object') return false;
    const browser = String(versionPayload.Browser || '');
    const ua = String(versionPayload['User-Agent'] || versionPayload.userAgent || '');
    const wsUrl = String(versionPayload.webSocketDebuggerUrl || '');
    const marker = `${browser} ${ua} ${wsUrl}`.toLowerCase();
    return marker.includes('antigravity');
}

function canFallbackToListProbe(versionPayload) {
    if (!versionPayload || typeof versionPayload !== 'object') return true;
    const browser = String(versionPayload.Browser || '').trim();
    const ua = String(versionPayload['User-Agent'] || versionPayload.userAgent || '').trim();
    const wsUrl = String(versionPayload.webSocketDebuggerUrl || '').trim();
    return !browser && !ua && !wsUrl;
}

async function findCdpTarget(params) {
    const { workspaceName, hosts, ports } = params;
    const summary = [];
    let lastError = '';
    let lastErrorCode = 'cdp_not_found';

    for (const ip of hosts) {
        for (const port of ports) {
            let version = null;
            try {
                version = await getJson(`http://${ip}:${port}/json/version`, CDP_PROBE_TIMEOUT_MS);
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'version', ok: false, error: message });
                lastError = `${ip}:${port} version ${message}`;
                lastErrorCode = message.includes('timeout') ? 'cdp_version_timeout' : 'cdp_version_unreachable';
                continue;
            }

            if (looksLikeAntigravityVersion(version)) {
                summary.push({ host: ip, port, stage: 'version', ok: true, source: 'version' });
                return {
                    target: { ip, port, source: 'version', version },
                    summary: trimProbeSummary(summary),
                    lastError: '',
                    lastErrorCode: 'ok',
                };
            }

            if (!canFallbackToListProbe(version)) {
                summary.push({ host: ip, port, stage: 'version', ok: false, error: 'non_antigravity_target' });
                lastError = `${ip}:${port} version non_antigravity_target`;
                lastErrorCode = 'cdp_version_non_antigravity';
                continue;
            }

            // Fallback for variants where version marker is not explicit.
            try {
                const list = await getJson(`http://${ip}:${port}/json/list`, CDP_PROBE_TIMEOUT_MS);
                const pages = Array.isArray(list)
                    ? list.filter((t) => t && t.type === 'page' && !(t.url && t.url.includes('jetski')))
                    : [];
                const workbenches = pages.filter((t) => t.url && t.url.includes('workbench.html'));

                const matchingWorkbench = workbenches.find((t) =>
                    !workspaceName || String(t.title || '').includes(workspaceName)
                );
                const workbench = matchingWorkbench || workbenches[0] || pages[0];

                if (workbench) {
                    summary.push({ host: ip, port, stage: 'list', ok: true, source: 'list' });
                    return {
                        target: { ip, port, source: 'list', version },
                        summary: trimProbeSummary(summary),
                        lastError: '',
                        lastErrorCode: 'ok',
                    };
                }

                summary.push({ host: ip, port, stage: 'list', ok: false, error: 'no_page_target' });
                lastError = `${ip}:${port} list no_page_target`;
                lastErrorCode = 'cdp_list_no_page_target';
            } catch (error) {
                const message = shortError(error);
                summary.push({ host: ip, port, stage: 'list', ok: false, error: message });
                lastError = `${ip}:${port} list ${message}`;
                lastErrorCode = message.includes('timeout') ? 'cdp_list_timeout' : 'cdp_list_unreachable';
            }
        }
    }

    return {
        target: null,
        summary: trimProbeSummary(summary),
        lastError: lastError || 'no_cdp_target',
        lastErrorCode,
    };
}

async function isAntigravityProcessRunning() {
    try {
        if (process.platform === 'win32') {
            const cmd = 'powershell -NoProfile -Command "(Get-Process Antigravity -ErrorAction SilentlyContinue | Measure-Object).Count"';
            const { stdout } = await execAsync(cmd);
            return Number(String(stdout || '').trim()) > 0;
        }
        const { stdout } = await execAsync('pgrep -af "Antigravity"');
        return String(stdout || '').trim().length > 0;
    } catch {
        return false;
    }
}

function buildCdpProbePlan(params) {
    const { workspacePath, fixedHost, fixedPort, portSpec } = params;
    // The sidecar should probe loopback by default to avoid stale or unrelated
    // network-interface addresses that only add timeout cost.
    // and stale registry IPs from other workspaces — they only cause timeouts.
    const baseHosts = ['127.0.0.1', 'localhost'];
    if (fixedHost && String(fixedHost).trim()) baseHosts.unshift(String(fixedHost).trim());
    // Allow explicit multi-host override via env var for unusual remote setups.
    const envHosts = []
        .concat(String(process.env.ANTIGRAVITY_CDP_HOSTS || '').split(','))
        .concat(String(process.env.ANTIGRAVITY_CDP_HOST || '').split(','))
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    baseHosts.push(...envHosts);
    const allHosts = dedupeStrings(baseHosts);
    const hosts = allHosts.slice(0, CDP_MAX_HOSTS);

    const parsedPorts = parsePortCandidates(portSpec || DEFAULT_CDP_PORT_SPEC);
    const fallbackPorts = parsePortCandidates(DEFAULT_CDP_PORT_SPEC);
    const basePorts = parsedPorts.length > 0 ? parsedPorts : fallbackPorts;
    const fixed = Number(fixedPort);
    const ports = Number.isFinite(fixed) && fixed > 0 && fixed <= 65535
        ? [fixed, ...basePorts.filter((p) => p !== fixed)]
        : basePorts;

    return { hosts, ports };
}

/**
 * Scan registry for occupied CDP ports and return the lowest available port.
 * Returns null when no port is available in range.
 * @param {object} registry - registry object (may be null/undefined)
 * @param {[number, number]} portRange - [lo, hi] inclusive
 * @param {{ preferredPort?: number, unavailablePorts?: Set<number> }} options
 * @returns {number|null} allocated port
 */
function allocateFreeCdpPort(registry, portRange, options = {}) {
    const lo = portRange ? portRange[0] : 9000;
    const hi = portRange ? portRange[1] : 9014;
    const preferred = Number(options.preferredPort);
    const occupied = collectRegistryOccupiedPorts(registry);
    const unavailable = options.unavailablePorts instanceof Set
        ? options.unavailablePorts
        : new Set();
    for (const p of unavailable) {
        occupied.add(Number(p));
    }

    const ordered = buildPortCandidateOrder([lo, hi], preferred);
    for (const port of ordered) {
        if (!occupied.has(port)) return port;
    }
    return null;
}

async function isTcpPortAvailable(host, port, timeoutMs = 600) {
    return await new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                server.close(() => resolve(ok));
            } catch (_) {
                resolve(ok);
            }
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        server.on('error', () => finish(false));
        server.listen({ host, port, exclusive: true }, () => finish(true));
    });
}

async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Sidecar');
    context.subscriptions.push(outputChannel);

    const remoteName = String((vscode.env && vscode.env.remoteName) || '').trim();
    const runtimeRole = resolveRuntimeRole(remoteName);
    const nodeId = createNodeId(runtimeRole);
    let workspaceId = '';
    structuredLogger = createStructuredLogger({
        baseDir: REGISTRY_DIR,
        outputChannel,
        role: runtimeRole,
        nodeId,
        getWorkspaceId: () => workspaceId,
    });
    log('Extension activating...', {
        plane: 'ctrl',
        state: 'activating',
        extra: {
            role: runtimeRole,
            remote_name: remoteName || 'local',
            node_id: nodeId,
            log_retention_days: LOG_RETENTION_MS / (24 * 60 * 60 * 1000),
        },
    });
    const launcherResult = ensureMcpLauncher(context);
    if (launcherResult.ok) {
        log(`Bundled MCP launcher ready: ${launcherResult.unixLauncher}`, {
            plane: 'ctrl',
            state: 'ready',
            extra: {
                bundled_server: launcherResult.entryPath,
                windows_launcher: launcherResult.windowsLauncher,
            },
        });
    } else {
        warn(`Bundled MCP launcher unavailable: ${launcherResult.error}`, {
            plane: 'ctrl',
            error_code: 'bundled_server_missing',
        });
    }

    const activationDiagnostics = createActivationDiagnostics({ log, outputChannel });
    activationDiagnostics.mark('post-launcher');

    let latestLs = null;
    let latestQuota = null;
    let latestQuotaError = null;
    let lastQuotaAlertLevel = 'none';
    let lastQuotaAlertAt = 0;

    // ─── Status Bar (always registered, regardless of CDP) ────────────
    let statusBarItem = activationDiagnostics.run('status-bar:primary', () => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        item.command = 'antigravityMcpSidecar.toggle';
        context.subscriptions.push(item);
        return item;
    });

    let quotaStatusBarItem = activationDiagnostics.run('status-bar:quota', () => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        item.command = 'antigravityMcpSidecar.showQuota';
        context.subscriptions.push(item);
        return item;
    });

    let isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
    let cdpTarget = null;
    let cdpGeneration = 0;
    let cdpProbeSummary = [];
    let cdpLastError = null;
    let cdpState = 'idle';
    let cdpVerifiedAt = 0;
    let cdpSource = null;
    let cdpHeartbeatRunning = false;
    let lastHeartbeatFailureSignature = '';
    let lastHeartbeatFailureLogAt = 0;
    let launchTimeoutHandle = null;
    const LAUNCH_TIMEOUT_MS = 60_000;
    let cdpFixedHost = '';
    let cdpFixedPort = 0;
    let cdpPortSpec = DEFAULT_CDP_PORT_SPEC;
    let antigravityExecutablePath = '';
    let antigravityLaunchExtraArgs = [];
    let antigravityLaunchPort = 9000;
    let cdpProbeHosts = [];
    let cdpProbePorts = [];
    let register = () => { };
    let negotiateCdp = async (_options = {}) => false;
    let workspacePath = '';
    let workspaceName = '';
    let bridgeToken = '';
    let bridgeMaxSkewMs = DEFAULT_MAX_SKEW_MS;
    let bridgeRequestTtlMs = 5 * 60 * 1000;
    let bridgeHostEndpoint = `127.0.0.1:${HOST_BRIDGE_PORT}`;
    let lastSyncStateLogKey = '';
    const nonceCache = new NonceCache();
    let quotaWarnThresholdPercent = DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT;
    let quotaCriticalThresholdPercent = DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT;
    let quotaAlertCooldownMs = DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES * 60_000;
    let quotaStaleMinutes = 3;

    function reloadQuotaUiConfig() {
        const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
        quotaWarnThresholdPercent = clampNumber(
            config.get('quotaWarnThresholdPercent', DEFAULT_QUOTA_WARN_THRESHOLD_PERCENT),
            0,
            100
        );
        quotaCriticalThresholdPercent = clampNumber(
            config.get('quotaCriticalThresholdPercent', DEFAULT_QUOTA_CRITICAL_THRESHOLD_PERCENT),
            0,
            100
        );
        if (quotaCriticalThresholdPercent > quotaWarnThresholdPercent) {
            const tmp = quotaWarnThresholdPercent;
            quotaWarnThresholdPercent = quotaCriticalThresholdPercent;
            quotaCriticalThresholdPercent = tmp;
        }
        quotaStaleMinutes = clampNumber(config.get('quotaStaleMinutes', 3), 1, 120);
        const cooldownMinutes = clampNumber(
            config.get('quotaAlertCooldownMinutes', DEFAULT_QUOTA_ALERT_COOLDOWN_MINUTES),
            1,
            720
        );
        quotaAlertCooldownMs = cooldownMinutes * 60_000;
    }

    activationDiagnostics.run('config:reloadQuotaUiConfig', () => reloadQuotaUiConfig());

    function reloadCdpConfig() {
        const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
        cdpFixedHost = String(config.get('cdpFixedHost', '') || '').trim();
        cdpFixedPort = clampNumber(config.get('cdpFixedPort', 0), 0, 65535);
        const configuredPortSpec = String(config.get('cdpPortCandidates', DEFAULT_CDP_PORT_SPEC) || '').trim();
        cdpPortSpec = isStrictCdpPortSpec(configuredPortSpec)
            ? configuredPortSpec
            : DEFAULT_CDP_PORT_SPEC;
        const configuredExe = String(config.get('antigravityExecutablePath', '') || '').trim();
        antigravityExecutablePath = configuredExe || resolveDefaultExecutablePath();
        antigravityLaunchExtraArgs = splitArgs(config.get('antigravityLaunchExtraArgs', ''));
        antigravityLaunchPort = clampNumber(config.get('antigravityLaunchPort', 9000), 1, 65535);
        bridgeToken = ensureBridgeToken(
            REGISTRY_DIR,
            String(config.get('bridgeSharedToken', '') || '').trim()
        );
        bridgeMaxSkewMs = clampNumber(
            config.get('bridgeMaxSkewMs', DEFAULT_MAX_SKEW_MS),
            5_000,
            10 * 60 * 1000
        );
        bridgeRequestTtlMs = clampNumber(
            config.get('bridgeRequestTtlMs', 5 * 60 * 1000),
            30_000,
            30 * 60 * 1000
        );
        const configuredEndpoint = String(config.get('bridgeHostEndpoint', '') || '').trim();
        bridgeHostEndpoint = configuredEndpoint || `127.0.0.1:${HOST_BRIDGE_PORT}`;
    }

    activationDiagnostics.run('config:reloadCdpConfig', () => reloadCdpConfig());
    const logRetentionTimer = activationDiagnostics.run('timers:logRetention', () => setInterval(() => {
        try {
            structuredLogger.cleanupOldLogs();
        } catch { }
    }, LOG_RETENTION_SWEEP_INTERVAL_MS));
    context.subscriptions.push({ dispose: () => clearInterval(logRetentionTimer) });

    // Periodically prune expired nonces so the NonceCache doesn't grow unboundedly.
    const noncePruneTimer = activationDiagnostics.run('timers:noncePrune', () => setInterval(() => {
        try { nonceCache.prune(); } catch { }
    }, 5 * 60 * 1000));
    context.subscriptions.push({ dispose: () => clearInterval(noncePruneTimer) });

    function updateQuotaStatusBar() {
        renderQuotaStatusBar({
            quotaStatusBarItem,
            cdpTarget,
            latestQuota,
            latestQuotaError,
            quotaStaleMinutes,
            summarizeQuota,
            quotaWarnThresholdPercent,
            quotaCriticalThresholdPercent,
        });
    }

    function updateStatusBar() {
        renderStatusBar({
            statusBarItem,
            cdpTarget,
            isEnabled,
        });
        updateQuotaStatusBar();
    }

    function maybeNotifyLowQuota() {
        const summary = summarizeQuota(latestQuota);
        if (!summary) return;
        const snapshotAgeMs = latestQuota && latestQuota.timestamp
            ? Date.now() - Number(latestQuota.timestamp)
            : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs > quotaStaleMinutes * 60_000) {
            return;
        }
        const levelInfo = getQuotaLevel(summary, {
            quotaWarnThresholdPercent,
            quotaCriticalThresholdPercent,
        });
        const level = levelInfo.level;
        const watchedPercent = levelInfo.watchedPercent;

        if (level === 'none') {
            lastQuotaAlertLevel = 'none';
            return;
        }
        if (watchedPercent === null) return;

        const now = Date.now();
        const shouldNotify =
            level !== lastQuotaAlertLevel ||
            (now - lastQuotaAlertAt) > quotaAlertCooldownMs;
        if (!shouldNotify) return;

        const message = `Antigravity quota low: ${levelInfo.target} remaining ${watchedPercent.toFixed(1)}%`;
        // No popup alerts for quota; keep logs/status bar only.
        log(`Quota alert (${level}): ${message}`);
        lastQuotaAlertLevel = level;
        lastQuotaAlertAt = now;
    }

    function syncState() {
        let nextLogKey = '';
        if (isEnabled && cdpTarget) {
            const config = vscode.workspace.getConfiguration('antigravityMcpSidecar');
            startAutoAccept(cdpTarget.port, log, config.get('nativePollInterval', 500), config.get('cdpPollInterval', 1500), cdpTarget.ip);
            nextLogKey = `running:${cdpTarget.ip}:${cdpTarget.port}`;
            if (nextLogKey !== lastSyncStateLogKey) {
                log(`Auto-accept loops running on ${cdpTarget.ip}:${cdpTarget.port}`);
            }
        } else {
            stopAutoAccept();
            if (!cdpTarget) {
                nextLogKey = 'paused:no_cdp';
                if (nextLogKey !== lastSyncStateLogKey) {
                    log('Auto-accept unavailable: no CDP debug port found');
                }
            } else {
                nextLogKey = 'paused:disabled';
                if (nextLogKey !== lastSyncStateLogKey) {
                    log('Auto-accept paused');
                }
            }
        }
        lastSyncStateLogKey = nextLogKey;
        updateStatusBar();
    }

    const restartAntigravity = createRestartPrimitive();
    const restartWorkerStore = createRestartWorkerStore();

    async function waitForRestartWorker(requestId, timeoutMs = 30000, intervalMs = 400) {
        const startedAt = Date.now();
        let latestSeen = null;

        while ((Date.now() - startedAt) < timeoutMs) {
            const latest = restartWorkerStore.getLatest(requestId);
            if (latest && latest.record) {
                latestSeen = latest;
                if (latest.terminal) {
                    return latest;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }

        return latestSeen;
    }

    async function executeManualLaunch(action, options = {}) {
        const trigger = options.trigger || 'local';
        const exitAfterWorkerStart = options.exitAfterWorkerStart === true;
        const waitExit = options.waitExit === true;
        if (!workspacePath) {
            vscode.window.showWarningMessage('Sidecar: No workspace folder available for Antigravity launch.');
            return;
        }
        if (!antigravityExecutablePath || !fs.existsSync(antigravityExecutablePath)) {
            vscode.window.showWarningMessage(
                'Sidecar: Antigravity executable not found. Configure antigravityMcpSidecar.antigravityExecutablePath first.'
            );
            return;
        }

        const registry = readRegistryObject() || {};
        const bindAddress = resolveCdpBindAddress();
        let allocatedPort = null;

        if (cdpFixedPort > 0) {
            const fixedAvailable = await isTcpPortAvailable(bindAddress, cdpFixedPort);
            if (!fixedAvailable) {
                const message = `Configured CDP fixed port ${cdpFixedPort} is unavailable on ${bindAddress}.`;
                cdpLastError = createErrorInfo('cdp_fixed_port_unavailable', message, {
                    bind_address: bindAddress,
                    fixed_port: cdpFixedPort,
                });
                register();
                vscode.window.showWarningMessage(`${message} Please choose another fixed port.`);
                return;
            }
            allocatedPort = cdpFixedPort;
        } else {
            const unavailable = new Set();
            while (true) {
                const nextPort = allocateFreeCdpPort(registry, [9000, 9014], {
                    preferredPort: antigravityLaunchPort,
                    unavailablePorts: unavailable,
                });
                if (!Number.isFinite(nextPort) || nextPort <= 0) break;
                const available = await isTcpPortAvailable(bindAddress, nextPort);
                if (available) {
                    allocatedPort = nextPort;
                    break;
                }
                unavailable.add(nextPort);
            }
            if (!Number.isFinite(allocatedPort) || allocatedPort <= 0) {
                const message = `No available CDP port in range 9000-9014 on ${bindAddress}.`;
                cdpLastError = createErrorInfo('cdp_port_exhausted', message, {
                    bind_address: bindAddress,
                    preferred_port: antigravityLaunchPort,
                });
                register();
                vscode.window.showErrorMessage(`${message} Close old Antigravity windows or set a fixed CDP port.`);
                return;
            }
        }
        // Launch detached restart-worker instead of direct restart
        const workerPath = path.join(context.extensionPath, 'scripts', 'restart-worker.js');
        const requestId = `restart-${Date.now()}`;
        const workerArgs = [
            '--workspace', workspacePath,
            '--antigravity-path', antigravityExecutablePath,
            '--port', String(allocatedPort),
            '--bind-address', bindAddress,
            '--request-id', requestId,
            '--config-dir', MCP_HOME_DIR,
            '--wait-for-cdp', 'true',
        ];

        if (action === 'launch') {
            workerArgs.push('--cold-start');
        } else {
            // restart: use wait-exit mode so the worker waits for Antigravity to exit
            // gracefully instead of actively killing it (which would kill sidecar too).
            workerArgs.push('--wait-exit');
            try {
                const { execSync } = require('child_process');
                const out = execSync('pgrep -f "Antigravity" -P 1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                const antigravityPid = parseInt(String(out || '').trim().split('\n')[0], 10);
                if (Number.isFinite(antigravityPid) && antigravityPid > 0) {
                    workerArgs.push('--pid', String(antigravityPid));
                }
            } catch { /* pid optional */ }
        }

        // Add extra args
        for (const arg of antigravityLaunchExtraArgs) {
            workerArgs.push('--extra-arg', arg);
        }

        try {
            const workerProcess = spawn('node', [workerPath, ...workerArgs], {
                detached: true,
                stdio: 'ignore',
            });
            workerProcess.unref();

            log(
                `${action === 'restart' ? 'Restart' : 'Launch'} worker started with port=${allocatedPort} workspace=${workspacePath}`,
                {
                    plane: 'ctrl',
                    state: 'launching',
                    extra: { action, trigger, allocated_port: allocatedPort, worker_pid: workerProcess.pid },
                }
            );
        } catch (error) {
            const message = shortError(error);
            vscode.window.showErrorMessage(`Sidecar: Failed to start ${action} worker: ${message}`);
            cdpLastError = createErrorInfo('worker_start_failed', message, { action, trigger });
            register();
            return;
        }

        // Transition to 'launching' — prevents duplicate remote launch requests.
        // Auto-expires to 'idle' (app_down) if process never appears within LAUNCH_TIMEOUT_MS.
        if (launchTimeoutHandle) clearTimeout(launchTimeoutHandle);
        cdpState = 'launching';
        cdpLastError = null;
        cdpSource = action === 'restart' ? 'manual-restart' : 'manual-launch';
        register();
        launchTimeoutHandle = setTimeout(() => {
            launchTimeoutHandle = null;
            if (cdpState === 'launching') {
                cdpState = 'app_down';
                cdpLastError = createErrorInfo(
                    'launch_timeout',
                    'Antigravity did not appear after launch request within timeout window'
                );
                register();
                log('Launch timeout: no process appeared within timeout, reverting to app_down');
            }
        }, LAUNCH_TIMEOUT_MS);

        if (exitAfterWorkerStart) {
            return { requestId, detached: true };
        }

        const workerOutcome = await waitForRestartWorker(requestId, action === 'restart' ? 30000 : 20000);
        if (launchTimeoutHandle) { clearTimeout(launchTimeoutHandle); launchTimeoutHandle = null; }

        if (!workerOutcome || !workerOutcome.record) {
            cdpState = 'app_down';
            cdpLastError = createErrorInfo(
                'restart_worker_timeout',
                'Timed out waiting for restart worker result',
                { action, trigger, request_id: requestId }
            );
            register();
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
            vscode.window.showWarningMessage(
                `Sidecar: Timed out waiting for ${action} worker result. Check restart-worker.log and retry.`
            );
            return;
        }

        const workerRecord = workerOutcome.record;
        if (String(workerRecord.status || '').toLowerCase() !== 'success') {
            const workerError = workerRecord.error || `Worker ${workerRecord.status || 'failed'} at phase ${workerRecord.phase || 'unknown'}`;
            cdpState = 'app_down';
            cdpLastError = createErrorInfo('restart_worker_failed', workerError, {
                action,
                trigger,
                request_id: requestId,
                phase: workerRecord.phase || null,
            });
            register();
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
            vscode.window.showWarningMessage(
                `Sidecar: Antigravity ${action} worker failed: ${workerError}`
            );
            return;
        }

        const ok = await negotiateCdp();
        stopAutoAccept();
        syncState();
        updateQuotaStatusBar();
        if (ok) {
            vscode.window.showInformationMessage(
                `Sidecar: Antigravity ${action === 'restart' ? 'restarted' : 'launched'} and CDP is ready on ${cdpTarget.ip}:${cdpTarget.port}.`
            );
            return;
        }
        vscode.window.showWarningMessage(
            `Sidecar: Antigravity ${action} worker succeeded, but CDP is still unavailable. Check launch args and retry.`
        );
    }

    async function requestHostRestart(params = {}) {
        const reason = String(params.reason || 'remote_request').slice(0, 200);
        if (runtimeRole !== 'remote') {
            warn('Host restart request ignored: sidecar is not in remote mode', {
                plane: 'ctrl',
                error_code: 'remote_request_not_supported',
            });
            return false;
        }
        warn('Host restart bridge is not configured in this build; request cannot be forwarded automatically', {
            plane: 'ctrl',
            error_code: 'remote_restart_bridge_unavailable',
            extra: { reason },
        });
        vscode.window.showInformationMessage(
            'Sidecar: Remote host restart bridge is not configured. Restart Antigravity on host manually with CDP flags.'
        );
        return false;
    }

    async function showNoCdpPromptFromServer(request = {}) {
        const platform = process.platform;
        const state = String(request.state || cdpState || 'unknown');
        const code = String(request.reason_code || (cdpLastError && cdpLastError.code) || 'cdp_not_ready');
        const bindAddress = resolveCdpBindAddress();
        const baseMessage =
            `MCP requested CDP but it is unavailable (state=${state}, code=${code}). ` +
            `Launch Antigravity with --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`;
        const actions = ['How to Fix'];
        if (platform === 'win32') actions.unshift('Auto-Fix Shortcut (Windows)');

        const action = await vscode.window.showWarningMessage(baseMessage, ...actions);
        if (action === 'How to Fix') {
            const guide = platform === 'linux'
                ? (runtimeRole === 'remote'
                    ? `Remote sidecar cannot cold-start host app. Open Antigravity on host with --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`
                    : `Launch Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}, then retry MCP request.`)
                : platform === 'darwin'
                    ? `Open Terminal and run: open -a "Antigravity" --args --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}`
                    : `Restart Antigravity with: --remote-debugging-port=9000 --remote-debugging-address=${bindAddress}.`;
            await vscode.window.showInformationMessage(guide, { modal: true });
        } else if (action === 'Auto-Fix Shortcut (Windows)') {
            autoFixWindowsShortcut();
        }
        return action || '';
    }

    function rejectControlRequest(registry, request, code, message) {
        const control = getControlRecord(registry);
        const current = control.restart_requests[request.id];
        if (!current) return;
        control.restart_requests[request.id] = {
            ...current,
            status: 'rejected',
            handled_at: Date.now(),
            handled_by: nodeId,
            error: { code, message },
            updated_at: Date.now(),
        };
        registry[REGISTRY_CONTROL_KEY] = control;
    }

    let controlRequestHandling = false;
    async function processHostControlRequests() {
        if (controlRequestHandling) return;
        controlRequestHandling = true;
        try {
            const registry = readRegistryObject();
            const control = getControlRecord(registry);
            let changed = false;

            const promptRequests = Object.values(control[CONTROL_NO_CDP_PROMPT_KEY] || {})
                .filter((item) => item && item.status === 'pending')
                .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
            for (const request of promptRequests) {
                if (request.workspace_id && request.workspace_id !== workspaceId) continue;
                const ageMs = Date.now() - Number(request.updated_at || request.created_at || 0);
                if (ageMs > NO_CDP_PROMPT_REQUEST_TTL_MS) {
                    const current = control[CONTROL_NO_CDP_PROMPT_KEY][request.id];
                    if (current) {
                        control[CONTROL_NO_CDP_PROMPT_KEY][request.id] = {
                            ...current,
                            status: 'expired',
                            updated_at: Date.now(),
                        };
                        changed = true;
                    }
                    continue;
                }

                // Check current real-time CDP status before showing prompt.
                // If CDP is now ready, the issue has been auto-resolved (e.g., launch completed
                // after initial probe failure). Skip the prompt and mark request as resolved.
                // This prevents showing stale/misleading error prompts when CDP is working.
                if (cdpState === 'ready' && cdpTarget) {
                    log('Skipping stale CDP prompt: CDP is now ready', {
                        plane: 'ctrl',
                        state: 'skip_prompt',
                        extra: {
                            request_id: request.id,
                            request_state: request.state,
                            current_state: cdpState,
                            reason_code: request.reason_code,
                        },
                    });
                    const current = control[CONTROL_NO_CDP_PROMPT_KEY][request.id];
                    if (current) {
                        control[CONTROL_NO_CDP_PROMPT_KEY][request.id] = {
                            ...current,
                            status: 'resolved',
                            resolved_reason: 'cdp_now_ready',
                            resolved_at: Date.now(),
                            resolved_by: nodeId,
                            updated_at: Date.now(),
                        };
                        changed = true;
                    }
                    continue;
                }

                const selectedAction = await showNoCdpPromptFromServer(request);
                const current = control[CONTROL_NO_CDP_PROMPT_KEY][request.id];
                if (current) {
                    control[CONTROL_NO_CDP_PROMPT_KEY][request.id] = {
                        ...current,
                        status: 'shown',
                        action: selectedAction || undefined,
                        shown_at: Date.now(),
                        handled_by: nodeId,
                        updated_at: Date.now(),
                    };
                    changed = true;
                }
                break;
            }

            if (runtimeRole !== 'host') {
                if (changed) {
                    registry[REGISTRY_CONTROL_KEY] = control;
                    writeRegistryObject(registry);
                }
                return;
            }

            const requests = Object.values(control.restart_requests || {})
                .filter((item) => item && item.status === 'pending')
                .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));

            for (const request of requests) {
                if (request.workspace_id !== workspaceId) continue;
                if (request.to_node_id && request.to_node_id !== nodeId) continue;

                const ageMs = Date.now() - Number(request.created_at || request.ts || 0);
                if (ageMs > bridgeRequestTtlMs) {
                    rejectControlRequest(registry, request, 'request_expired', 'control request exceeded ttl');
                    changed = true;
                    continue;
                }

                const verified = verifyControlRequest(request, bridgeToken, {
                    maxSkewMs: bridgeMaxSkewMs,
                    nonceCache,
                });
                if (!verified.ok) {
                    rejectControlRequest(registry, request, verified.code, verified.message);
                    changed = true;
                    continue;
                }

                const decision = await vscode.window.showWarningMessage(
                    `Sidecar: Remote sidecar requested restart for workspace ${workspacePath}. Restart Antigravity now?`,
                    { modal: true },
                    'Restart',
                    'Reject'
                );
                // Re-read registry after the blocking modal — other processes may have
                // written changes while we waited.  Using the stale pre-modal object
                // would overwrite those changes.
                const liveRegistry = readRegistryObject() || registry;
                const controlRef = getControlRecord(liveRegistry);
                const current = controlRef.restart_requests[request.id];
                if (!current) continue;

                if (decision !== 'Restart') {
                    controlRef.restart_requests[request.id] = {
                        ...current,
                        status: 'rejected',
                        handled_at: Date.now(),
                        handled_by: nodeId,
                        error: { code: 'restart_rejected', message: 'user rejected host restart request' },
                        updated_at: Date.now(),
                    };
                    liveRegistry[REGISTRY_CONTROL_KEY] = controlRef;
                    writeRegistryObject(liveRegistry);
                    continue;
                }

                controlRef.restart_requests[request.id] = {
                    ...current,
                    status: 'approved',
                    handled_at: Date.now(),
                    handled_by: nodeId,
                    updated_at: Date.now(),
                };
                liveRegistry[REGISTRY_CONTROL_KEY] = controlRef;
                writeRegistryObject(liveRegistry);
                await executeManualLaunch('restart', { trigger: 'remote-request' });

                const registryAfter = readRegistryObject();
                const controlAfter = getControlRecord(registryAfter);
                const currentAfter = controlAfter.restart_requests[request.id];
                if (currentAfter) {
                    controlAfter.restart_requests[request.id] = {
                        ...currentAfter,
                        status: cdpState === 'ready' ? 'applied' : 'error',
                        handled_at: Date.now(),
                        handled_by: nodeId,
                        error: cdpState === 'ready' ? undefined : { code: 'restart_failed', message: 'CDP not ready after restart' },
                        updated_at: Date.now(),
                    };
                    registryAfter[REGISTRY_CONTROL_KEY] = controlAfter;
                    writeRegistryObject(registryAfter);
                }
            }

            if (changed) {
                registry[REGISTRY_CONTROL_KEY] = control;
                writeRegistryObject(registry);
            }
        } catch (err) {
            warn(`Host control request processor failed: ${shortError(err)}`, {
                plane: 'ctrl',
                error_code: 'control_request_processor_failed',
            });
        } finally {
            controlRequestHandling = false;
        }
    }

    const accountFeatures = createAccountFeatures({
        activationDiagnostics,
        context,
        outputChannel,
        log,
        warn,
        restartAntigravity,
        antigravityExecutablePath,
        getWorkspacePath: () => workspacePath,
        getLaunchArgs: () => antigravityLaunchExtraArgs,
        getCdpPort: () => cdpTarget ? cdpTarget.port : (cdpFixedPort > 0 ? cdpFixedPort : antigravityLaunchPort),
        getAntigravityPid: () => {
            // Find the Antigravity main process (PPID=1, owned by launchd).
            // process.pid is the extension-host PID inside Antigravity, not the app PID.
            try {
                const { execSync } = require('child_process');
                if (process.platform === 'win32') {
                    return null;
                }
                // pgrep -P 1 matches processes whose parent is launchd (the main app process)
                const out = execSync('pgrep -f "Antigravity" -P 1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                const pid = parseInt(String(out || '').trim().split('\n')[0], 10);
                return Number.isFinite(pid) && pid > 0 ? pid : null;
            } catch {
                return null;
            }
        },
        runtimeRole,
        executeManualLaunch,
        getLatestQuota: () => latestQuota,
        summarizeQuota,
        refreshQuota: async () => refreshQuota(),
    });

    try {
        activationDiagnostics.mark('before-registerCommands');
        log('activate: calling registerCommands');
        outputChannel.appendLine('[Sidecar] activate: calling registerCommands');
        registerCommands(context, {
        runtimeRole,
        outputChannel,
        refreshQuota: async () => refreshQuota(),
        requestHostRestart,
        ensureMcpLauncher,
        buildAiConfigPrompt,
        executeManualLaunch,
        getLauncherPaths,
        getBundledServerEntryPath,
        summarizeQuota,
        formatQuotaReport,
        getLatestQuota: () => latestQuota,
        getLatestQuotaError: () => latestQuotaError,
        getWorkspacePath: () => workspacePath,
        getCdpTarget: () => cdpTarget,
        getIsEnabled: () => isEnabled,
        setIsEnabled: (value) => {
            isEnabled = value;
        },
        syncState,
        accountCommandAdapter: accountFeatures.accountCommandAdapter,
        log,
    });
        log('activate: registerCommands completed');
        outputChannel.appendLine('[Sidecar] activate: registerCommands completed');
    } catch (error) {
        const message = shortError(error);
        log(`activate: registerCommands failed: ${message}`);
        outputChannel.appendLine(`[Sidecar] activate: registerCommands failed: ${message}`);
        vscode.window.showErrorMessage(`Sidecar: Command registration failed: ${message}`);
        throw error;
    }

    activationDiagnostics.run('subscriptions:onDidChangeConfiguration', () => context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravityMcpSidecar')) {
            const prevFixedHost = cdpFixedHost;
            const prevFixedPort = cdpFixedPort;
            const prevPortSpec = cdpPortSpec;
            isEnabled = vscode.workspace.getConfiguration('antigravityMcpSidecar').get('enabled', true);
            reloadQuotaUiConfig();
            reloadCdpConfig();
            const cdpConfigChanged =
                prevFixedHost !== cdpFixedHost ||
                prevFixedPort !== cdpFixedPort ||
                prevPortSpec !== cdpPortSpec;
            if (cdpConfigChanged) {
                cdpState = 'probing';
                register();
                negotiateCdp()
                    .then(() => {
                        stopAutoAccept();
                        syncState();
                        updateQuotaStatusBar();
                    })
                    .catch((error) => {
                        log(`CDP renegotiation failed after config change: ${shortError(error)}`);
                        stopAutoAccept();
                        syncState();
                        updateQuotaStatusBar();
                    });
                return;
            }
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
        }
    })));

    // ─── CDP Discovery ────────────────────────────────────────────────
    activationDiagnostics.mark('before-workspaceFolders');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        activationDiagnostics.mark('workspaceFolders:none');
        log('No workspace folders found');
        updateStatusBar();
        activationDiagnostics.summary();
        return;
    }

    workspacePath = workspaceFolders[0].uri.fsPath;
    workspaceId = computeWorkspaceId(workspacePath);
    workspaceName = vscode.workspace.name || "";
    activationDiagnostics.mark('workspaceFolders:resolved', `workspace=${JSON.stringify(workspacePath)}`);
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }

    register = () => {
        const registry = readRegistryObject();
        const previous = (registry[workspacePath] && typeof registry[workspacePath] === 'object')
            ? registry[workspacePath]
            : {};

        const previousCdp = previous.cdp && typeof previous.cdp === 'object' ? previous.cdp : {};
        const activeHost = cdpTarget ? cdpTarget.ip : (previousCdp.active && previousCdp.active.host) || previous.ip;
        const activePort = cdpTarget ? cdpTarget.port : (previousCdp.active && previousCdp.active.port) || previous.port;

        const now = Date.now();
        const v1State = mapCdpStateToRegistryState(cdpState);
        const endpointHost = activeHost || '127.0.0.1';
        const endpointPort = activePort || 9000;

        registry[workspacePath] = {
            ...previous,
            schema_version: SCHEMA_VERSION,
            protocol: {
                schema_version: SCHEMA_VERSION,
                compatible_schema_versions: COMPATIBLE_SCHEMA_VERSIONS,
                writer_role: runtimeRole,
                writer_node_id: nodeId,
                updated_at: now,
            },
            workspace_id: workspaceId || computeWorkspaceId(workspacePath),
            workspace_paths: {
                normalized: normalizeWorkspacePath(workspacePath),
                raw: workspacePath,
            },
            node_id: nodeId,
            role: runtimeRole,
            source_of_truth: runtimeRole === 'host' ? 'host' : 'remote',
            source_endpoint: { host: endpointHost, port: endpointPort },
            local_endpoint: {
                host: endpointHost,
                port: endpointPort,
                mode: runtimeRole === 'host' ? 'direct' : 'forwarded',
            },
            state: v1State,
            verified_at: cdpVerifiedAt || previous.verified_at,
            ttl_ms: 90000,
            priority: runtimeRole === 'host' ? 100 : 80,
            quota_meta: {
                source: runtimeRole === 'host' ? 'host' : 'remote',
                stale: false,
                refreshed_at: now,
                refresh_interval_ms: QUOTA_POLL_INTERVAL_MS,
            },
            last_error: cdpLastError || undefined,
            port: cdpTarget ? cdpTarget.port : previous.port,
            ip: cdpTarget ? cdpTarget.ip : previous.ip,
            pid: process.pid,
            lastActive: now,
            ls: latestLs || previous.ls,
            quota: latestQuota || previous.quota,
            quotaError: latestQuotaError,
            cdp: {
                ...previousCdp,
                generation: cdpGeneration,
                state: cdpState,
                updatedAt: now,
                verifiedAt: cdpVerifiedAt || previousCdp.verifiedAt,
                active: (activeHost && activePort)
                    ? {
                        host: activeHost,
                        port: activePort,
                        source: cdpSource || (previousCdp.active && previousCdp.active.source) || 'registry',
                        verifiedAt: cdpVerifiedAt || (previousCdp.active && previousCdp.active.verifiedAt) || now,
                    }
                    : undefined,
                candidates: buildCandidateMatrix(cdpProbeHosts, cdpProbePorts),
                probeSummary: trimProbeSummary(cdpProbeSummary),
                lastError: cdpLastError ? `${cdpLastError.code}:${cdpLastError.message}` : undefined,
            },
        };

        registry[REGISTRY_CONTROL_KEY] = getControlRecord(registry);
        writeRegistryObject(registry);
    };

    // ─── Bridge startup ───────────────────────────────────────────────
    if (runtimeRole === 'host') {
        const getSnapshot = (reqWorkspaceId, reqWorkspacePath) => {
            const registry = readRegistryObject();
            for (const [key, entry] of Object.entries(registry)) {
                if (key === REGISTRY_CONTROL_KEY || typeof entry !== 'object' || !entry) continue;
                if (reqWorkspaceId && entry.workspace_id === reqWorkspaceId) return entry;
                if (reqWorkspacePath && (key === reqWorkspacePath ||
                    (entry.workspace_paths && entry.workspace_paths.normalized === reqWorkspacePath))) return entry;
            }
            // Fallback: return own workspace entry
            return (registry[workspacePath] && typeof registry[workspacePath] === 'object')
                ? registry[workspacePath]
                : null;
        };
        const bridgeServer = createHostBridgeServer({
            getSnapshot,
            bridgeToken,
            nonceCache,
            log,
            warn,
            schemaVersion: SCHEMA_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            host: HOST_BRIDGE_BIND_HOST,
            port: HOST_BRIDGE_PORT,
        });
        context.subscriptions.push(bridgeServer);
    }

    if (runtimeRole === 'remote') {
        // Warn if bridgeSharedToken is not configured — host and remote must share
        // the same token for HMAC auth to succeed. Either set bridgeSharedToken in
        // VS Code settings on both sides, or copy bridge.token from host to remote.
        const configuredToken = String(
            vscode.workspace.getConfiguration('antigravityMcpSidecar').get('bridgeSharedToken', '') || ''
        ).trim();
        if (!configuredToken) {
            warn(
                'bridgeSharedToken is not configured. ' +
                'Host and remote must share the same token for bridge auth to succeed. ' +
                'Set antigravityMcpSidecar.bridgeSharedToken to the same value on both sides, ' +
                'or copy ~/.config/antigravity-mcp/bridge.token from host to remote.',
                { plane: 'ctrl', error_code: 'bridge_token_not_configured' }
            );
        }

        const onSnapshot = (snapshotResponse) => {
            const entry = snapshotResponse && snapshotResponse.entry;
            if (!entry || typeof entry !== 'object') return;
            const now = Date.now();
            const registry = readRegistryObject();
            const previous = (registry[workspacePath] && typeof registry[workspacePath] === 'object')
                ? registry[workspacePath]
                : {};
            registry[workspacePath] = {
                ...previous,
                schema_version: SCHEMA_VERSION,
                protocol: {
                    schema_version: SCHEMA_VERSION,
                    compatible_schema_versions: COMPATIBLE_SCHEMA_VERSIONS,
                    writer_role: 'remote',
                    writer_node_id: nodeId,
                    updated_at: now,
                },
                workspace_id: workspaceId,
                original_workspace_id: entry.workspace_id,
                workspace_paths: {
                    normalized: normalizeWorkspacePath(workspacePath),
                    raw: workspacePath,
                },
                node_id: nodeId,
                role: 'remote',
                source_of_truth: 'host',
                source_endpoint: entry.source_endpoint || entry.local_endpoint,
                local_endpoint: {
                    host: '127.0.0.1',
                    port: (entry.local_endpoint && entry.local_endpoint.port) || 9000,
                    mode: 'forwarded',
                },
                state: entry.state,
                verified_at: entry.verified_at,
                ttl_ms: snapshotResponse.ttl_ms || 30_000,
                priority: 80,
                pid: process.pid,
                lastActive: now,
                ls: entry.ls,
                quota: entry.quota,
                cdp: entry.cdp,
            };
            writeRegistryObject(registry);

            // Update local CDP state so status bar reflects host state
            if (entry.local_endpoint && entry.state === 'ready') {
                const port = entry.local_endpoint.port || 9000;
                if (!cdpTarget || cdpTarget.port !== port) {
                    cdpTarget = { ip: '127.0.0.1', port };
                    cdpState = 'ready';
                    cdpVerifiedAt = entry.verified_at || now;
                    cdpSource = 'bridge';
                    updateStatusBar();
                }
            }
        };
        const bridgeClient = createRemoteBridgeClient({
            bridgeEndpoint: bridgeHostEndpoint,
            bridgeToken,
            nodeId,
            onSnapshot,
            log,
            warn,
        });
        context.subscriptions.push(bridgeClient);
    }

    negotiateCdp = async (options = {}) => {
        const phase = String((options && options.phase) || 'runtime');
        const previous = readRegistryObject()[workspacePath];
        const previousGeneration = previous && previous.cdp && Number.isFinite(previous.cdp.generation)
            ? Number(previous.cdp.generation)
            : 0;
        cdpGeneration = previousGeneration + 1;

        const plan = buildCdpProbePlan({
            workspacePath,
            fixedHost: cdpFixedHost,
            fixedPort: cdpFixedPort,
            portSpec: cdpPortSpec,
        });
        cdpProbeHosts = plan.hosts;
        cdpProbePorts = plan.ports;
        cdpProbeSummary = [];
        cdpLastError = null;
        cdpState = 'probing';
        cdpSource = null;
        cdpVerifiedAt = 0;
        register();

        if (phase !== 'startup' && phase !== 'heartbeat-retry') {
            log(`CDP probe started (${summarizeProbePlan(cdpProbeHosts, cdpProbePorts)})`, {
                plane: 'data',
                state: 'probing',
            });
        }
        const result = await findCdpTarget({
            workspaceName,
            hosts: cdpProbeHosts,
            ports: cdpProbePorts,
        });
        cdpProbeSummary = result.summary || [];

        if (result.target) {
            cdpTarget = { ip: result.target.ip, port: result.target.port };
            cdpState = 'ready';
            cdpSource = result.target.source || 'probe';
            cdpVerifiedAt = Date.now();
            cdpLastError = null;
            lastHeartbeatFailureSignature = '';
            lastHeartbeatFailureLogAt = 0;
            register();
            // Clear any pending CDP prompt requests for this workspace now that CDP is ready.
            try {
                const regNow = readRegistryObject();
                const ctrl = getControlRecord(regNow);
                const prompts = ctrl[CONTROL_NO_CDP_PROMPT_KEY];
                if (prompts && typeof prompts === 'object') {
                    const requestId = `no_cdp_${workspaceId}`;
                    const existing = prompts[requestId];
                    if (existing && (existing.status === 'pending' || existing.status === 'shown')) {
                        prompts[requestId] = { ...existing, status: 'resolved', updated_at: Date.now() };
                        ctrl[CONTROL_NO_CDP_PROMPT_KEY] = prompts;
                        regNow[REGISTRY_CONTROL_KEY] = ctrl;
                        writeRegistryObject(regNow);
                    }
                }
            } catch { }
            log(`Registered workspace ${workspacePath} with CDP target ${cdpTarget.ip}:${cdpTarget.port} (source=${cdpSource})`, {
                plane: 'data',
                state: 'ready',
            });
            return true;
        }

        cdpTarget = null;
        const appRunning = await isAntigravityProcessRunning();
        if (result.lastErrorCode === 'cdp_list_no_page_target') {
            cdpState = 'probing';
        } else if (appRunning) {
            cdpState = 'app_up_no_cdp';
        } else {
            cdpState = 'app_down';
        }
        cdpLastError = createErrorInfo(
            result.lastErrorCode || 'cdp_not_found',
            result.lastError || 'no_cdp_target',
            {
                hosts: cdpProbeHosts,
                ports: cdpProbePorts.slice(0, 16),
                app_running: appRunning,
            }
        );
        register();
        if (phase !== 'startup') {
            const failureSignature = `${cdpState}|${cdpLastError.code}|${cdpLastError.message}`;
            const now = Date.now();
            const shouldLogHeartbeatFailure = phase !== 'heartbeat-retry'
                || failureSignature !== lastHeartbeatFailureSignature
                || (now - lastHeartbeatFailureLogAt) >= CDP_HEARTBEAT_REPEAT_LOG_COOLDOWN_MS;
            if (shouldLogHeartbeatFailure) {
                errorLog(
                    `CDP probe failed (${cdpLastError.code}): state=${cdpState} workspace=${workspacePath} last=${cdpLastError.message}`,
                    {
                        plane: 'data',
                        state: mapCdpStateToRegistryState(cdpState),
                        error_code: cdpLastError.code,
                        extra: {
                            probe: summarizeProbePlan(cdpProbeHosts, cdpProbePorts),
                        },
                    }
                );
                lastHeartbeatFailureSignature = failureSignature;
                lastHeartbeatFailureLogAt = now;
            }
        }
        return false;
    };

    processHostControlRequests().catch(() => {});
    const controlTimer = setInterval(() => {
        processHostControlRequests().catch((err) => {
            warn(`Control loop error: ${shortError(err)}`, {
                plane: 'ctrl',
                error_code: 'control_loop_error',
            });
        });
    }, HOST_CONTROL_POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(controlTimer) });

    // Heartbeat runs even when initial CDP probe fails so it can auto-recover.
    const heartbeatRetry = async () => {
        if (cdpHeartbeatRunning) return;
        if (cdpState !== 'app_up_no_cdp' && cdpState !== 'app_up_cdp_not_ready' && cdpState !== 'app_down') return;
        cdpHeartbeatRunning = true;
        try {
            const recovered = await negotiateCdp({ phase: 'heartbeat-retry' });
            if (recovered) {
                log(`CDP auto-recovered via heartbeat retry (${cdpTarget.ip}:${cdpTarget.port})`);
                updateStatusBar();
                updateQuotaStatusBar();
                // One-time quota fetch since we missed normal init.
                fetchQuotaSnapshot({
                    execAsync,
                    normalizeQuotaSnapshot,
                    extractActiveModelId,
                }).then((result) => {
                    latestLs = result.ls || latestLs;
                    latestQuota = result.quota || latestQuota;
                    latestQuotaError = result.error;
                    register();
                    updateQuotaStatusBar();
                    maybeNotifyLowQuota();
                }).catch(() => { });
            }
        } finally {
            cdpHeartbeatRunning = false;
        }
    };

    const cdpRetryTimer = setInterval(() => {
        if (!cdpTarget) heartbeatRetry().catch(() => { });
    }, CDP_HEARTBEAT_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(cdpRetryTimer) });

    if (!(await negotiateCdp({ phase: 'startup' }))) {
        updateStatusBar();
        return;
    }

    const refreshQuota = async () => {
        try {
            const result = await fetchQuotaSnapshot({
                execAsync,
                normalizeQuotaSnapshot,
                extractActiveModelId,
            });
            latestLs = result.ls || latestLs;
            latestQuota = result.quota || latestQuota;
            latestQuotaError = result.error;
            register();
            if (result.quota) {
                if (structuredLogger) {
                    structuredLogger.debug(`Quota snapshot updated (${result.quota.models ? result.quota.models.length : 0} model entries)`);
                }
            } else if (result.error) {
                log(`Quota snapshot unavailable: ${result.error}`);
            }
            updateQuotaStatusBar();
            maybeNotifyLowQuota();
        } catch (e) {
            latestQuotaError = e && e.message ? e.message : String(e);
            register();
            log(`Quota refresh failed: ${latestQuotaError}`);
            updateQuotaStatusBar();
        }
    };

    await refreshQuota();
    const quotaTimer = setInterval(() => {
        refreshQuota().catch(() => { });
    }, QUOTA_POLL_INTERVAL_MS);
    context.subscriptions.push({
        dispose: () => clearInterval(quotaTimer),
    });

    const heartbeatCdp = async () => {
        if (cdpHeartbeatRunning) return;
        if (!cdpTarget) return;
        cdpHeartbeatRunning = true;
        try {
            const version = await getJson(`http://${cdpTarget.ip}:${cdpTarget.port}/json/version`, CDP_PROBE_TIMEOUT_MS);
            if (!looksLikeAntigravityVersion(version)) {
                throw new Error('version_not_antigravity');
            }
            cdpState = 'ready';
            cdpSource = cdpSource || 'heartbeat';
            cdpVerifiedAt = Date.now();
            cdpLastError = null;
            register();
        } catch (error) {
            cdpState = 'probing';
            cdpLastError = createErrorInfo('cdp_heartbeat_error', `heartbeat ${shortError(error)}`);
            register();
            const recovered = await negotiateCdp();
            if (!recovered) {
                cdpTarget = null;
                errorLog(`CDP heartbeat recovery failed: ${cdpLastError ? `${cdpLastError.code}:${cdpLastError.message}` : 'unknown'}`, {
                    plane: 'data',
                    state: mapCdpStateToRegistryState(cdpState),
                    error_code: cdpLastError ? cdpLastError.code : 'cdp_heartbeat_error',
                });
            } else {
                log(`CDP heartbeat recovered endpoint ${cdpTarget.ip}:${cdpTarget.port}`);
            }
            stopAutoAccept();
            syncState();
            updateQuotaStatusBar();
        } finally {
            cdpHeartbeatRunning = false;
        }
    };

    const cdpHeartbeatTimer = setInterval(() => {
        heartbeatCdp().catch((error) => {
            log(`CDP heartbeat error: ${shortError(error)}`);
        });
    }, CDP_HEARTBEAT_INTERVAL_MS);
    context.subscriptions.push({
        dispose: () => clearInterval(cdpHeartbeatTimer),
    });

    syncState();

    // ─── Check for account switch result ──────────────────────────────
    const configDir = path.join(os.homedir(), '.config', 'antigravity-mcp');
    const resultFile = path.join(configDir, 'switch-result.json');
    log(`Checking switch result file: ${resultFile}`);

    if (fs.existsSync(resultFile)) {
        log('Switch result file detected, attempting to display it in output channel');
        try {
            const resultRaw = fs.readFileSync(resultFile, 'utf-8');
            log(`Switch result file read successfully (${resultRaw.length} chars)`);
            const result = JSON.parse(resultRaw);
            outputChannel.show(true);
            outputChannel.appendLine('=== Sidecar: Account Switch Result ===');
            outputChannel.appendLine(`Status: ${result.status}`);
            outputChannel.appendLine(`Target: ${result.target}`);
            outputChannel.appendLine(`Phase: ${result.phase}`);
            if (result.error) {
                outputChannel.appendLine(`Error: ${result.error}`);
            }
            outputChannel.appendLine('');
            outputChannel.appendLine('=== Sidecar: Worker Logs ===');
            if (result.logs && Array.isArray(result.logs)) {
                log(`Appending ${result.logs.length} worker log lines to output channel`);
                for (const logLine of result.logs) {
                    outputChannel.appendLine(logLine);
                }
            } else {
                log('Switch result contains no logs array');
                outputChannel.appendLine('(No logs available)');
            }

            fs.unlinkSync(resultFile);
            log('Switch result file displayed and removed');
            log('Switch status lookup remains backed by switch-status.json');

            if (result.status === 'success') {
                vscode.window.showInformationMessage(`Sidecar: Switched account to ${result.target}.`);
                log(`Account switched to ${result.target}`);
            } else {
                vscode.window.showErrorMessage(`Sidecar: Account switch failed: ${result.error || 'unknown error'}`);
                log(`Account switch failed: ${result.error || 'unknown error'}`);
            }
        } catch (e) {
            log(`Failed to read switch result: ${e.message}`);
        }
    } else {
        log('No switch result file found on activation');
    }

    activationDiagnostics.summary();

    context.subscriptions.push({
        dispose: () => {
            stopAutoAccept();
            if (fs.existsSync(REGISTRY_FILE)) {
                try {
                    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
                    if (registry[workspacePath] && registry[workspacePath].pid === process.pid) {
                        delete registry[workspacePath];
                        writeRegistryObject(registry);
                        log(`Deregistered workspace ${workspacePath}`);
                    }
                } catch { }
            }
        }
    });
}

function autoFixWindowsShortcut() {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Sidecar: Auto-fix is Windows-only. See the "How to Fix" option for your platform.');
        return;
    }

    const cp = require('child_process');
    const psFile = path.join(os.tmpdir(), 'antigravity_patch_shortcut.ps1');
    const psContent = `
$flag = "--remote-debugging-port=9000"
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs"
)
$patched = $false
foreach ($dir in $paths) {
    if (Test-Path $dir) {
        $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            $shortcut = $WshShell.CreateShortcut($file.FullName)
            if ($shortcut.TargetPath -like "*Antigravity*") {
                if ($shortcut.Arguments -notlike "*remote-debugging-port*") {
                    $shortcut.Arguments = ($shortcut.Arguments + " " + $flag).Trim()
                    $shortcut.Save()
                    $patched = $true
                    Write-Output "PATCHED: $($file.FullName)"
                }
            }
        }
    }
}
if ($patched) { Write-Output "SUCCESS" } else { Write-Output "NOT_FOUND" }
`;

    try {
        fs.writeFileSync(psFile, psContent, 'utf8');
    } catch (e) {
        log(`[CDP] Failed to write patcher script: ${e.message}`);
        vscode.window.showWarningMessage('Sidecar: Could not create patcher script. Please add the flag manually.');
        return;
    }

    log('[CDP] Running shortcut patcher...');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (err, stdout, stderr) => {
        try { fs.unlinkSync(psFile); } catch (e) { }

        if (err) {
            log(`[CDP] Patcher error: ${err.message}`);
            vscode.window.showWarningMessage('Sidecar: Shortcut patching failed. Please add the flag manually.');
            return;
        }
        log(`[CDP] Patcher output: ${stdout.trim()}`);
        if (stdout.includes('SUCCESS')) {
            log('[CDP] ✓ Shortcut patched!');
            vscode.window.showInformationMessage(
                'Sidecar: Shortcut updated! Restart Antigravity for the fix to take effect.',
                'OK'
            );
        } else {
            vscode.window.showWarningMessage(
                'Sidecar: No Antigravity shortcut found. Add --remote-debugging-port=9000 to your shortcut manually.'
            );
        }
    });
}

function deactivate() {
    stopAutoAccept();
}

module.exports = {
    activate,
    deactivate,
    // Exported for unit testing only
    _testExports: {
        allocateFreeCdpPort,
        parsePortCandidates,
        isStrictCdpPortSpec,
        buildPortCandidateOrder,
        collectRegistryOccupiedPorts,
    },
};
