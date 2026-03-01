# Antigravity Host-SSH Sidecar Bridge Design

## Context

Current behavior mixes environment-specific probing logic into the server path, especially in WSL/SSH scenarios. This creates unstable behavior:

- Server behavior changes by runtime environment.
- CDP endpoint discovery relies on broad scanning.
- Cross-environment recovery is unclear.
- Remote workflows cannot cleanly recover Host-side Antigravity state.

The target model is to treat WSL as a Remote/SSH class environment and separate control concerns from execution concerns.

## Goal

Define a stable bridge architecture where:

1. `server` is environment-agnostic and reads only local registry.
2. `Host sidecar` is authoritative for Antigravity runtime truth.
3. `Remote sidecar` mirrors Host truth into remote-local reachable endpoints.
4. Data path uses Antigravity/VS Code port forwarding (SSH -> Host), not ad-hoc global scanning.

## Non-Goals

- Building a general cross-machine process manager.
- Letting server write registry or orchestrate cross-host operations.
- Introducing long-lived custom CDP proxy as default path.
- LS endpoint forwarding (deferred to future iteration).

## Core Constraints (Locked)

1. Server reads only `~/.config/antigravity-mcp/registry.json` in its own environment.
2. Server never writes registry.
3. Only sidecar/bridge logic may write registry.
4. Host is source-of-truth for Antigravity runtime status.

## High-Level Architecture

### Components

- `Host Sidecar (authoritative)`  
  Detects Antigravity process/CDP state, owns runtime actions (start/restart), publishes source endpoint.

- `Remote Sidecar (mirror)`  
  Receives Host snapshots, resolves remote-local reachable forwarded endpoint, writes local mirror registry.

- `MCP Server (pure executor)`  
  Reads local registry, connects only to local endpoint, runs ask flow. No environment-specific networking logic.

### Planes

- `Control Plane`  
  Sidecar-to-sidecar snapshot sync, health/status updates, recovery requests.

- `Data Plane`  
  CDP traffic through local reachable endpoint (`local_endpoint`), preferably via Antigravity/VS Code port forwarding.

## Registry Contract

Registry path in every environment:

- `~/.config/antigravity-mcp/registry.json`

Each workspace entry contains:

```json
{
  "schema_version": 1,
  "workspace_id": "sha256(normalized-workspace-path)",
  "workspace_paths": {
    "normalized": "/home/elliot/antigravity-sync",
    "raw": "/home/elliot/antigravity-sync"
  },
  "role": "host|remote",
  "source_of_truth": "host",
  "source_endpoint": {
    "host": "127.0.0.1",
    "port": 9000
  },
  "local_endpoint": {
    "host": "127.0.0.1",
    "port": 19000,
    "mode": "direct|forwarded"
  },
  "state": "app_down|launching|app_up_no_cdp|app_up_cdp_not_ready|ready|stale|error",
  "verified_at": 1700000000000,
  "ttl_ms": 30000,
  "priority": 100,
  "quota": {},
  "quota_meta": {
    "source": "host|mirrored",
    "stale": false,
    "refreshed_at": 1700000000000,
    "refresh_interval_ms": 60000
  },
  "last_error": {
    "code": "cdp_not_reachable",
    "message": "..."
  }
}
```

## State Machine (Authoritative on Host)

1. `app_down`  
   Antigravity process not found.

2. `launching`  
   Host sidecar has initiated a launch/restart. Process may not exist yet.
   Prevents duplicate launch requests from remote sidecars.
   Auto-expires to `app_down` if process does not appear within `launch_timeout_ms` (default: 60s).

3. `app_up_no_cdp`  
   Process exists, CDP `/json/version` unreachable.

4. `app_up_cdp_not_ready`  
   `/json/version` reachable, but `/json/list` has no valid workbench target.

5. `ready`  
   CDP version + target both verified.

6. `stale`  
   Last ready snapshot exceeded TTL.

7. `error`  
   Protocol/auth/bridge failures.

## Recovery Policy (Locked)

### Local/Host

- `app_down` -> start Antigravity directly. Transition to `launching`.
- `app_up_no_cdp` -> confirm dialog via VS Code modal, then `taskkill` + restart with debug args. Transition to `launching`.
- `app_up_cdp_not_ready` -> bounded retry (3 attempts, 2s interval) before escalation to `error`.
- `launching` -> no-op (wait for timeout or transition).

