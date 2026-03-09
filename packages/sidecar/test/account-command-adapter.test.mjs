import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAccountCommandAdapter } from '../src/services/account-command-adapter.js';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const vscodeMock = {
  window: {
    showWarningMessage: () => undefined,
    showErrorMessage: () => undefined,
    showInformationMessage: () => undefined,
    showQuickPick: async () => undefined,
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async () => {},
  },
  workspace: {
    getConfiguration: () => ({ update: async () => {}, get: (_k, d) => d }),
  },
  env: {
    clipboard: {
      writeText: async () => {},
    },
  },
  ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function (id, ...rest) {
  if (id === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, id, ...rest);
};

const { registerCommands } = require('../src/commands/register-commands.js');

function createOutputChannel() {
  const lines = [];
  return {
    lines,
    showCalls: [],
    show(preserveFocus) {
      this.showCalls.push(preserveFocus);
    },
    appendLine(line) {
      lines.push(line);
    },
  };
}

function createVscodeDouble({ picked = 'target@example.com', confirm = 'Switch Account' } = {}) {
  const executedCommands = [];
  const infos = [];
  const warnings = [];
  const errors = [];
  const quickPickCalls = [];

  return {
    executedCommands,
    infos,
    warnings,
    errors,
    quickPickCalls,
    window: {
      async showQuickPick(items, options) {
        quickPickCalls.push({ items, options });
        return picked ? { label: picked } : undefined;
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return confirm;
      },
      showInformationMessage(message) {
        infos.push(message);
      },
      showErrorMessage(message) {
        errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        executedCommands.push(command);
      },
    },
  };
}

function createControllerDouble(overrides = {}) {
  const calls = [];
  const controller = {
    async listAccounts() {
      calls.push(['listAccounts']);
      return [
        {
          email: 'target@example.com',
          modifiedTime: new Date('2026-03-08T00:00:00.000Z'),
        },
      ];
    },
    async getCurrentAccount() {
      calls.push(['getCurrentAccount']);
      return { email: 'current@example.com' };
    },
    async requestSwitchAccount({ targetEmail }) {
      calls.push(['requestSwitchAccount', targetEmail]);
      return { accepted: true, requestId: 'req_123', status: 'running' };
    },
    async prepareAddAnotherAccount() {
      calls.push(['prepareAddAnotherAccount']);
      return {
        email: 'current@example.com',
        filePath: '/tmp/account.json',
        cleared: true,
        dbPath: '/tmp/auth.db',
      };
    },
    ...overrides,
  };
  return { controller, calls };
}

const originalSetTimeout = globalThis.setTimeout;
const originalRegisterCommand = vscodeMock.commands.registerCommand;

test.afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  vscodeMock.commands.registerCommand = originalRegisterCommand;
});

test('command path asks controller for current account and account list', async () => {
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble();
  const { controller, calls } = createControllerDouble();
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.deepEqual(calls.slice(0, 3), [
    ['listAccounts'],
    ['getCurrentAccount'],
    ['requestSwitchAccount', 'target@example.com'],
  ]);
  assert.equal(vscodeApi.quickPickCalls.length, 1);
  assert.equal(vscodeApi.quickPickCalls[0].items[0].label, 'target@example.com');
});

test('command path delegates switch request instead of spawning worker directly', async () => {
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble();
  let delegatedTarget = null;
  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [{ email: 'target@example.com', modifiedTime: new Date('2026-03-08T00:00:00.000Z') }];
      },
      async getCurrentAccount() {
        return { email: 'current@example.com' };
      },
      async requestSwitchAccount({ targetEmail }) {
        delegatedTarget = targetEmail;
        return { accepted: true, requestId: 'req_delegate', status: 'running' };
      },
    },
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.equal(delegatedTarget, 'target@example.com');
  assert.equal(vscodeApi.errors.length, 0);
  assert.deepEqual(vscodeApi.executedCommands, [
    'workbench.action.closeAllEditors',
    'workbench.action.quit',
  ]);
  assert.ok(outputChannel.lines.some((line) => line.includes('req_delegate')));
  assert.ok(outputChannel.lines.some((line) => line.includes('Switch status: running')));
});

test('no-op when current account already matches target', async () => {
  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble();
  let requested = false;
  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [{ email: 'target@example.com', modifiedTime: new Date('2026-03-08T00:00:00.000Z') }];
      },
      async getCurrentAccount() {
        return { email: 'target@example.com' };
      },
      async requestSwitchAccount() {
        requested = true;
        return { accepted: true };
      },
    },
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.equal(requested, false);
  assert.deepEqual(vscodeApi.infos, ['Sidecar: Already using account target@example.com']);
  assert.ok(outputChannel.lines.includes('No-op: current account already matches target account.'));
});

