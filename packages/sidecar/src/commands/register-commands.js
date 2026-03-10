const vscode = require('vscode');

function getAccountService() {
    return require('../services/account-service');
}

const nullAccountCommandAdapter = {
    async runSwitchAccountCommand() {
        vscode.window.showErrorMessage('Sidecar: Account commands unavailable.');
    },
    async runAddAnotherAccountCommand() {
        vscode.window.showErrorMessage('Sidecar: Account commands unavailable.');
    },
    async runAccountStatusCommand() {
        vscode.window.showErrorMessage('Sidecar: Account commands unavailable.');
    },
    async runDeleteAccountCommand() {
        vscode.window.showErrorMessage('Sidecar: Account commands unavailable.');
    },
};

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
        accountCommandAdapter = nullAccountCommandAdapter,
        log,
    } = deps;

    log('registerCommands: starting command registration');
    outputChannel.appendLine('[Sidecar] registerCommands: starting command registration');

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
            vscode.window.showInformationMessage('Sidecar: Remote sidecar cannot cold-start the host app. Please launch Antigravity on host.');
            return;
        }
        await executeManualLaunch('launch');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.installBundledServer', async () => {
        const result = ensureMcpLauncher(context);
        if (!result.ok) {
        vscode.window.showErrorMessage(`Sidecar: Bundled server install failed: ${result.error}`);
            return;
        }
        const launcher = process.platform === 'win32' ? result.windowsLauncher : result.unixLauncher;
        const prompt = buildAiConfigPrompt({
            launcherPath: launcher,
            entryPath: result.entryPath,
            workspacePath: getWorkspacePath(),
        });
        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Bundled MCP Server ===');
        outputChannel.appendLine(`entry: ${result.entryPath}`);
        outputChannel.appendLine(`launcher(unix): ${result.unixLauncher}`);
        outputChannel.appendLine(`launcher(win): ${result.windowsLauncher}`);
        outputChannel.appendLine('');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(`Sidecar: Bundled MCP server ready. AI config prompt copied to clipboard. Launcher: ${launcher}`);
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
        outputChannel.appendLine('=== Sidecar: AI Config Prompt ===');
        outputChannel.appendLine(prompt);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Sidecar: AI config prompt copied to clipboard and written to output.');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.requestHostRestart', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Sidecar: Submit host restart request now? This requires a configured host-bridge transport.',
            { modal: true },
            'Submit'
        );
        if (confirm !== 'Submit') return;
        await requestHostRestart({ reason: 'manual_command' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.restartAntigravity', async () => {
        if (runtimeRole === 'remote') {
            const confirm = await vscode.window.showWarningMessage(
                'Sidecar: Request host restart now? This requires a configured host-bridge transport.',
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
        await executeManualLaunch('restart', { exitAfterWorkerStart: true });
        // Worker is now waiting for Antigravity to exit; close the window to trigger that.
        setTimeout(async () => {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.commands.executeCommand('workbench.action.quit');
        }, 500);
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
        outputChannel.appendLine('=== Sidecar: Quota Table ===');
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

    // ─── Account Test Commands ───────────────────────────────────────

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountReadDb', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Test Read Current Auth ===');
        try {
            const dbPath = accountService.getAntigravityDbPath();
            outputChannel.appendLine(`DB path: ${dbPath}`);

            const fields = await accountService.readCurrentAuthFields();

            if (fields.authStatus) {
                const email = accountService.extractEmail(fields.authStatus);
                outputChannel.appendLine(`Current account: ${email || '(no email found)'}`);
                outputChannel.appendLine(`authStatus length: ${fields.authStatus.length} chars`);
            } else {
                outputChannel.appendLine('No authStatus found (not logged in)');
            }

            outputChannel.appendLine(`oauthToken: ${fields.oauthToken ? `${fields.oauthToken.length} chars` : 'null'}`);
            outputChannel.appendLine(`userStatus: ${fields.userStatus ? `${fields.userStatus.length} chars` : 'null'}`);
            log('Account DB read test completed.');
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            log(`Account DB read test failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountSave', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Test Save Current Account ===');
        try {
            const result = await accountService.saveCurrentAccount();
            outputChannel.appendLine(`Saved account: ${result.email}`);
            outputChannel.appendLine(`Backup file: ${result.filePath}`);
            vscode.window.showInformationMessage(`Sidecar: Saved account ${result.email}`);
            log(`Account saved: ${result.email}`);
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            vscode.window.showErrorMessage(`Sidecar: Save failed: ${e.message}`);
            log(`Account save failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountList', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Test List Saved Accounts ===');
        const accounts = accountService.listSavedAccounts();
        if (accounts.length === 0) {
            outputChannel.appendLine('Sidecar: No saved accounts found.');
            log('No saved accounts.');
            return;
        }
        for (const acc of accounts) {
            outputChannel.appendLine(`  ${acc.email} (modified: ${acc.modifiedTime.toISOString()})`);
        }
        outputChannel.appendLine(`Total: ${accounts.length} accounts`);
        log(`Found ${accounts.length} saved accounts.`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountClearAndReload', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'Sidecar: This will clear Antigravity auth data and reload the window. ' +
            'Make sure you have saved the current account first!\n\n' +
            'This tests whether reload causes Antigravity to re-read auth state from DB.',
            { modal: true },
            'Save & Clear & Reload',
            'Clear & Reload (skip save)'
        );
        if (!confirm) return;

        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Test Clear Auth and Reload ===');

        try {
            // 先备份（如果选择了保存）
            if (confirm === 'Save & Clear & Reload') {
                try {
                    const saveResult = await accountService.saveCurrentAccount();
                    outputChannel.appendLine(`Backup saved: ${saveResult.email} -> ${saveResult.filePath}`);
                } catch (e) {
                    outputChannel.appendLine(`Backup warning: ${e.message} (continuing anyway)`);
                }
            }

            // 清除 auth 字段
            const clearResult = await accountService.clearAuthFields();
            outputChannel.appendLine(`Cleared ${clearResult.cleared} fields from ${clearResult.dbPath}`);
            outputChannel.appendLine('Reloading window in 1 second...');

            // 延迟 1 秒后 reload，让用户看到输出
            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }, 1000);
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            vscode.window.showErrorMessage(`Sidecar: Clear failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountRestore', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        const accounts = accountService.listSavedAccounts();
        if (accounts.length === 0) {
            vscode.window.showWarningMessage('Sidecar: No saved accounts found. Save an account first.');
            return;
        }

        const picked = await vscode.window.showQuickPick(
            accounts.map(a => ({
                label: a.email,
                description: `Modified: ${a.modifiedTime.toISOString()}`,
            })),
            { placeHolder: 'Select account to restore' }
        );
        if (!picked) return;

        const confirm = await vscode.window.showWarningMessage(
            `Restore account "${picked.label}" and reload window?`,
            { modal: true },
            'Restore & Reload'
        );
        if (confirm !== 'Restore & Reload') return;

        outputChannel.show(true);
        outputChannel.appendLine(`=== Sidecar: Test Restore Account ${picked.label} ===`);

        try {
            // 先清除
            const clearResult = await accountService.clearAuthFields();
            outputChannel.appendLine(`Cleared ${clearResult.cleared} fields`);

            // 还原
            const fields = accountService.loadBackupFields(picked.label);
            const restoreResult = await accountService.restoreAuthFields(fields);
            outputChannel.appendLine(`Restored ${restoreResult.restored} fields`);
            outputChannel.appendLine('Reloading window in 1 second...');

            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }, 1000);
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            vscode.window.showErrorMessage(`Sidecar: Restore failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountClearAndRestart', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'Sidecar: This will clear Antigravity auth data and fully restart Antigravity. After restart, you should be logged out if the DB reload path works. Make sure you have saved the current account first.',
            { modal: true },
            'Save & Clear & Restart',
            'Clear & Restart (skip save)'
        );
        if (!confirm) return;

        outputChannel.show(true);
        outputChannel.appendLine('=== Sidecar: Test Clear Auth and Restart ===');

        try {
            if (confirm === 'Save & Clear & Restart') {
                try {
                    const saveResult = await accountService.saveCurrentAccount();
                    outputChannel.appendLine(`Backup saved: ${saveResult.email} -> ${saveResult.filePath}`);
                } catch (e) {
                    outputChannel.appendLine(`Backup warning: ${e.message} (continuing anyway)`);
                }
            }

            const clearResult = await accountService.clearAuthFields();
            outputChannel.appendLine(`Cleared ${clearResult.cleared} fields from ${clearResult.dbPath}`);
            outputChannel.appendLine('Requesting Sidecar restart flow for Antigravity...');
            await executeManualLaunch('restart');
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            vscode.window.showErrorMessage(`Sidecar: Clear and restart failed: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.testAccountRestoreAndRestart', async () => {
        let accountService;
        try {
            accountService = getAccountService();
        } catch (error) {
            vscode.window.showErrorMessage(`Sidecar: Account service failed to load: ${error.message}`);
            log(`Account service load failed: ${error.message}`);
            return;
        }
        const accounts = accountService.listSavedAccounts();
        if (accounts.length === 0) {
            vscode.window.showWarningMessage('Sidecar: No saved accounts found. Save an account first.');
            return;
        }

        const picked = await vscode.window.showQuickPick(
            accounts.map(a => ({
                label: a.email,
                description: `Modified: ${a.modifiedTime.toISOString()}`,
            })),
            { placeHolder: 'Select account to restore after full restart' }
        );
        if (!picked) return;

        const confirm = await vscode.window.showWarningMessage(
            `Restore account "${picked.label}" and fully restart Antigravity?`,
            { modal: true },
            'Restore & Restart'
        );
        if (confirm !== 'Restore & Restart') return;

        outputChannel.show(true);
        outputChannel.appendLine(`=== Sidecar: Test Restore Account ${picked.label} and Restart ===`);

        try {
            const currentFields = await accountService.readCurrentAuthFields();
            const currentEmail = currentFields.authStatus ? accountService.extractEmail(currentFields.authStatus) : null;
            outputChannel.appendLine(`Current account: ${currentEmail || '(not logged in)'}`);
            outputChannel.appendLine(`Target account: ${picked.label}`);

            const clearResult = await accountService.clearAuthFields();
            outputChannel.appendLine(`Cleared ${clearResult.cleared} fields`);

            const fields = accountService.loadBackupFields(picked.label);
            const restoreResult = await accountService.restoreAuthFields(fields);
            outputChannel.appendLine(`Restored ${restoreResult.restored} fields`);
            outputChannel.appendLine('Requesting Sidecar restart flow for Antigravity...');
            await executeManualLaunch('restart');
        } catch (e) {
            outputChannel.appendLine(`ERROR: ${e.message}`);
            vscode.window.showErrorMessage(`Sidecar: Restore and restart failed: ${e.message}`);
        }
    }));

    // ─── Real Account Switch Command ──────────────────────────────────

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.switchAccount', async () => {
        await accountCommandAdapter.runSwitchAccountCommand();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.addAnotherAccount', async () => {
        await accountCommandAdapter.runAddAnotherAccountCommand();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.accountStatus', async () => {
        await accountCommandAdapter.runAccountStatusCommand();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.deleteAccount', async () => {
        await accountCommandAdapter.runDeleteAccountCommand();
    }));

    log('registerCommands: completed command registration');
    outputChannel.appendLine('[Sidecar] registerCommands: completed command registration');
}

module.exports = {
    registerCommands,
};
