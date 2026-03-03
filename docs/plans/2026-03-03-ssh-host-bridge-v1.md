# SSH Host Bridge v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a modular Host↔Remote bridge (fixed port 18900) so SSH-remote MCP server can consume mirrored Host CDP state, with clear first-time guidance when Host Antigravity is not open.

**Architecture:** Implement a host-side HTTP snapshot service in sidecar, a remote-side polling mirror client in sidecar, and keep MCP server read-only against local registry. Add SSH-aware hint mapping in server discovery errors so AI can instruct users to open Host Antigravity and keep SSH session active.

**Tech Stack:** Node.js (`http`, `crypto`), VS Code extension runtime (JS), MCP server (TypeScript), JSON registry contract, `node --test`.

---

### Task 1: Bridge Protocol Foundation (sidecar shared module)

**Files:**
- Create: `antigravity-mcp-sidecar/src/bridge-protocol.js`
- Create: `antigravity-mcp-sidecar/test/bridge-protocol.test.mjs`
- Modify: `antigravity-mcp-sidecar/src/extension.js`

**Step 1: Write the failing test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { signBridgeRequest, verifyBridgeRequest, PROTOCOL_VERSION } from '../src/bridge-protocol.js';

test('bridge signature validates method+path+body hash', () => {
  const token = 't';
  const req = signBridgeRequest({ method: 'POST', path: '/v1/snapshot', body: { a: 1 }, nodeId: 'n1', token, ts: 1, nonce: 'abc' });
  const ok = verifyBridgeRequest({ ...req, token, now: 1 });
  assert.equal(ok.ok, true);
  assert.equal(PROTOCOL_VERSION, 1);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test antigravity-mcp-sidecar/test/bridge-protocol.test.mjs`
Expected: FAIL with module/function missing.

**Step 3: Write minimal implementation**

```javascript
export const PROTOCOL_VERSION = 1;
// export signBridgeRequest()/verifyBridgeRequest() with HMAC-SHA256 over
// METHOD\nPATH\nBODY_SHA256\nTS\nNONCE\nNODE_ID
```

**Step 4: Run test to verify it passes**

Run: `node --test antigravity-mcp-sidecar/test/bridge-protocol.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/src/bridge-protocol.js antigravity-mcp-sidecar/test/bridge-protocol.test.mjs antigravity-mcp-sidecar/src/extension.js
git commit -m "feat(sidecar): add bridge protocol signing and verification helpers"
```

### Task 2: HostBridgeService (host sidecar, fixed 18900)

**Files:**
- Create: `antigravity-mcp-sidecar/src/host-bridge-service.js`
- Create: `antigravity-mcp-sidecar/test/host-bridge-service.test.mjs`
- Modify: `antigravity-mcp-sidecar/src/extension.js`

**Step 1: Write the failing test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBridgeService } from '../src/host-bridge-service.js';

test('GET /v1/health returns ok', async () => {
  const svc = await createHostBridgeService({ port: 18900, getRegistryEntry: () => null, token: 't' });
  const r = await fetch('http://127.0.0.1:18900/v1/health');
  assert.equal(r.status, 200);
  await svc.close();
});
```

**Step 2: Run test to verify it fails**

Run: `node --test antigravity-mcp-sidecar/test/host-bridge-service.test.mjs`
Expected: FAIL with module missing.

**Step 3: Write minimal implementation**

```javascript
// start http server on 127.0.0.1:18900
// GET /v1/health => {status:'ok', bridge_version:'1', node_role:'host'}
// POST /v1/snapshot => signed request required; return workspace snapshot
```

**Step 4: Run test to verify it passes**

Run: `node --test antigravity-mcp-sidecar/test/host-bridge-service.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/src/host-bridge-service.js antigravity-mcp-sidecar/test/host-bridge-service.test.mjs antigravity-mcp-sidecar/src/extension.js
git commit -m "feat(sidecar): add host bridge service on fixed loopback port 18900"
```

### Task 3: RemoteBridgeClient and mirror upsert

**Files:**
- Create: `antigravity-mcp-sidecar/src/remote-bridge-client.js`
- Create: `antigravity-mcp-sidecar/test/remote-bridge-client.test.mjs`
- Modify: `antigravity-mcp-sidecar/src/extension.js`

**Step 1: Write the failing test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemoteMirrorSnapshot } from '../src/remote-bridge-client.js';

test('remote mirror writes role=remote and local_endpoint.mode=forwarded', () => {
  const next = applyRemoteMirrorSnapshot({ registry: {}, remotePath: '/home/ssh/proj', forwardedPort: 19000, hostEntry: { workspace_id: 'abc', state: 'ready', source_endpoint: { host: '127.0.0.1', port: 9000 } } });
  const entry = Object.values(next).find((v) => v && v.role === 'remote');
  assert.equal(entry.local_endpoint.mode, 'forwarded');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test antigravity-mcp-sidecar/test/remote-bridge-client.test.mjs`
Expected: FAIL with module missing.

**Step 3: Write minimal implementation**

```javascript
// poll host bridge /v1/snapshot every 3s
// on failure: backoff 10s then 30s
// upsert mirrored entry with original_workspace_id + forwarded local_endpoint
// ttl expiry => mark state='stale' (do not delete immediately)
```

**Step 4: Run test to verify it passes**

Run: `node --test antigravity-mcp-sidecar/test/remote-bridge-client.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/src/remote-bridge-client.js antigravity-mcp-sidecar/test/remote-bridge-client.test.mjs antigravity-mcp-sidecar/src/extension.js
git commit -m "feat(sidecar): add remote bridge polling client and mirror registry upsert"
```

### Task 4: Server SSH hint mapping (AI-readable)

**Files:**
- Create: `antigravity-mcp-server/test/cdp-ssh-hint.test.mjs`
- Modify: `antigravity-mcp-server/src/index.ts`
- Modify: `antigravity-mcp-server/src/cdp.ts` (optional helper export only if needed)

**Step 1: Write the failing test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDiscoverError } from '../build/dist/index.js';

test('adds ssh host-not-ready hint for registry_missing under SSH env', () => {
  process.env.SSH_CONNECTION = '1';
  const out = formatDiscoverError({ code: 'registry_missing', message: 'x' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hint_code, 'ssh_host_antigravity_not_reachable_yet');
  delete process.env.SSH_CONNECTION;
});
```

**Step 2: Run test to verify it fails**

Run:
1. `npm --prefix antigravity-mcp-server run build`
2. `node --test antigravity-mcp-server/test/cdp-ssh-hint.test.mjs`
Expected: FAIL (no hint fields yet).

**Step 3: Write minimal implementation**

```typescript
// in index.ts
// detect SSH env via SSH_CONNECTION/SSH_CLIENT
// map discover codes to hint_code + hint_message + next_steps[]
// keep original error_code unchanged
```

**Step 4: Run tests to verify pass**

Run:
1. `npm --prefix antigravity-mcp-server run build`
2. `node --test antigravity-mcp-server/test/*.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add antigravity-mcp-server/src/index.ts antigravity-mcp-server/src/cdp.ts antigravity-mcp-server/test/cdp-ssh-hint.test.mjs
git commit -m "feat(server): add ssh-aware discovery hints for host antigravity reachability"
```

### Task 5: Wiring, docs, packaging verification

**Files:**
- Modify: `antigravity-mcp-sidecar/README.md`
- Modify: `antigravity-mcp-sidecar/AI_CONFIG_PROMPT.md`
- Modify: `antigravity-mcp-server/README.md`
- Modify: `antigravity-mcp-sidecar/src/extension.js`

**Step 1: Write failing verification checklist**

Create a checklist in commit message draft (or temporary note) requiring:
- Host bridge health endpoint reachable on host.
- Remote mirror created from forwarded host snapshot.
- Server returns SSH hint when host unavailable.

**Step 2: Run end-to-end smoke tests**

Run:
1. `node --check antigravity-mcp-sidecar/src/extension.js`
2. `node --test antigravity-mcp-sidecar/test/*.mjs`
3. `npm --prefix antigravity-mcp-server run build`
4. `node --test antigravity-mcp-server/test/*.mjs`
Expected: all PASS.

**Step 3: Sync runtime for sidecar bundle**

Run: `npm --prefix antigravity-mcp-sidecar run sync-server-runtime`
Expected: sync success output.

**Step 4: Build and verify VSIX artifact**

Run:
1. Repack VSIX to `build/antigravity-mcp-sidecar-<version>-local-<timestamp>.vsix`
2. `bash antigravity-mcp-sidecar/verify-vsix.sh <vsix-path>`
Expected: PASS.

**Step 5: Commit**

```bash
git add antigravity-mcp-sidecar/README.md antigravity-mcp-sidecar/AI_CONFIG_PROMPT.md antigravity-mcp-server/README.md antigravity-mcp-sidecar/src/extension.js antigravity-mcp-sidecar/server-runtime/dist
git commit -m "docs(sidecar,server): document ssh bridge v1 workflow and operational hints"
```

## Notes

- YAGNI: no push channel, no dynamic bridge port in v1.
- Keep bridge loopback-only and signed.
- Server must stay read-only against local registry.
