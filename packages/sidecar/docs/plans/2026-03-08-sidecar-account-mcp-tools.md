# Sidecar Account MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add sidecar-owned account switching APIs and expose `antigravity-accounts-list`, `antigravity-account-switch`, and `antigravity-account-switch-status` through the bundled MCP server without duplicating the account-switch execution logic.

**Architecture:** Keep sidecar as the single execution authority for account switching. Introduce a sidecar account control layer that owns request validation, switch task bookkeeping, and worker orchestration; route both VS Code commands and bundled MCP tools through that layer. Extract restart behavior into a shared primitive usable from both extension runtime and detached worker so restart semantics stay aligned.

**Tech Stack:** Node.js, VS Code extension host APIs, local HTTP control API (or equivalent sidecar-local command channel), `sql.js`, detached Node worker, `@modelcontextprotocol/sdk`, existing structured logging.

---

### Task 1: Add failing tests for the new account control contract

**Files:**
- Create: `test/account-control.test.mjs`
- Test: `test/account-control.test.mjs`
- Reference: `test/bridge-auth.test.mjs`

**Step 1: Write the failing test**

Create `test/account-control.test.mjs` with focused tests for the controller contract only. Cover:
- list accounts returns saved accounts in expected shape
- switch request returns `accepted`, `requestId`, and initial `pending` status
- status lookup returns task metadata for known request
- duplicate/locked switch request is rejected cleanly

Use stub dependencies instead of real worker/DB access. Example skeleton:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountControlService } from '../src/services/account-control.js';

test('switch request returns accepted pending task', async () => {
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: createInMemoryStatusStore(),
    now: () => 1700000000000,
    randomId: () => 'req_123',
  });

  const result = await service.requestSwitchAccount({ targetEmail: 'user@example.com' });

  assert.equal(result.accepted, true);
  assert.equal(result.requestId, 'req_123');
  assert.equal(result.status, 'pending');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/account-control.test.mjs`
Expected: FAIL with module-not-found for `src/services/account-control.js`

**Step 3: Write minimal implementation**

Create placeholder exports in `src/services/account-control.js` just enough for imports to resolve, returning dummy values that still fail assertions.

```js
function createAccountControlService() {
  return {
    async listAccounts() { return []; },
    async requestSwitchAccount() { return { accepted: false }; },
    async getSwitchStatus() { return null; },
  };
}

