function toQuickPickItem(account) {
  return {
    label: account.email,
    description: `Modified: ${account.modifiedTime.toISOString()}`,
  };
}

function defaultEqualsAccount(left, right) {
  return Boolean(left && right && left === right);
}

function formatAcceptedMessage(result, targetEmail) {
  if (result?.requestId) {
    return `Switch request accepted for ${targetEmail}. Request ID: ${result.requestId}`;
  }
  return `Switch request accepted for ${targetEmail}.`;
}

function formatPendingMessage(result, targetEmail) {
  if (result?.status) {
    return `Switch status: ${result.status} (${targetEmail})`;
  }
  return `Switch pending for ${targetEmail}.`;
}

function closeAndQuit(vscodeApi) {
  setTimeout(async () => {
    await vscodeApi.commands.executeCommand('workbench.action.closeAllEditors');
    await vscodeApi.commands.executeCommand('workbench.action.quit');
  }, 1500);
}

function noOpSwitch({ outputChannel, vscodeApi, log, targetEmail, currentEmail }) {
  outputChannel.appendLine(`Current account: ${currentEmail || '(not logged in)'}`);
  outputChannel.appendLine(`Target account: ${targetEmail}`);
  outputChannel.appendLine('No-op: current account already matches target account.');
  vscodeApi.window.showInformationMessage(`Sidecar: Already using account ${targetEmail}`);
  log(`Switch skipped because current account already matches target: ${targetEmail}`);
}

async function getSelectedAccount({ controller, vscodeApi }) {
  const accounts = await controller.listAccounts();
  if (!accounts || accounts.length === 0) {
    vscodeApi.window.showWarningMessage('Sidecar: No saved accounts found. Save an account first.');
    return null;
  }

  const picked = await vscodeApi.window.showQuickPick(
    accounts.map(toQuickPickItem),
    { placeHolder: 'Select account to switch to' },
  );

  return picked?.label ?? null;
}

async function confirmSwitch({ vscodeApi, targetEmail }) {
  const confirm = await vscodeApi.window.showWarningMessage(
    `Sidecar: Switch to account "${targetEmail}"?\n\n` +
      '⚠️ Antigravity will quit and restart automatically.\n' +
      'All open editors will be closed.',
    { modal: true },
    'Switch Account',
  );

  return confirm === 'Switch Account';
}

async function confirmAddAnotherAccount({ vscodeApi }) {
  const confirm = await vscodeApi.window.showWarningMessage(
    'Sidecar: Save current account and add another account?\n\n'
      + '⚠️ Antigravity will quit and restart automatically.\n'
      + 'All open editors will be closed.\n'
      + 'After restart, sign in with the new account.',
    { modal: true },
    'Save and Restart',
  );

  return confirm === 'Save and Restart';
}

function formatAccountStatusReport({ currentAccount, quota, summarizeQuota: summarize }) {
  const lines = ['=== Sidecar: Account Status ==='];

  if (currentAccount) {
    lines.push(`account: ${currentAccount.email}`);
  } else {
    lines.push('account: (not logged in)');
  }

  if (!quota) {
    lines.push('quota: no snapshot available');
    return lines.join('\n');
  }

  if (quota.timestamp) {
    const ageMs = Date.now() - Number(quota.timestamp);
    const ageSec = Math.round(ageMs / 1000);
    lines.push(`quota snapshot age: ${ageSec}s`);
  }

  const summary = summarize ? summarize(quota) : null;
  if (summary) {
    if (summary.activeModelName) {
      lines.push(`active model: ${summary.activeModelName}`);
    }
    if (summary.activeModelRemaining !== null && summary.activeModelRemaining !== undefined) {
      lines.push(`active model quota: ${summary.activeModelRemaining.toFixed(1)}%`);
    }
    if (summary.promptRemaining !== null && summary.promptRemaining !== undefined) {
      lines.push(`prompt credits: ${summary.promptRemaining.toFixed(1)}%`);
    }
    if (summary.modelCount > 0) {
      lines.push(`models tracked: ${summary.modelCount}${summary.exhaustedCount > 0 ? `, exhausted: ${summary.exhaustedCount}` : ''}`);
    }
  }

  const models = Array.isArray(quota.models) ? quota.models : [];
  if (models.length > 0) {
    lines.push('model quota:');
    const sorted = [...models].sort((a, b) =>
      String(a.modelId || a.label || '').localeCompare(String(b.modelId || b.label || '')),
    );
    for (const m of sorted) {
      const id = m.modelId || m.label || 'unknown';
      const remaining = typeof m.remainingPercentage === 'number'
        ? `${m.remainingPercentage.toFixed(1)}%`
        : 'n/a';
      const flags = [
        m.isSelected ? '[active]' : '',
        m.isExhausted ? '[exhausted]' : '',
      ].filter(Boolean).join(' ');
      lines.push(`  ${id}: ${remaining}${flags ? ' ' + flags : ''}`);
    }
  }

  return lines.join('\n');
}

