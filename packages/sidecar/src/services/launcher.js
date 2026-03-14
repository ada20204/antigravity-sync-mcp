const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { buildAiConfigPrompt } = require('../core/ai-config');

const MCP_HOME_DIR = path.join(os.homedir(), '.config', 'antigravity-mcp');
const MCP_BIN_DIR = path.join(MCP_HOME_DIR, 'bin');
const MCP_METADATA_FILE = path.join(MCP_HOME_DIR, 'install-meta.json');

function getBundledServerEntryPath(context) {
    return path.join(context.extensionPath, 'server-runtime', 'dist', 'index.js');
}

function getLauncherPaths() {
    const unixLauncher = path.join(MCP_BIN_DIR, 'antigravity-mcp-server');
    const windowsLauncher = path.join(MCP_BIN_DIR, 'antigravity-mcp-server.cmd');
    return { unixLauncher, windowsLauncher };
}

function ensureMcpLauncher(context) {
    const entryPath = getBundledServerEntryPath(context);
    if (!fs.existsSync(entryPath)) {
        return { ok: false, error: `Bundled server entry missing: ${entryPath}` };
    }
    if (!fs.existsSync(MCP_BIN_DIR)) {
        fs.mkdirSync(MCP_BIN_DIR, { recursive: true });
    }

    const { unixLauncher, windowsLauncher } = getLauncherPaths();
    const entryForShell = entryPath.replace(/"/g, '\\"');
    const unixScript = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `exec node "${entryForShell}" "$@"`,
        '',
    ].join('\n');
    fs.writeFileSync(unixLauncher, unixScript, { encoding: 'utf-8', mode: 0o755 });
    try {
        fs.chmodSync(unixLauncher, 0o755);
    } catch { }

    const entryForCmd = entryPath.replace(/"/g, '""');
    const cmdScript = [
        '@echo off',
        `node "${entryForCmd}" %*`,
        '',
    ].join('\r\n');
    fs.writeFileSync(windowsLauncher, cmdScript, 'utf-8');

    const metadata = {
        version: context.extension.packageJSON && context.extension.packageJSON.version
            ? String(context.extension.packageJSON.version)
            : 'unknown',
        extensionPath: context.extensionPath,
        bundledServer: entryPath,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MCP_METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    try {
        fs.chmodSync(MCP_METADATA_FILE, 0o600);
    } catch { }

    return {
        ok: true,
        entryPath,
        unixLauncher,
        windowsLauncher,
    };
}

function splitArgs(raw) {
    const source = String(raw || '').trim();
    if (!source) return [];
    return source.split(/\s+/).filter(Boolean);
}

function resolveDefaultExecutablePath() {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local');
        const candidates = [
            path.win32.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
            '/Applications/Antigravity.app/Contents/MacOS/Electron',
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return '';
    }

    const candidates = [
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

function psQuote(value) {
    return String(value || '').replace(/'/g, "''");
}

function resolveCdpBindAddress() {
    const override = String(process.env.ANTIGRAVITY_CDP_BIND_ADDRESS || '').trim();
    return override || '127.0.0.1';
}

function buildLaunchArgsForWorkspace(workspacePath, port, extraArgs) {
    return [
        workspacePath,
        '--new-window',
        `--remote-debugging-port=${port}`,
        `--remote-debugging-address=${resolveCdpBindAddress()}`,
        ...extraArgs,
    ];
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildKillMatcher(dependencies = {}, params = {}) {
    return params.killMatcher
        || dependencies.killMatcher
        || {
            pgrepArgs: ['-f', 'Antigravity'],
            pkillArgs: ['-f', 'Antigravity'],
            forceKillArgs: ['-9', '-f', 'Antigravity'],
        };
}

function createExecutableKillMatcher(executable) {
    const matchTarget = String(executable || '').trim();
    if (!matchTarget) {
        return buildKillMatcher();
    }
    return {
        pgrepArgs: ['-f', matchTarget],
        pkillArgs: ['-f', matchTarget],
        forceKillArgs: ['-9', '-f', matchTarget],
    };
}

function launchDetached(executable, args, dependencies = {}) {
    const spawnImpl = dependencies.spawn || spawn;
    const platform = dependencies.platform || process.platform;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    if (platform === 'win32') {
        const child = spawnImpl(executable, args, {
            detached: true,
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
            env,
        });
        if (child && typeof child.unref === 'function') child.unref();
        return child;
    }

    // macOS/Linux: Use bash -c to properly pass arguments through shell script wrapper.
    const escapedArgs = args.map(shellQuote);
    const cmd = `exec ${shellQuote(executable)}${escapedArgs.length ? ` ${escapedArgs.join(' ')}` : ''}`;

    const child = spawnImpl('bash', ['-c', cmd], {
        detached: true,
        stdio: 'ignore',
        env,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return child;
}

function performRestartShutdown(dependencies = {}, options = {}) {
    const spawnImpl = dependencies.spawn || spawn;
    const spawnSyncImpl = dependencies.spawnSync || spawnSync;
    const nowImpl = dependencies.now || Date.now;
    const platform = dependencies.platform || process.platform;
    const matcher = buildKillMatcher(dependencies, options);
    const waitImpl = dependencies.wait || ((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* busy wait */ }
    });
    const observer = options.observer || null;

    if (platform === 'win32') {
        if (observer && typeof observer.onKillStart === 'function') observer.onKillStart();
        const script = "$ErrorActionPreference='SilentlyContinue'; Get-Process Antigravity | Stop-Process -Force; $deadline=(Get-Date).AddSeconds(8); while((Get-Date)-lt $deadline){if(-not(Get-Process Antigravity -EA SilentlyContinue)){break};Start-Sleep -Milliseconds 200}";
        spawnImpl('powershell.exe', ['-NoProfile', '-Command', script], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        if (observer && typeof observer.onKillComplete === 'function') observer.onKillComplete({ forced: false });
        return;
    }

    if (observer && typeof observer.onKillStart === 'function') observer.onKillStart();
    try {
        spawnImpl('pkill', matcher.pkillArgs, { stdio: 'ignore' });
    } catch { }

    const deadline = nowImpl() + 3000;
    let processExited = false;

    while (nowImpl() < deadline) {
        try {
            if (observer && typeof observer.onProbe === 'function') observer.onProbe({ phase: 'term-check' });
            const result = spawnSyncImpl('pgrep', matcher.pgrepArgs, { encoding: 'utf8' });
            const output = (result.stdout || '').trim();
            if (!output) {
                processExited = true;
                break;
            }
        } catch {
            processExited = true;
            break;
        }
        waitImpl(500);
    }

    let forced = false;
    if (!processExited) {
        forced = true;
        try {
            spawnImpl('pkill', matcher.forceKillArgs, { stdio: 'ignore' });
        } catch { }

        const forceDeadline = nowImpl() + 2000;
        while (nowImpl() < forceDeadline) {
            try {
                if (observer && typeof observer.onProbe === 'function') observer.onProbe({ phase: 'kill-check' });
                const result = spawnSyncImpl('pgrep', matcher.pgrepArgs, { encoding: 'utf8' });
                if (!(result.stdout || '').trim()) break;
            } catch {
                break;
            }
            waitImpl(200);
        }
    }

    if (observer && typeof observer.onKillComplete === 'function') observer.onKillComplete({ forced });
}

function createRestartPrimitive(dependencies = {}) {
    return function restartPrimitive(params) {
        const { executable, args = [], restart = false, observer, killMatcher } = params;
        if (restart) {
            performRestartShutdown(dependencies, { observer, killMatcher });
        }
        if (observer && typeof observer.onBeforeLaunch === 'function') {
            observer.onBeforeLaunch({ executable, args: [...args], restart });
        }
        const child = launchDetached(executable, args, dependencies);
        if (observer && typeof observer.onAfterLaunch === 'function') {
            observer.onAfterLaunch({ executable, args: [...args], restart, child });
        }
        return child;
    };
}

function launchAntigravityDetached(params) {
    return createRestartPrimitive()(params);
}

module.exports = {
    MCP_HOME_DIR,
    MCP_BIN_DIR,
    MCP_METADATA_FILE,
    getBundledServerEntryPath,
    getLauncherPaths,
    ensureMcpLauncher,
    buildAiConfigPrompt,
    splitArgs,
    resolveDefaultExecutablePath,
    psQuote,
    resolveCdpBindAddress,
    buildLaunchArgsForWorkspace,
    createExecutableKillMatcher,
    createRestartPrimitive,
    launchAntigravityDetached,
};
