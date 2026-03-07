const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
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

function launchAntigravityDetached(params) {
    const { executable, args, restart } = params;
    if (process.platform === 'win32') {
        const exe = psQuote(executable);
        const argList = args.map((item) => `'${psQuote(item)}'`).join(',');
        const script = restart
            ? `$ErrorActionPreference='SilentlyContinue'; Get-Process Antigravity | Stop-Process -Force; $deadline=(Get-Date).AddSeconds(8); while((Get-Date)-lt $deadline){if(-not(Get-Process Antigravity -EA SilentlyContinue)){break};Start-Sleep -Milliseconds 200}; Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`
            : `Start-Process -FilePath '${exe}' -ArgumentList @(${argList})`;

        const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        return;
    }

    if (restart) {
        try {
            spawn('pkill', ['-f', 'Antigravity'], { stdio: 'ignore' });
        } catch { }
    }
    const child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
    });
    child.unref();
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
    launchAntigravityDetached,
};
