#!/usr/bin/env node
/**
 * Antigravity Restart Worker
 *
 * 独立进程，负责 kill → wait → launch → verify CDP 的完整重启流程。
 * 由 sidecar 以 detached 模式启动，完全独立运行。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============================================================================
// 参数解析
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = { extraArgs: [] };

    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (key === '--extra-arg') {
            i++;
            if (i < args.length) {
                parsed.extraArgs.push(args[i]);
            }
            continue;
        }

        if (key.startsWith('--')) {
            const name = key.replace(/^--/, '');

            // Check if next arg exists and is not another flag
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                i++;
                parsed[name] = args[i];
            } else {
                // Boolean flag without value
                parsed[name] = true;
            }
        }
    }

    return parsed;
}

const parsedArgs = parseArgs();

function getRuntimeValue(key, fallback = undefined) {
    return parsedArgs[key] ?? fallback;
}

function getWorkspace() {
    return getRuntimeValue('workspace');
}

function getAntigravityPath() {
    return getRuntimeValue('antigravity-path');
}

function getPort() {
    return getRuntimeValue('port');
}

function getBindAddress() {
    return getRuntimeValue('bind-address', '127.0.0.1');
}

function getRequestId() {
    return getRuntimeValue('request-id', `restart-${Date.now()}-${process.pid}`);
}

function getConfigDir() {
    return getRuntimeValue('config-dir');
}

function getWaitForCdp() {
    return getRuntimeValue('wait-for-cdp', 'true') === 'true';
}

function getExtraArgs() {
    return parsedArgs.extraArgs || [];
}

function getColdStart() {
    return parsedArgs['cold-start'] !== undefined;
}

function validateArgs() {
    const missing = [];
    if (!getWorkspace()) missing.push('workspace');
    if (!getAntigravityPath()) missing.push('antigravity-path');
    if (!getPort()) missing.push('port');
    if (!getConfigDir()) missing.push('config-dir');

    if (missing.length > 0) {
        console.error(`Missing required arguments: ${missing.join(', ')}`);
        console.error('Usage: restart-worker.js --workspace <path> --antigravity-path <path> --port <port> --bind-address <host> --config-dir <dir> [--wait-for-cdp true|false] [--extra-arg <value>]...');
        process.exit(1);
    }
}

// ============================================================================
// 常量
// ============================================================================

const ABSOLUTE_TIMEOUT_MS = 30000;  // 30 秒绝对超时
const WAIT_EXIT_TIMEOUT_MS = 12000; // 12 秒等待进程退出
const LAUNCH_DETECT_TIMEOUT_MS = 3000; // 3 秒等待新进程出现
const CDP_VERIFY_TIMEOUT_MS = 10000; // 10 秒 CDP 验证超时
const POLL_INTERVAL_MS = 500;       // 轮询间隔

function getStatusFile() {
    return path.join(getConfigDir(), `restart-status-${getRequestId()}.json`);
}

function getLegacyStatusFile() {
    return path.join(getConfigDir(), 'restart-status.json');
}

function getResultFile() {
    return path.join(getConfigDir(), `restart-result-${getRequestId()}.json`);
}

function getLegacyResultFile() {
    return path.join(getConfigDir(), 'restart-result.json');
}

function getWorkerLogFile() {
    return path.join(getConfigDir(), 'restart-worker.log');
}

// ============================================================================
// 日志收集
// ============================================================================

const logs = [];
const requestCreatedAt = Date.now();

function log(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    logs.push(logLine);
    try {
        fs.appendFileSync(getWorkerLogFile(), `${logLine}\n`);
    } catch {
        // ignore file logging failures
    }
}

function ensureConfigDir() {
    fs.mkdirSync(getConfigDir(), { recursive: true });
}

function updateStatus(phase, status = 'running', error = null) {
    const timestamp = Date.now();
    const statusData = {
        requestId: getRequestId(),
        phase,
        status,
        error,
        createdAt: requestCreatedAt,
        updatedAt: timestamp,
    };

    ensureConfigDir();
    const tmpFile = getStatusFile() + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
    fs.renameSync(tmpFile, getStatusFile());

    const legacyTmpFile = getLegacyStatusFile() + '.tmp';
    fs.writeFileSync(legacyTmpFile, JSON.stringify(statusData, null, 2));
    fs.renameSync(legacyTmpFile, getLegacyStatusFile());
}

function writeResult(status, phase, error = null, extra = {}) {
    const timestamp = new Date().toISOString();
    const result = {
        requestId: getRequestId(),
        status,
        phase,
        timestamp,
        error,
        createdAt: requestCreatedAt,
        updatedAt: Date.now(),
        logs,
        ...extra,
    };

    ensureConfigDir();
    const tmpFile = getResultFile() + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2));
    fs.renameSync(tmpFile, getResultFile());

    const legacyTmpFile = getLegacyResultFile() + '.tmp';
    fs.writeFileSync(legacyTmpFile, JSON.stringify(result, null, 2));
    fs.renameSync(legacyTmpFile, getLegacyResultFile());
    log(`Result written: ${status} at phase ${phase}`);
}

function exitWithError(phase, error) {
    log(`ERROR at ${phase}: ${error}`);
    updateStatus(phase, 'failed', error);
    writeResult('failed', phase, error);
    process.exit(1);
}

// ============================================================================
// Helper functions
// ============================================================================

async function waitForProcessGone(processPattern, timeoutMs = WAIT_EXIT_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
    const { execSync } = require('child_process');
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        try {
            execSync(`pgrep -f "${processPattern}"`, { stdio: 'ignore' });
            await new Promise((r) => setTimeout(r, intervalMs));
        } catch {
            // Process not found
            return true;
        }
    }
    return false;
}

async function waitForProcessAppeared(processPattern, timeoutMs = LAUNCH_DETECT_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
    const { execSync } = require('child_process');
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        try {
            const output = execSync(`pgrep -af "${processPattern}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (String(output || '').trim()) {
                return true;
            }
        } catch {
            // Not found yet
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }

    return false;
}

async function verifyCdpReady(host, port, timeoutMs = CDP_VERIFY_TIMEOUT_MS) {
    const started = Date.now();
    const interval = 500;

    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(`http://${host}:${port}/json/version`);
            if (res.ok) {
                return true;
            }
        } catch {
            // Not ready yet
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return false;
}

function buildLaunchArgs() {
    const workspace = getWorkspace();
    const port = getPort();
    const bindAddress = getBindAddress();
    const extraArgs = getExtraArgs();

    const args = [
        workspace,
        '--new-window',
        `--remote-debugging-port=${port}`,
        `--remote-debugging-address=${bindAddress}`,
        ...extraArgs,
    ];

    return args;
}

// ============================================================================
// Phase 1: Kill old process
// ============================================================================

async function phase1_killOldProcess() {
    log('Phase 1: Killing old Antigravity process');
    updateStatus('killing_old_process');

    const executable = getAntigravityPath();
    const { execSync } = require('child_process');

    try {
        if (process.platform === 'win32') {
            // Windows: use taskkill
            const processName = path.basename(executable, path.extname(executable));
            const imageName = processName.endsWith('.exe') ? processName : `${processName}.exe`;
            log(`Killing ${imageName} via taskkill...`);
            execSync(`taskkill /im ${imageName} /f`, { stdio: 'ignore' });
        } else {
            // macOS/Linux: use pkill
            const appName = executable.includes('Antigravity') ? 'Antigravity' : 'Cursor';
            log(`Killing ${appName} via pkill...`);

            // Try SIGTERM first
            try {
                execSync(`pkill -f "${appName}"`, { stdio: 'ignore' });
                log('Sent SIGTERM');
            } catch {
                // No matching process
            }

            // Wait a bit for graceful shutdown
            await new Promise((r) => setTimeout(r, 500));

            // Check if still running, force kill if needed
            try {
                execSync(`pgrep -f "${appName}"`, { stdio: 'ignore' });
                // Still running, force kill
                execSync(`pkill -9 -f "${appName}"`, { stdio: 'ignore' });
                log('Sent SIGKILL');
            } catch {
                // Process already gone
            }
        }

        log('Kill command sent');
    } catch (error) {
        log(`Warning: kill command failed: ${error.message}`);
        // Continue anyway - process might already be dead
    }
}

// ============================================================================
// Phase 2: Wait for exit
// ============================================================================

async function phase2_waitForExit() {
    log('Phase 2: Waiting for process to exit');
    updateStatus('waiting_for_exit');

    const executable = getAntigravityPath();
    const appName = executable.includes('Antigravity') ? 'Antigravity' : 'Cursor';

    const gone = await waitForProcessGone(appName, WAIT_EXIT_TIMEOUT_MS);

    if (gone) {
        log('Process confirmed gone');
    } else {
        log('Process may still be running after timeout');
        // Continue anyway - launch will handle it
    }
}

// ============================================================================
// Phase 3: Launch new process
// ============================================================================

async function phase3_launchNewProcess() {
    log('Phase 3: Launching new Antigravity process');
    updateStatus('launching_new_process');

    const executable = getAntigravityPath();
    const args = buildLaunchArgs();
    const processPattern = process.platform === 'darwin'
        ? `Antigravity.*--remote-debugging-port=${getPort()}`
        : executable;

    log(`Launch command: ${executable} ${args.join(' ')}`);

    const launchDirectly = () => {
        const child = spawn(executable, args, {
            detached: true,
            stdio: 'ignore',
            shell: false,
        });
        child.unref();
        return child;
    };

    try {
        let launchedVia = 'direct';

        if (process.platform === 'darwin') {
            const appMatch = executable.match(/^(.+\.app)/);
            if (appMatch) {
                const appName = path.basename(appMatch[1], '.app');
                const child = spawn('open', ['-a', appName, '--args', ...args], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false,
                });
                child.unref();
                launchedVia = `open -a ${appName}`;
                log(`Launched via '${launchedVia}'`);

                let appeared = await waitForProcessAppeared(processPattern, LAUNCH_DETECT_TIMEOUT_MS);
                if (!appeared) {
                    log(`Process did not appear after '${launchedVia}', falling back to direct executable launch`);
                    launchDirectly();
                    launchedVia = 'direct fallback';
                    appeared = await waitForProcessAppeared(processPattern, LAUNCH_DETECT_TIMEOUT_MS);
                }
                if (!appeared) {
                    throw new Error(`Antigravity process did not appear after launch via ${launchedVia}`);
                }
                log('Antigravity process detected after launch');
                return { processDetected: true };
            } else {
                launchDirectly();
                log('Launched directly');
            }
        } else if (process.platform === 'win32') {
            const child = spawn(executable, args, {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            log('Launched on Windows');
        } else {
            launchDirectly();
            log('Launched on Linux');
        }

        const appeared = await waitForProcessAppeared(processPattern, LAUNCH_DETECT_TIMEOUT_MS);
        if (!appeared) {
            throw new Error(`Antigravity process did not appear after launch via ${launchedVia}`);
        }

        log('Antigravity process detected after launch');
        return { processDetected: true };
    } catch (error) {
        throw new Error(`Launch failed: ${error.message}`);
    }
}

// ============================================================================
// Phase 4: Verify CDP
// ============================================================================

async function phase4_verifyCdp(processLaunchResult = {}) {
    if (!getWaitForCdp()) {
        log('Phase 4: Skipping CDP verification (disabled)');
        return { cdpVerified: false, skipped: true, ...processLaunchResult };
    }

    log('Phase 4: Verifying CDP readiness');
    updateStatus('waiting_for_cdp');

    const host = getBindAddress();
    const port = getPort();

    log(`Checking CDP on ${host}:${port}...`);

    const cdpReady = await verifyCdpReady(host, port, CDP_VERIFY_TIMEOUT_MS);

    if (cdpReady) {
        log(`CDP verified on ${host}:${port}`);
        return { cdpVerified: true, ...processLaunchResult };
    } else {
        log(`CDP not responding on ${host}:${port} after ${CDP_VERIFY_TIMEOUT_MS}ms`);
        return {
            cdpVerified: false,
            error: processLaunchResult.processDetected
                ? `Antigravity relaunched but CDP did not respond on port ${port}`
                : `Antigravity did not relaunch on port ${port}`,
            ...processLaunchResult,
        };
    }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    validateArgs();
    const coldStart = getColdStart();

    log('=== Antigravity Restart Worker Started ===');
    log(`Request ID: ${getRequestId()}`);
    log(`Mode: ${coldStart ? 'cold-start' : 'restart'}`);
    log(`Workspace: ${getWorkspace()}`);
    log(`Antigravity: ${getAntigravityPath()}`);
    log(`Port: ${getPort()}`);
    log(`Bind Address: ${getBindAddress()}`);
    log(`Wait for CDP: ${getWaitForCdp()}`);
    log(`Extra Args: ${getExtraArgs().join(' ')}`);

    updateStatus('starting');

    const absoluteTimeout = setTimeout(() => {
        log('ABSOLUTE TIMEOUT REACHED');
        writeResult('timeout', 'unknown', 'Worker exceeded 30s absolute timeout');
        process.exit(1);
    }, ABSOLUTE_TIMEOUT_MS);

    try {
        // 冷启动模式跳过 kill 和 wait
        if (!coldStart) {
            await phase1_killOldProcess();
            await phase2_waitForExit();
        } else {
            log('Cold start mode: skipping kill and wait phases');
        }

        const launchResult = await phase3_launchNewProcess();
        const cdpResult = await phase4_verifyCdp(launchResult);

        updateStatus('complete', 'success');
        writeResult('success', 'complete', null, {
            port: getPort(),
            workspace: getWorkspace(),
            mode: coldStart ? 'cold-start' : 'restart',
            ...cdpResult,
        });

        clearTimeout(absoluteTimeout);
        log(`=== ${coldStart ? 'Cold start' : 'Restart'} completed successfully ===`);
        process.exit(0);

    } catch (error) {
        clearTimeout(absoluteTimeout);
        exitWithError('unknown', error.message);
    }
}

// ============================================================================
// 启动
// ============================================================================

if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = {
    __testExports: {
        parseArgs,
        buildLaunchArgs,
        validateArgs,
        getWorkspace,
        getAntigravityPath,
        getPort,
        getBindAddress,
        getExtraArgs,
        getColdStart,
    },
};