module.exports = { createAccountControlService };
```

**Step 4: Run test to verify it still fails for behavior**

Run: `node --test test/account-control.test.mjs`
Expected: FAIL on assertion mismatch rather than missing module

**Step 5: Commit**

```bash
git add test/account-control.test.mjs src/services/account-control.js
git commit -m "test: add account control contract coverage"
```

---

### Task 2: Implement the sidecar account control service

**Files:**
- Modify: `src/services/account-control.js`
- Modify: `src/services/account-service.js`
- Create: `src/services/switch-status-store.js`
- Test: `test/account-control.test.mjs`

**Step 1: Write the failing test**

Extend `test/account-control.test.mjs` with behavior for:
- current account lookup
- last status loading when result file exists
- locked request rejection when a switch is already pending
- task status transitions persisted through the status store

Example:

```js
test('getSwitchStatus returns stored task state', async () => {
  const store = createInMemoryStatusStore({ req_123: { requestId: 'req_123', status: 'running' } });
  const service = createAccountControlService({
    accountService: fakeAccountService(),
    workerLauncher: fakeWorkerLauncher(),
    statusStore: store,
  });

  const status = await service.getSwitchStatus({ requestId: 'req_123' });
  assert.equal(status.status, 'running');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/account-control.test.mjs`
Expected: FAIL on missing status store behavior

**Step 3: Write minimal implementation**

Implement:
- `src/services/switch-status-store.js` for reading/writing a JSON task file under `~/.config/antigravity-mcp/`
- `createAccountControlService()` with methods:
  - `listAccounts()`
  - `getCurrentAccount()`
  - `requestSwitchAccount({ targetEmail })`
  - `getSwitchStatus({ requestId })`
  - `getLatestSwitchStatus()`
- a single pending-task guard using lock/result/task state
- shared status record shape, e.g.:

```js
{
  requestId: 'req_123',
  targetEmail: 'user@example.com',
  status: 'pending',
  phase: 'requested',
  createdAt: '2026-03-08T00:00:00.000Z',
  updatedAt: '2026-03-08T00:00:00.000Z'
}
```

Keep it minimal: no extra abstraction beyond what the new tools need.

**Step 4: Run test to verify it passes**

Run: `node --test test/account-control.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/account-control.js src/services/switch-status-store.js src/services/account-service.js test/account-control.test.mjs
git commit -m "feat: add sidecar account control service"
```

---

### Task 3: Extract a shared restart primitive from launch logic

**Files:**
- Modify: `src/services/launcher.js`
- Modify: `src/extension.js:574-689`
- Modify: `scripts/switch-worker.js`
- Test: `test/restart-primitive.test.mjs`

**Step 1: Write the failing test**

Create `test/restart-primitive.test.mjs` to verify the shared primitive builds the expected restart behavior without depending on VS Code UI state. Cover:
- restart uses provided executable and args
- restart path invokes process-kill flow before relaunch
- caller can opt into waiting/probing hooks without UI dependencies

Example:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestartPrimitive } from '../src/services/launcher.js';

test('restart primitive relaunches executable with supplied args', async () => {
  const calls = [];
  const restart = createRestartPrimitive({
    spawnImpl: (...args) => { calls.push(args); return { unref() {} }; },
    spawnSyncImpl: () => ({ stdout: '' }),
    platform: 'darwin',
  });

  await restart({ executable: '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity', args: ['/repo', '--new-window'], restart: true });

  assert.equal(calls.length > 0, true);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/restart-primitive.test.mjs`
Expected: FAIL because `createRestartPrimitive` does not exist

**Step 3: Write minimal implementation**

Refactor `src/services/launcher.js` so restart/launch shell behavior is owned by a reusable exported helper. Then:
- update `executeManualLaunch()` in `src/extension.js` to call that helper
- update `scripts/switch-worker.js` restart phase to call the same helper or a worker-safe wrapper around it

Do not move VS Code UI messaging into the primitive. Keep the primitive pure and dependency-injected where needed.

**Step 4: Run test to verify it passes**

Run: `node --test test/restart-primitive.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/launcher.js src/extension.js scripts/switch-worker.js test/restart-primitive.test.mjs
git commit -m "refactor: share antigravity restart primitive"
```

---

### Task 4: Move command-side switch orchestration into the controller

**Files:**
- Modify: `src/commands/register-commands.js:409-542`
- Modify: `src/extension.js:930-939`
- Modify: `src/services/account-control.js`
- Test: `test/account-command-adapter.test.mjs`

**Step 1: Write the failing test**

Create `test/account-command-adapter.test.mjs` for the command adapter behavior:
- command path asks controller for current account and account list
- command path delegates switch request instead of spawning worker directly
- no-op when current account already matches target

Example:

```js
test('command switch delegates to controller request', async () => {
  const calls = [];
  const controller = {
    async listAccounts() { return [{ email: 'user@example.com', modifiedTime: new Date() }]; },
    async getCurrentAccount() { return { email: 'other@example.com' }; },
    async requestSwitchAccount(input) { calls.push(input); return { accepted: true, requestId: 'req_1', status: 'pending' }; },
  };

  // invoke extracted command helper here
  assert.equal(calls[0].targetEmail, 'user@example.com');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/account-command-adapter.test.mjs`
Expected: FAIL because command flow is still embedded in `register-commands.js`

**Step 3: Write minimal implementation**

Extract the command-side orchestration into a small helper or inline adapter that depends on the new controller. Update dependency injection from `src/extension.js` so `registerCommands()` receives the controller instead of raw account switching internals.

The command behavior should remain the same for the user:
- list saved accounts
- confirm switch
- skip if already on target account
- show request accepted / pending messaging
- quit Antigravity after request is prepared

**Step 4: Run test to verify it passes**

Run: `node --test test/account-command-adapter.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/register-commands.js src/extension.js src/services/account-control.js test/account-command-adapter.test.mjs
git commit -m "refactor: route account command through controller"
```

---

### Task 5: Add a sidecar-local control API for account operations

**Files:**
- Create: `src/services/account-control-api.js`
- Modify: `src/extension.js`
- Modify: `test/account-control.test.mjs`
- Create: `test/account-control-api.test.mjs`

**Step 1: Write the failing test**

Create `test/account-control-api.test.mjs` covering the local control API surface:
- `POST /v1/accounts/list`
- `POST /v1/accounts/switch`
- `POST /v1/accounts/switch-status`
- bad request handling for missing email / missing requestId

If you reuse HTTP, keep it localhost-only and sidecar-local. Example:

```js
test('switch endpoint returns accepted request payload', async () => {
  const controller = fakeController({
    requestSwitchAccount: async () => ({ accepted: true, requestId: 'req_1', status: 'pending' }),
  });

  const server = createAccountControlApi({ controller });
  const res = await postJson(server, '/v1/accounts/switch', { targetEmail: 'user@example.com' });
  assert.equal(res.accepted, true);
  assert.equal(res.requestId, 'req_1');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/account-control-api.test.mjs`
Expected: FAIL because API module does not exist

**Step 3: Write minimal implementation**

Implement a small local API module that exposes only the three approved operations. Reuse existing auth/signing ideas only if needed; keep scope narrow. In `src/extension.js`, start this API only in the host sidecar context and dispose it with the extension.

Do not add extra endpoints. YAGNI.

**Step 4: Run test to verify it passes**

Run: `node --test test/account-control-api.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/account-control-api.js src/extension.js test/account-control-api.test.mjs test/account-control.test.mjs
git commit -m "feat: expose local account control api"
```

---

### Task 6: Add bundled MCP tools that proxy to the sidecar control API

**Files:**
- Modify: `server-runtime/dist/index.js`
- Modify: `server-runtime/dist/index.d.ts`
- Modify: `server-runtime/dist/launch-antigravity.js` (only if shared helper placement requires it)
- Test: `test/server-runtime-account-tools.test.mjs`

**Step 1: Write the failing test**

Create `test/server-runtime-account-tools.test.mjs` to verify:
- tools list includes exactly:
  - `antigravity-accounts-list`
  - `antigravity-account-switch`
  - `antigravity-account-switch-status`
- tool handlers proxy to the sidecar control API and format returned JSON as text output
- switch-status supports explicit `requestId` and last-status fallback if no `requestId` supplied

Example:

```js
test('ListTools includes account switch tools', async () => {
  const { tools } = await listToolsFromServer();
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(
    names.filter((name) => name.startsWith('antigravity-account')),
    ['antigravity-accounts-list', 'antigravity-account-switch', 'antigravity-account-switch-status']
  );
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/server-runtime-account-tools.test.mjs`
Expected: FAIL because tools are not registered yet

**Step 3: Write minimal implementation**

In `server-runtime/dist/index.js`:
- add the three tool definitions
- add a tiny proxy helper that calls the sidecar local account control API
- implement handlers for list / switch / status only
- return compact JSON text or human-readable structured text, but keep it deterministic for clients

Update `.d.ts` exports only if the edited runtime shape requires it.

**Step 4: Run test to verify it passes**

Run: `node --test test/server-runtime-account-tools.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add server-runtime/dist/index.js server-runtime/dist/index.d.ts test/server-runtime-account-tools.test.mjs
git commit -m "feat: add account mcp tools"
```

---

### Task 7: Connect worker status updates to switch-status queries

**Files:**
- Modify: `scripts/switch-worker.js`
- Modify: `src/services/switch-status-store.js`
- Modify: `src/extension.js:1444-1490`
- Test: `test/switch-worker-status.test.mjs`

**Step 1: Write the failing test**

Create `test/switch-worker-status.test.mjs` covering:
- worker writes phase/status updates during execution
- final success/failure maps to the status store used by controller/API
- extension activation can still consume `switch-result.json` without breaking MCP status lookup

Example:

```js
test('worker writes success status with target and phase', async () => {
  const store = createFileBackedStore(tmpDir);
  await writeWorkerStatus(store, {
    requestId: 'req_1',
    status: 'success',
    phase: 'complete',
    targetEmail: 'user@example.com',
  });

  const saved = store.get('req_1');
  assert.equal(saved.status, 'success');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/switch-worker-status.test.mjs`
Expected: FAIL because worker does not update the shared status store yet

**Step 3: Write minimal implementation**

Update worker argument set and write path so each switch request carries `requestId`. During phase transitions, write task state updates to the shared status store in addition to the existing worker log/result file. Keep `switch-result.json` for activation UX, but make `switch-status` independent from whether activation has already consumed the result file.

**Step 4: Run test to verify it passes**

Run: `node --test test/switch-worker-status.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/switch-worker.js src/services/switch-status-store.js src/extension.js test/switch-worker-status.test.mjs
git commit -m "feat: persist switch task status updates"
```

---

### Task 8: Verify the end-to-end behavior and package the extension

**Files:**
- Modify if needed: `package.json`
- Verify: `src/extension.js`, `src/commands/register-commands.js`, `server-runtime/dist/index.js`, `scripts/switch-worker.js`
- Test: all touched tests

**Step 1: Run targeted tests**

Run:

```bash
node --test test/account-control.test.mjs test/restart-primitive.test.mjs test/account-command-adapter.test.mjs test/account-control-api.test.mjs test/server-runtime-account-tools.test.mjs test/switch-worker-status.test.mjs
```

Expected: PASS

**Step 2: Run existing repository checks**

Run:

```bash
npm test
```

Expected: PASS with syntax checks and existing tests still green

**Step 3: Package the extension**

Run:

```bash
npm run package
```

Expected: new `.vsix` generated successfully

**Step 4: Manual smoke test**

Verify manually in Antigravity:
1. Install the generated `.vsix`
2. Confirm command palette account switch still works
3. Call bundled MCP tools:
   - `antigravity-accounts-list`
   - `antigravity-account-switch`
   - `antigravity-account-switch-status`
4. Confirm switch request returns pending request ID
5. Confirm status progresses and final result matches worker logs
6. Confirm restart still comes back with expected workspace/CDP context

**Step 5: Commit**

```bash
git add package.json package-lock.json *.vsix
git commit -m "feat: expose account switching via bundled mcp tools"
```

---

## Notes for the implementing agent

- Prefer tiny helpers over broad abstractions.
- Do not add more MCP tools than the three approved ones.
- Do not let server-runtime touch the DB directly.
- Keep `switch-result.json` for user-facing activation feedback, but do not rely on it as the only status source.
- Reuse the same restart primitive for manual restart and worker restart so launch semantics stop drifting.
- If you need to choose between a fancier API and a simpler localhost-only API, choose the simpler one unless a real blocker appears.