#### Kill safety

`taskkill /F /T` is only executed by the **host sidecar** after user confirmation via `vscode.window.showWarningMessage` with explicit "Restart" / "Cancel" choices. The MCP server `launch-antigravity` tool delegates to the same `launchAntigravityForWorkspace` function but the `killExisting` flag should only be honored when running on the host (not forwarded from remote). Remote restart requests always route through the host sidecar confirmation flow.

### Remote/SSH/WSL

- `app_down` -> return instruction: user opens Antigravity on Host.
- `app_up_no_cdp` -> remote may request restart, but Host must show confirmation and execute.
- `app_up_cdp_not_ready` -> wait/retry and refresh forwarded mapping.

## Auto-Accept Ownership

Two auto-accept implementations exist today:

- **Server-side** (`auto-accept.ts`): CDP `Runtime.evaluate` injection into all execution contexts. Runs during the ask polling loop.
- **Sidecar-side** (`auto-accept.js`): VS Code native commands (`antigravity.agent.acceptAgentStep`, etc.) + CDP webview multiplex via browser-level WebSocket.

### Target state

Auto-accept is a **sidecar responsibility**, not a server responsibility. The server's role is inject → wait → extract.

- **Phase 1 (current)**: Both implementations coexist. Server auto-accept runs only during active ask tasks. Sidecar auto-accept runs continuously while enabled. No conflict because they target different button surfaces (server: page-level contexts; sidecar: webview targets + native commands).
- **Phase 2**: Server drops `auto-accept.ts`. Sidecar becomes sole owner. Server relies on sidecar being active during ask flow.
- **Phase 2 prerequisite**: Sidecar must reliably cover all permission surfaces that server currently handles. Validate with integration test before removing server-side path.

### Coordination rule

If both are active simultaneously, sidecar's 5-second click cooldown (`data-aa-t` attribute) prevents double-clicks. No additional coordination needed in Phase 1.

## Port Forwarding Strategy

Remote sidecar resolves `local_endpoint` with:

1. API path (preferred): Antigravity/VS Code port forwarding API.
2. CLI path (fallback): command-based forwarded-port discovery.

If Host `source_endpoint=127.0.0.1:9000`, remote may map it to `127.0.0.1:19000`.  
Server in remote environment uses only `127.0.0.1:19000`.

No requirement that remote port equals host CDP port.

## Sidecar-to-Sidecar Protocol

### Communication channel

Phase 1 (pragmatic): **Registry file polling over shared filesystem or port-forwarded HTTP**.

- **Same-machine (WSL ↔ Host)**: Both sidecars read/write the same `registry.json` via `/mnt/c/` mount. Host writes authoritative entry; remote sidecar reads it, translates `local_endpoint`, and writes a mirror entry keyed by remote workspace path. No network protocol needed.
- **SSH remote**: Remote sidecar polls a lightweight HTTP endpoint exposed by host sidecar on a known port (default: `18900`). Endpoint returns the current registry snapshot for the requested workspace. Remote sidecar writes translated mirror to local registry.
- **Fallback**: If HTTP endpoint is unreachable, remote sidecar reads the forwarded CDP port's `/json/version` directly to infer `ready` state, and constructs a minimal registry entry.

Phase 2 (future): WebSocket push from host to remote for lower latency.

### Sync model

- Host publishes snapshots (`version`, `updated_at`, `ttl_ms`).
- Remote mirrors snapshot to local registry with translated `local_endpoint`.
- Consistency target is eventual consistency (not strong consistency).
- Poll interval: 5s (remote HTTP), 3s (same-machine file watch via `fs.watchFile`).

### Auth model (Phase 1)

- Static shared token + `timestamp` + `nonce` + `HMAC`.
- Reject if timestamp skew/nonce replay/signature mismatch.

## Server Behavior

Server algorithm is intentionally minimal:

1. Compute `workspace_id = sha256(normalize(targetDir))` from the `--target-dir` argument or `cwd`.
2. Read local registry, find entry where `workspace_id` matches. If multiple entries exist, prefer `role=host` over `role=remote`, then highest `priority`.
3. Validate `schema_version >= 1`, `state=ready`, and `verified_at + ttl_ms > now`.
4. Connect to `local_endpoint.host:local_endpoint.port`.
5. Execute normal ask flow (inject → auto-accept → wait → extract).

If registry entry is absent/stale/error, return structured diagnostics:

