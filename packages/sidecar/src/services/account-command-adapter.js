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

function createAccountCommandAdapter({
  controller,
  vscodeApi,
  outputChannel,
  log,
  executeManualLaunch,
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