function createAccountCommandAdapter({
  controller,
  vscodeApi,
  outputChannel,
  log,
  executeManualLaunch,
  getLatestQuota,
  summarizeQuota,
  refreshQuota,
  equalsAccount = defaultEqualsAccount,
}) {
  return {
    async runSwitchAccountCommand() {
      const targetEmail = await getSelectedAccount({ controller, vscodeApi });
      if (!targetEmail) {
        return;
      }

      const confirmed = await confirmSwitch({ vscodeApi, targetEmail });
      if (!confirmed) {
        return;
      }

      outputChannel.show(true);
      outputChannel.appendLine(`=== Sidecar: Switch Account to ${targetEmail} ===`);

      try {
        const currentAccount = await controller.getCurrentAccount();
        const currentEmail = currentAccount?.email ?? null;
        outputChannel.appendLine(`Current account: ${currentEmail || '(not logged in)'}`);
        outputChannel.appendLine(`Target account: ${targetEmail}`);

        if (equalsAccount(currentEmail, targetEmail)) {
          outputChannel.appendLine('No-op: current account already matches target account.');
          vscodeApi.window.showInformationMessage(`Sidecar: Already using account ${targetEmail}`);
          log(`Switch skipped because current account already matches target: ${targetEmail}`);
          return;
        }
      } catch (error) {
        outputChannel.appendLine(`Current account check warning: ${error.message}`);
        log(`Current account check failed before switch: ${error.message}`);
      }

      try {
        const result = await controller.requestSwitchAccount({ targetEmail });
        outputChannel.appendLine(`Step 1: ${formatAcceptedMessage(result, targetEmail)}`);
        outputChannel.appendLine(`Step 2: ${formatPendingMessage(result, targetEmail)}`);
        outputChannel.appendLine('Step 3: Quitting Antigravity...');
        outputChannel.appendLine('');
        outputChannel.appendLine('Sidecar will restart Antigravity automatically with the new account.');
        closeAndQuit(vscodeApi);
      } catch (error) {
        outputChannel.appendLine(`ERROR: ${error.message}`);
        vscodeApi.window.showErrorMessage(`Sidecar: Switch failed: ${error.message}`);
      }
    },

    async runDeleteAccountCommand() {
      const accounts = await controller.listAccounts();
      if (!accounts || accounts.length === 0) {
        vscodeApi.window.showWarningMessage('Sidecar: No saved accounts found.');
        return;
      }

      const picked = await vscodeApi.window.showQuickPick(
        accounts.map(toQuickPickItem),
        { placeHolder: 'Select account to delete' },
      );
      if (!picked) return;

      const targetEmail = picked.label;

      const confirm = await vscodeApi.window.showWarningMessage(
        `Sidecar: Delete saved account "${targetEmail}"?\n\nThis only removes the local backup file. It does not log out.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      try {
        await controller.deleteAccount({ email: targetEmail });
        vscodeApi.window.showInformationMessage(`Sidecar: Deleted account ${targetEmail}`);
        log(`Deleted account: ${targetEmail}`);
      } catch (error) {
        vscodeApi.window.showErrorMessage(`Sidecar: Delete failed: ${error.message}`);
        log(`Delete account failed: ${error.message}`);
      }
    },

    async runAccountStatusCommand() {
      outputChannel.show(true);

      let currentAccount = null;
      try {
        currentAccount = await controller.getCurrentAccount();
      } catch (error) {
        outputChannel.appendLine(`Account lookup failed: ${error.message}`);
      }

      if (typeof refreshQuota === 'function') {
        try {
          await refreshQuota();
        } catch (error) {
          outputChannel.appendLine(`Quota refresh failed: ${error.message}`);
        }
      }

      const quota = typeof getLatestQuota === 'function' ? getLatestQuota() : null;
      const report = formatAccountStatusReport({ currentAccount, quota, summarizeQuota });
      for (const line of report.split('\n')) {
        outputChannel.appendLine(line);
      }

      const summary = summarizeQuota ? summarizeQuota(quota) : null;
      const accountLabel = currentAccount ? currentAccount.email : '(not logged in)';
      const quotaLabel = summary && summary.activeModelRemaining !== null
        ? `${summary.activeModelName || 'model'}: ${summary.activeModelRemaining.toFixed(0)}%`
        : summary && summary.promptRemaining !== null
          ? `credits: ${summary.promptRemaining.toFixed(0)}%`
          : 'quota: n/a';
      vscodeApi.window.showInformationMessage(`Sidecar: ${accountLabel} — ${quotaLabel}`);
    },

    async runAddAnotherAccountCommand() {
      const confirmed = await confirmAddAnotherAccount({ vscodeApi });
      if (!confirmed) {
        return;
      }

      outputChannel.show(true);
      outputChannel.appendLine('=== Sidecar: Add Another Account ===');

      try {
        const result = await controller.prepareAddAnotherAccount();
        outputChannel.appendLine(`Current account: ${result.email}`);
        outputChannel.appendLine(`Step 1: Saved current account for ${result.email}`);
        if (result.filePath) {
          outputChannel.appendLine(`Saved file: ${result.filePath}`);
        }
        outputChannel.appendLine(`Step 2: Cleared local auth (${result.cleared ? 'cleared' : 'no changes'})`);
        if (result.dbPath) {
          outputChannel.appendLine(`Auth DB: ${result.dbPath}`);
        }
        outputChannel.appendLine('Step 3: Restart worker started.');
        outputChannel.appendLine('Step 4: Closing Antigravity so restart can continue...');
        outputChannel.appendLine('');
        outputChannel.appendLine('After restart, sign in with the new account.');
        if (typeof executeManualLaunch !== 'function') {
          throw new Error('Restart is unavailable');
        }
        await executeManualLaunch('restart', {
          trigger: 'add-account',
          exitAfterWorkerStart: true,
        });
        closeAndQuit(vscodeApi);
      } catch (error) {
        outputChannel.appendLine(`ERROR: ${error.message}`);
        log(`Add another account failed: ${error.message}`);
        vscodeApi.window.showErrorMessage(`Sidecar: Add Another Account failed: ${error.message}`);
      }
    },
  };
}

module.exports = {
  createAccountCommandAdapter,
};
