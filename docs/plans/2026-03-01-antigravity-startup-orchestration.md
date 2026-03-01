# Antigravity Startup Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `ask-antigravity` can cold-start Antigravity with a usable CDP port, then hand off runtime control to sidecar without unintended restart loops.

**Architecture:** Server performs cold-start launch only when no fresh sidecar-managed CDP endpoint exists. Sidecar owns runtime endpoint negotiation, manual launch/restart commands, and registry heartbeat. Both coordinate through explicit `registry.cdp` and `registry.launch` state.

**Tech Stack:** Node.js (ESM), TypeScript (`antigravity-mcp-server`), JavaScript VS Code extension (`antigravity-mcp-sidecar`), Node test runner (`node:test`), registry contract in JSON.

---

### Task 1: Add Registry Launch/CDP Contract Types in Server

**Files:**
- Modify: `antigravity-mcp-server/src/cdp.ts`
- Test: `antigravity-mcp-server/test/cdp-wsl.test.mjs`

**Step 1: Write the failing test**

```js
test('discoverCDP prefers fresh cdp.active endpoint when state is ready', async () => {
  const now = Date.now();
  const entry = {
    port: 9000,
    ip: '127.0.0.1',
    cdp: {
      state: 'ready',
      verifiedAt: now,
      active: { host: '127.0.0.1', port: 9010, verifiedAt: now, source: 'probe' },
    },
  };
  // Assert discover logic selects 9010 instead of legacy 9000.
});
```

**Step 2: Run test to verify it fails**

Run: `cd antigravity-mcp-server && node --test test/cdp-wsl.test.mjs`  
Expected: FAIL on missing/incorrect ready-endpoint preference.

**Step 3: Write minimal implementation**

```ts
export interface RegistryLaunchState {
  requestId?: string;
  action?: "launch" | "restart";
  status?: "pending" | "running" | "succeeded" | "failed" | "expired";
  requestedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

const REGISTRY_CDP_READY_MAX_AGE_MS = 3 * 60 * 1000;

function useReadyEndpoint(entry?: RegistryEntry): { host?: string; port?: number } | null {
  const cdp = entry?.cdp;
  const active = cdp?.active;
  if (cdp?.state !== "ready") return null;
  if (!active?.port) return null;
  const verifiedAt = active.verifiedAt ?? cdp.verifiedAt;
  if (typeof verifiedAt !== "number" || Date.now() - verifiedAt > REGISTRY_CDP_READY_MAX_AGE_MS) return null;
  return { host: active.host, port: active.port };
}
```

**Step 4: Run test to verify it passes**

Run: `cd antigravity-mcp-server && node --test test/cdp-wsl.test.mjs`  
Expected: PASS for ready-endpoint selection case.

**Step 5: Commit**

```bash
git add antigravity-mcp-server/src/cdp.ts antigravity-mcp-server/test/cdp-wsl.test.mjs
git commit -m "feat(server): support negotiated cdp ready endpoint contract"
```

### Task 2: Implement Server Cold-Start Launcher

**Files:**
- Create: `antigravity-mcp-server/src/launch-antigravity.ts`
- Modify: `antigravity-mcp-server/src/index.ts`
- Test: `antigravity-mcp-server/test/startup-orchestration.test.mjs`

**Step 1: Write the failing test**

```js
test('ensureAntigravityReady launches app when cdp is unavailable and sidecar is offline', async () => {
  // Arrange discoverCDP => null, launch function mocked.
  // Assert launch called with --new-window and target dir.
});
```

**Step 2: Run test to verify it fails**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: FAIL because launcher module and orchestration path do not exist yet.

**Step 3: Write minimal implementation**

```ts
// launch-antigravity.ts
export async function launchAntigravityColdStart(params: {
  executable: string;
  targetDir: string;
  port: number;
}): Promise<void> {
  const args = [
    params.targetDir,
    "--new-window",
    `--remote-debugging-port=${params.port}`,
    "--remote-debugging-address=0.0.0.0",
  ];
  spawn(params.executable, args, { detached: true, stdio: "ignore" }).unref();
}
```

```ts
// index.ts (excerpt)
if (!discovered) {
  await launchAntigravityColdStart({ executable, targetDir: targetDir || process.cwd(), port });
  discovered = await waitForDiscoverableCdp(targetDir, 45_000);
}
```

**Step 4: Run test to verify it passes**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: PASS for cold-start path and launch arguments.

**Step 5: Commit**

```bash
git add antigravity-mcp-server/src/launch-antigravity.ts antigravity-mcp-server/src/index.ts antigravity-mcp-server/test/startup-orchestration.test.mjs
git commit -m "feat(server): add cold-start antigravity launcher orchestration"
```

### Task 3: Add Sidecar Launch State Machine (`pending/running/succeeded/failed`)

**Files:**
- Modify: `antigravity-mcp-sidecar/src/extension.js`
- Test: `antigravity-mcp-server/test/startup-orchestration.test.mjs` (contract-level assertion helper)