test('listAccounts empty returns early without quick pick or request', async () => {
  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble();
  let requested = false;
  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [];
      },
      async getCurrentAccount() {
        throw new Error('should not reach current account');
      },
      async requestSwitchAccount() {
        requested = true;
      },
    },
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.equal(requested, false);
  assert.equal(vscodeApi.quickPickCalls.length, 0);
  assert.equal(vscodeApi.warnings.length, 1);
  assert.equal(vscodeApi.warnings[0].message, 'Sidecar: No saved accounts found. Save an account first.');
});

test('cancelled quick pick does not trigger requestSwitchAccount', async () => {
  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble({ picked: null });
  let requested = false;
  const { controller } = createControllerDouble({
    async requestSwitchAccount() {
      requested = true;
    },
  });
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.equal(requested, false);
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('cancelled confirmation does not trigger requestSwitchAccount', async () => {
  const outputChannel = createOutputChannel();
  const warnings = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick(items, options) {
        vscodeApi.quickPickCalls.push({ items, options });
        return { label: 'target@example.com' };
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        if (actions.includes('Switch Account')) {
          return undefined;
        }
        return undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  let requested = false;
  const { controller } = createControllerDouble({
    async requestSwitchAccount() {
      requested = true;
    },
  });
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.equal(requested, false);
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('requestSwitchAccount failure does not trigger quit', async () => {
  globalThis.setTimeout = () => {
    throw new Error('quit should not be scheduled');
  };

  const outputChannel = createOutputChannel();
  const vscodeApi = createVscodeDouble();
  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [{ email: 'target@example.com', modifiedTime: new Date('2026-03-08T00:00:00.000Z') }];
      },
      async getCurrentAccount() {
        return { email: 'current@example.com' };
      },
      async requestSwitchAccount() {
        throw new Error('switch rejected');
      },
    },
    vscodeApi,
    outputChannel,
    log() {},
  });

  await adapter.runSwitchAccountCommand();

  assert.deepEqual(vscodeApi.executedCommands, []);
  assert.deepEqual(vscodeApi.errors, ['Sidecar: Switch failed: switch rejected']);
  assert.ok(outputChannel.lines.includes('ERROR: switch rejected'));
});

test('add another account delegates to launchRestartWorker wait-exit flow', async () => {
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  const outputChannel = createOutputChannel();
  const warnings = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() {
        throw new Error('should not show quick pick');
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return actions.includes('Save and Restart') ? 'Save and Restart' : undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  const { controller, calls } = createControllerDouble();
  const restartCalls = [];
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log() {},
    launchRestartWorker: (params) => { restartCalls.push(params); },
  });

  await adapter.runAddAnotherAccountCommand();

  assert.deepEqual(calls, [['prepareAddAnotherAccount']]);
  assert.equal(restartCalls.length, 1);
  assert.ok(restartCalls[0].requestId.startsWith('add-account-'));
  assert.deepEqual(vscodeApi.executedCommands, [
    'workbench.action.closeAllEditors',
    'workbench.action.quit',
  ]);
  assert.ok(outputChannel.lines.includes('Step 3: Restarting Antigravity with cleared auth...'));
});