```json
{
  "error": "registry_not_ready",
  "workspace_id": "abc123...",
  "state": "app_down",
  "suggestion": "Ensure Antigravity is running with the sidecar extension enabled."
}
```

Server never probes candidate IPs, never scans port ranges, never writes registry.

### workspace_id resolution

`normalize(path)` lowercases drive letters, replaces `\` with `/`, strips trailing `/`, and resolves `.`/`..`. The `sha256` is hex-encoded, truncated to 16 chars for readability. `workspace_paths.normalized` and `workspace_paths.raw` are stored for human debugging only — matching always uses `workspace_id`.

## Logging and Observability

Single local log root per environment:

- `~/.config/antigravity-mcp/logs/*.log`

Structured fields required in each log event:

- `role` (`host|remote`)
- `node_id`
- `peer_node_id`
- `workspace_id`
- `trace_id`
- `plane` (`ctrl|data`)
- `state`
- `error_code` (if any)

Defaults:

- log level: `info`
- debug mode: explicit opt-in
- retention: 7 days

## Config Precedence

1. Manual fixed config (operator override)
2. Host snapshot (authoritative)
3. Local auto-discovery fallback

## Security Rules

1. Server: read-only on registry.
2. Sidecar/bridge: exclusive writers.
3. Registry file permissions should be restrictive (`600` equivalent).
4. Do not persist sensitive csrf tokens in registry.

## Quota Sync Policy

Host sidecar polls Antigravity quota API every `refresh_interval_ms` (default: 60s) and writes snapshot to registry.

Remote sidecar mirrors the quota snapshot from host. Mirrored quota is marked `source: "mirrored"` and inherits the host's `refreshed_at` timestamp. Remote sidecar does not independently poll quota.

Server-side `quota-policy.ts` uses the snapshot for model selection:

1. If `quota_meta.stale=true` or `refreshed_at + refresh_interval_ms * 3 < now`, treat quota as stale — skip filtering entirely and use the mode-default chain.
2. If quota is fresh, filter exhausted models (`remainingFraction <= 0`) from the candidate chain.
3. Fallback: if all models filtered, use first candidate anyway and let runtime fail with explicit diagnostics.

This matches the current implementation. No changes needed for Phase 1.

## Testing Strategy

### Unit

- Workspace ID normalization/hash equivalence across Windows/WSL/SSH paths.
- State transitions and TTL expiry behavior.
- Auth signature and replay rejection.
- Endpoint selection and precedence.
- DOM selector regression: snapshot-based tests for `injectMessage`, `extractLatestResponse`, `pollCompletionStatus` selectors against known Antigravity HTML structures.

### Integration

- Host-only (single-sidecar) workflow remains functional.
- Host+Remote workflow with port forwarding API path.
- API unavailable -> CLI fallback works.
- Remote restart request requires Host confirmation.
- Server in both environments succeeds using only local registry.

### Failure Scenarios

- Host sidecar down, remote sidecar alive.
- Forwarded port invalidated mid-session.
- Registry stale while process is still up.
- Auth mismatch between sidecars.
- Antigravity UI update breaks DOM selectors (extractLatestResponse returns fallback message).
- Duplicate launch: remote requests launch while host is already in `launching` state.

## Rollout Plan

1. Introduce schema v1 writer in host sidecar behind feature flag. Server reads both v0 (legacy) and v1 entries.
2. Server switches to `workspace_id` matching + `local_endpoint` only. Legacy probe paths kept as gated fallback.
3. Add `launching` state and kill-safety confirmation to host sidecar.
4. Add remote sidecar mirror (same-machine file-based first, then HTTP poll for SSH).
5. Server drops auto-accept.ts; sidecar becomes sole auto-accept owner.
6. Remove legacy environment-specific probe paths after 2-week stability window.

## Decision Summary

1. Host is source-of-truth.
2. Server remains local read-only.
3. `local_endpoint` is the only server connection target.
4. WSL is treated as Remote/SSH class behavior.
5. `app_down` and `app_up_no_cdp` recovery are intentionally different.
6. Auto-accept ownership migrates from server to sidecar (Phase 2).
7. `launching` state prevents duplicate launch from remote.
8. `taskkill` requires user confirmation on host; remote cannot force-kill.
9. Sidecar-to-sidecar Phase 1: file polling (WSL) / HTTP poll (SSH).
10. LS endpoint forwarding deferred to future iteration.