**Step 1: Write the failing test**

```js
test('registry launch request transitions pending -> running -> succeeded with cdp.ready', () => {
  // Simulate request envelope and sidecar executor ticks.
  // Assert state transition ordering and timestamps.
});
```

**Step 2: Run test to verify it fails**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: FAIL because launch transition logic is not yet modeled.

**Step 3: Write minimal implementation**

```js
function updateLaunchState(entry, patch) {
  const previous = entry.launch && typeof entry.launch === 'object' ? entry.launch : {};
  entry.launch = { ...previous, ...patch };
}

// Transition examples:
updateLaunchState(entry, { requestId, status: 'running', startedAt: Date.now() });
updateLaunchState(entry, { requestId, status: 'succeeded', finishedAt: Date.now(), error: undefined });
```

**Step 4: Run test to verify it passes**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: PASS for transition ordering and required fields.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/src/extension.js antigravity-mcp-server/test/startup-orchestration.test.mjs
git commit -m "feat(sidecar): implement launch request state transitions"
```

### Task 4: Add Sidecar Commands for Manual Launch and Confirmed Restart

**Files:**
- Modify: `antigravity-mcp-sidecar/src/extension.js`
- Modify: `antigravity-mcp-sidecar/package.json`

**Step 1: Write the failing test**

```js
test('restart command requires explicit confirmation before process kill/relaunch', async () => {
  // Stub showWarningMessage => cancel.
  // Assert no process termination executed.
});
```

**Step 2: Run test to verify it fails**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: FAIL because restart confirmation behavior is missing.

**Step 3: Write minimal implementation**

```js
context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.launchAntigravity', async () => {
  await ensureLaunched({ action: 'launch', requireConfirm: false });
}));

context.subscriptions.push(vscode.commands.registerCommand('antigravityMcpSidecar.restartAntigravity', async () => {
  const action = await vscode.window.showWarningMessage('Restart Antigravity now?', { modal: true }, 'Restart');
  if (action !== 'Restart') return;
  await ensureLaunched({ action: 'restart', requireConfirm: true });
}));
```

**Step 4: Run test to verify it passes**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: PASS for confirmation-required restart behavior.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/src/extension.js antigravity-mcp-sidecar/package.json antigravity-mcp-server/test/startup-orchestration.test.mjs
git commit -m "feat(sidecar): add launch and confirmed restart commands"
```

### Task 5: Enforce New-Window Target Directory Launch Behavior

**Files:**
- Modify: `antigravity-mcp-server/src/launch-antigravity.ts`
- Modify: `antigravity-mcp-sidecar/src/extension.js`
- Test: `antigravity-mcp-server/test/startup-orchestration.test.mjs`

**Step 1: Write the failing test**

```js
test('launch args always include target directory and --new-window', () => {
  const args = buildLaunchArgs('C:\\repo\\antigravity-sync', 9000);
  assert.deepEqual(args.slice(0, 2), ['C:\\repo\\antigravity-sync', '--new-window']);
});
```

**Step 2: Run test to verify it fails**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: FAIL when args builder does not enforce first-arg path + `--new-window`.

**Step 3: Write minimal implementation**

```ts
export function buildLaunchArgs(targetDir: string, port: number): string[] {
  return [
    targetDir,
    "--new-window",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=0.0.0.0",
  ];
}
```

**Step 4: Run test to verify it passes**

Run: `cd antigravity-mcp-server && node --test test/startup-orchestration.test.mjs`  
Expected: PASS for new-window target-dir invariant.

**Step 5: Commit**

```bash
git add antigravity-mcp-server/src/launch-antigravity.ts antigravity-mcp-sidecar/src/extension.js antigravity-mcp-server/test/startup-orchestration.test.mjs
git commit -m "feat: enforce new-window launch into target directory"
```

### Task 6: Documentation and End-to-End Validation

**Files:**
- Modify: `antigravity-mcp-sidecar/README.md`
- Modify: `antigravity-mcp-server/README.md`

**Step 1: Write the failing test/check**

```bash
rg -n "cdpFixedPort|launchAntigravity|restartAntigravity|new-window" antigravity-mcp-sidecar/README.md antigravity-mcp-server/README.md
```

Expected: Missing entries before doc update.

**Step 2: Run check to verify it fails**

Run: the `rg` command above  
Expected: incomplete/no matches for new behavior.

**Step 3: Write minimal documentation updates**

```md
- Startup modes: cold-start (server) and warm-control (sidecar)
- New commands: Launch Antigravity / Restart Antigravity
- Fixed-port settings and candidate-port settings
- Troubleshooting for occupied default port (e.g. 9222)
```

**Step 4: Run full verification**

Run:

```bash
cd antigravity-mcp-server && npm run build
cd antigravity-mcp-server && node --test test/*.mjs
cd antigravity-mcp-sidecar && node -c src/extension.js
```

Expected: all pass.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/README.md antigravity-mcp-server/README.md
git commit -m "docs: document startup orchestration and launch controls"
```