test('cancelled add another account confirmation does not prepare or restart', async () => {
  const outputChannel = createOutputChannel();
  const warnings = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() {
        throw new Error('should not show quick pick');
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  let prepared = false;
  let restarted = false;
  const adapter = createAccountCommandAdapter({
    controller: {
      async prepareAddAnotherAccount() {
        prepared = true;
      },
    },
    vscodeApi,
    outputChannel,
    log() {},
    launchRestartWorker: () => {
      restarted = true;
    },
  });

  await adapter.runAddAnotherAccountCommand();

  assert.equal(prepared, false);
  assert.equal(restarted, false);
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('prepareAddAnotherAccount failure does not restart', async () => {
  const outputChannel = createOutputChannel();
  const warnings = [];
  const logs = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() {
        throw new Error('should not show quick pick');
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return actions.includes('Save and Restart') ? 'Save and Restart' : undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  let restarted = false;
  const adapter = createAccountCommandAdapter({
    controller: {
      async prepareAddAnotherAccount() {
        throw new Error('No account is currently logged in');
      },
    },
    vscodeApi,
    outputChannel,
    log(message) {
      logs.push(message);
    },
    launchRestartWorker: () => {
      restarted = true;
    },
  });

  await adapter.runAddAnotherAccountCommand();

  assert.equal(restarted, false);
  assert.deepEqual(vscodeApi.errors, ['Sidecar: Add Another Account failed: No account is currently logged in']);
  assert.ok(outputChannel.lines.includes('ERROR: No account is currently logged in'));
  assert.ok(logs.includes('Add another account failed: No account is currently logged in'));
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('missing launchRestartWorker reports restart unavailable for add another account', async () => {
  const outputChannel = createOutputChannel();
  const warnings = [];
  const logs = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() {
        throw new Error('should not show quick pick');
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return actions.includes('Save and Restart') ? 'Save and Restart' : undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  const { controller } = createControllerDouble();
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log(message) {
      logs.push(message);
    },
  });

  await adapter.runAddAnotherAccountCommand();

  assert.deepEqual(vscodeApi.errors, ['Sidecar: Add Another Account failed: Restart is unavailable']);
  assert.ok(outputChannel.lines.includes('ERROR: Restart is unavailable'));
  assert.ok(logs.includes('Add another account failed: Restart is unavailable'));
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('restart failure during add another account shows error and logs failure', async () => {
  const outputChannel = createOutputChannel();
  const warnings = [];
  const logs = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() {
        throw new Error('should not show quick pick');
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return actions.includes('Save and Restart') ? 'Save and Restart' : undefined;
      },
      showInformationMessage(message) {
        vscodeApi.infos.push(message);
      },
      showErrorMessage(message) {
        vscodeApi.errors.push(message);
      },
    },
    commands: {
      async executeCommand(command) {
        vscodeApi.executedCommands.push(command);
      },
    },
  };
  const { controller } = createControllerDouble();
  const adapter = createAccountCommandAdapter({
    controller,
    vscodeApi,
    outputChannel,
    log(message) {
      logs.push(message);
    },
    launchRestartWorker: () => {
      throw new Error('restart failed');
    },
  });

  await adapter.runAddAnotherAccountCommand();

  assert.deepEqual(vscodeApi.errors, ['Sidecar: Add Another Account failed: restart failed']);
  assert.ok(outputChannel.lines.includes('ERROR: restart failed'));
  assert.ok(logs.includes('Add another account failed: restart failed'));
  assert.deepEqual(vscodeApi.executedCommands, []);
});

test('registerCommands switchAccount delegates to adapter', async () => {
  const registered = new Map();
  vscodeMock.commands.registerCommand = (id, handler) => {
    registered.set(id, handler);
    return { dispose() {} };
  };

  let delegated = 0;
  registerCommands(
    { subscriptions: [] },
    {
      runtimeRole: 'host',
      outputChannel: createOutputChannel(),
      ensureMcpLauncher() { return { ok: true }; },
      buildAiConfigPrompt() { return ''; },
      getLauncherPaths() { return { unixLauncher: '', windowsLauncher: '' }; },
      getBundledServerEntryPath() { return ''; },
      executeManualLaunch: async () => {},
      requestHostRestart: async () => {},
      refreshQuota: async () => {},
      summarizeQuota() { return null; },
      formatQuotaReport() { return ''; },
      getLatestQuota() { return null; },
      getLatestQuotaError() { return null; },
      getWorkspacePath() { return ''; },
      getCdpTarget() { return null; },
      getIsEnabled() { return false; },
      setIsEnabled() {},
      syncState() {},
      accountCommandAdapter: {
        async runSwitchAccountCommand() {
          delegated += 1;
        },
      },
      log() {},
    },
  );

  assert.ok(registered.has('antigravityMcpSidecar.switchAccount'));
  await registered.get('antigravityMcpSidecar.switchAccount')();
  assert.equal(delegated, 1);
});

test('accountStatus shows account email and quota summary in info message', async () => {
  const outputChannel = createOutputChannel();
  const infos = [];
  const vscodeApi = {
    executedCommands: [],
    infos,
    warnings: [],
    errors: [],
    quickPickCalls: [],
    window: {
      showInformationMessage(message) { infos.push(message); },
      showWarningMessage() {},
      showErrorMessage(message) { vscodeApi.errors.push(message); },
      async showQuickPick() { return undefined; },
    },
    commands: { async executeCommand() {} },
  };

  const quota = {
    timestamp: Date.now(),
    models: [
      { modelId: 'claude-3-5-sonnet', label: 'Sonnet', remainingPercentage: 72.5, isExhausted: false, isSelected: true },
    ],
    promptCredits: { remainingPercentage: 88.0 },
  };

  let refreshed = false;
  const adapter = createAccountCommandAdapter({
    controller: {
      async getCurrentAccount() { return { email: 'user@example.com' }; },
    },
    vscodeApi,
    outputChannel,
    log() {},
    getLatestQuota: () => quota,
    summarizeQuota(q) {
      const m = q.models[0];
      return {
        activeModelName: m.label,
        activeModelRemaining: m.remainingPercentage,
        promptRemaining: q.promptCredits.remainingPercentage,
        modelCount: 1,
        exhaustedCount: 0,
        primaryPercent: m.remainingPercentage,
        primaryLabel: `model ${m.label}`,
        minModelRemaining: m.remainingPercentage,
      };
    },
    refreshQuota: async () => { refreshed = true; },
  });

  await adapter.runAccountStatusCommand();

  assert.equal(refreshed, true);
  assert.ok(outputChannel.lines.some(l => l.includes('user@example.com')));
  assert.ok(outputChannel.lines.some(l => l.includes('72.5%')));
  assert.ok(infos.some(m => m.includes('user@example.com') && m.includes('Sonnet')));
});

test('accountStatus handles not logged in and no quota gracefully', async () => {
  const outputChannel = createOutputChannel();
  const infos = [];
  const vscodeApi = {
    executedCommands: [],
    infos,
    warnings: [],
    errors: [],
    quickPickCalls: [],
    window: {
      showInformationMessage(message) { infos.push(message); },
      showWarningMessage() {},
      showErrorMessage(message) { vscodeApi.errors.push(message); },
      async showQuickPick() { return undefined; },
    },
    commands: { async executeCommand() {} },
  };

  const adapter = createAccountCommandAdapter({
    controller: {
      async getCurrentAccount() { return null; },
    },
    vscodeApi,
    outputChannel,
    log() {},
    getLatestQuota: () => null,
    summarizeQuota: () => null,
  });

  await adapter.runAccountStatusCommand();

  assert.ok(outputChannel.lines.some(l => l.includes('not logged in')));
  assert.ok(outputChannel.lines.some(l => l.includes('no snapshot available')));
  assert.ok(infos.some(m => m.includes('not logged in')));
});

test('deleteAccount deletes selected account and shows confirmation', async () => {
  const infos = [];
  const logs = [];
  const vscodeApi = {
    executedCommands: [],
    infos,
    warnings: [],
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick(items, options) {
        vscodeApi.quickPickCalls.push({ items, options });
        return { label: 'user@example.com' };
      },
      async showWarningMessage(message, options, ...actions) {
        vscodeApi.warnings.push({ message, options, actions });
        return 'Delete';
      },
      showInformationMessage(message) { infos.push(message); },
      showErrorMessage(message) { vscodeApi.errors.push(message); },
    },
    commands: { async executeCommand() {} },
  };

  let deletedEmail = null;
  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [{ email: 'user@example.com', modifiedTime: new Date('2026-03-08T00:00:00.000Z') }];
      },
      async deleteAccount({ email }) { deletedEmail = email; return { email }; },
    },
    vscodeApi,
    outputChannel: { lines: [], show() {}, appendLine() {} },
    log(m) { logs.push(m); },
    getLatestQuota: () => null,
    summarizeQuota: () => null,
  });

  await adapter.runDeleteAccountCommand();

  assert.equal(deletedEmail, 'user@example.com');
  assert.ok(infos.some(m => m.includes('user@example.com')));
  assert.ok(logs.some(m => m.includes('user@example.com')));
});

