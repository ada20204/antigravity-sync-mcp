const vscode = require('vscode');

function registerCommands(context, deps) {
    const {
        runtimeRole,
        outputChannel,
        ensureMcpLauncher,
        buildAiConfigPrompt,
        getLauncherPaths,
        getBundledServerEntryPath,
        executeManualLaunch,
        requestHostRestart,
        refreshQuota,
        summarizeQuota,
        formatQuotaReport,
        getLatestQuota,
        getLatestQuotaError,
        getWorkspacePath,
        log,
    } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.toggle', async () => {
        const cdpTarget = deps.getCdpTarget();
        if (!cdpTarget) {
            vscode.window.showWarningMessage('Sidecar: No CDP port found. Cannot toggle auto-accept.');
            return;
        }
        const nextEnabled = !deps.getIsEnabled();
        deps.setIsEnabled(nextEnabled);
        await vscode.workspace.getConfiguration('antigravityMcpSidecar').update('enabled', nextEnabled, vscode.ConfigurationTarget.Global);
        deps.syncState();
        vscode.window.showInformationMessage(`Sidecar Auto-Accept: ${nextEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.launchAntigravity', async () => {
        if (runtimeRole === 'remote') {
            vscode.window.showInformationMessage('Remote sidecar cannot cold-start host app. Please launch Antigravity on host.');
            return;
        }
        await executeManualLaunch('launch');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.installBundledServer', async () => {
        const result = ensureMcpLauncher(context);
        if (!result.ok) {
            vscode.window.showErrorMessage(`Bundled server install failed: ${result.error}`);
            return;
        }
        const launcher = process.platform === 'win32' ? result.windowsLauncher : result.unixLauncher;
        const prompt = buildAiConfigPrompt({
            launcherPath: launcher,
            entryPath: result.entryPath,
            workspacePath: getWorkspacePath(),
        });
        outputChannel.show(true);
        outputChannel.appendLine('=== Antigravity MCP Bundled Server ===');
        outputChannel.appendLine(`entry: ${result.entryPath}`);
        outputChannel.appendLine(`launcher(unix): ${result.unixLauncher}`);
        outputChannel.appendLine(`launcher(win): ${result.windowsLauncher}`);
        outputChannel.appendLine('');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(`Bundled MCP server ready. AI config prompt copied to clipboard. Launcher: ${launcher}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showAiConfigPrompt', async () => {
        const { unixLauncher, windowsLauncher } = getLauncherPaths();
        const launcher = process.platform === 'win32' ? windowsLauncher : unixLauncher;
        const prompt = buildAiConfigPrompt({
            launcherPath: launcher,
            entryPath: getBundledServerEntryPath(context),
            workspacePath: getWorkspacePath(),
        });
        outputChannel.show(true);
        outputChannel.appendLine('=== Antigravity MCP AI Config Prompt ===');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('AI config prompt copied to clipboard and written to output.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.requestHostRestart', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Submit host restart request now? This requires a configured host-bridge transport.',
            { modal: true },
            'Submit'
        );
        if (confirm !== 'Submit') return;
        await requestHostRestart({ reason: 'manual_command' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.restartAntigravity', async () => {
        if (runtimeRole === 'remote') {
            const confirm = await vscode.window.showWarningMessage(
                'Request host restart now? This requires a configured host-bridge transport.',
                { modal: true },
                'Request Restart'
            );
            if (confirm !== 'Request Restart') return;
            await requestHostRestart({ reason: 'restart_command' });
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'Restart Antigravity now? This may interrupt your current window/session.',
            { modal: true },
            'Restart'
        );
        if (confirm !== 'Restart') return;
        await executeManualLaunch('restart');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showQuota', async () => {
        const latestQuota = getLatestQuota();
        const latestQuotaError = getLatestQuotaError();
        const report = formatQuotaReport(latestQuota, latestQuotaError);
        outputChannel.show(true);
        for (const line of report.split('\n')) {
            outputChannel.appendLine(line);
        }
        if (!latestQuota && latestQuotaError) {
            log(`Quota snapshot unavailable: ${latestQuotaError}`);
            return;
        }
        const summary = summarizeQuota(latestQuota);
        if (summary && summary.primaryPercent !== null) {
            log(`Quota: ${summary.primaryPercent.toFixed(1)}% remaining (${summary.primaryLabel})`);
        } else {
            log('Quota snapshot written to output channel.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.showQuotaTable', async () => {
        const latestQuota = getLatestQuota();
        const models = Array.isArray(latestQuota && latestQuota.models) ? latestQuota.models : [];
        outputChannel.show(true);
        if (models.length === 0) {
            outputChannel.appendLine('No model quota snapshot available yet.');
            log('No model quota snapshot available yet.');
            return;
        }

        const sorted = [...models].sort((a, b) =>
            String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || ''))
        );
        outputChannel.appendLine('=== Antigravity Model Quota ===');
        for (const model of sorted) {
            const id = model.modelId || model.label || 'unknown';
            const remaining = typeof model.remainingPercentage === 'number'
                ? `${model.remainingPercentage.toFixed(1)}%`
                : 'n/a';
            const selectedMark = model.isSelected ? ' [active]' : '';
            outputChannel.appendLine(`${id}${selectedMark}: remaining=${remaining} exhausted=${model.isExhausted ? 'yes' : 'no'}${model.resetTime ? ` reset=${model.resetTime}` : ''}`);
        }
        log(`Quota table written to output channel (${sorted.length} models).`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.refreshQuota', async () => {
        try {
            await refreshQuota();
            const summary = summarizeQuota(getLatestQuota());
            if (summary && summary.primaryPercent !== null) {
                log(`Quota refreshed: ${summary.primaryPercent.toFixed(1)}% (${summary.primaryLabel})`);
            } else {
                log('Quota refreshed.');
            }
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            log(`Quota refresh failed: ${message}`);
        }
    }));
}

module.exports = {
    registerCommands,
};