test('deleteAccount cancelled confirmation does not delete', async () => {
  let deleted = false;
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings: [],
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() { return { label: 'user@example.com' }; },
      async showWarningMessage() { return undefined; },
      showInformationMessage() {},
      showErrorMessage() {},
    },
    commands: { async executeCommand() {} },
  };

  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() {
        return [{ email: 'user@example.com', modifiedTime: new Date('2026-03-08T00:00:00.000Z') }];
      },
      async deleteAccount() { deleted = true; },
    },
    vscodeApi,
    outputChannel: { lines: [], show() {}, appendLine() {} },
    log() {},
    getLatestQuota: () => null,
    summarizeQuota: () => null,
  });

  await adapter.runDeleteAccountCommand();

  assert.equal(deleted, false);
});

test('deleteAccount no accounts shows warning', async () => {
  const warnings = [];
  const vscodeApi = {
    executedCommands: [],
    infos: [],
    warnings,
    errors: [],
    quickPickCalls: [],
    window: {
      async showQuickPick() { throw new Error('should not show quick pick'); },
      async showWarningMessage(message) { warnings.push(message); },
      showInformationMessage() {},
      showErrorMessage() {},
    },
    commands: { async executeCommand() {} },
  };

  const adapter = createAccountCommandAdapter({
    controller: {
      async listAccounts() { return []; },
    },
    vscodeApi,
    outputChannel: { lines: [], show() {}, appendLine() {} },
    log() {},
    getLatestQuota: () => null,
    summarizeQuota: () => null,
  });

  await adapter.runDeleteAccountCommand();

  assert.ok(warnings.some(m => m.includes('No saved accounts')));
});
