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
  "state": "app_down|app_up_no_cdp|app_up_cdp_not_ready|ready|stale|error",
  "verified_at": 1700000000000,
  "ttl_ms": 30000,
  "priority": 100,
  "quota": {},
  "quota_meta": {
    "source": "host|mirrored",
    "stale": false
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

2. `app_up_no_cdp`  
   Process exists, CDP `/json/version` unreachable.

3. `app_up_cdp_not_ready`  
   `/json/version` reachable, but `/json/list` has no valid workbench target.

4. `ready`  
   CDP version + target both verified.

5. `stale`  
   Last ready snapshot exceeded TTL.

6. `error`  
   Protocol/auth/bridge failures.

## Recovery Policy (Locked)

### Local/Host

- `app_down` -> start Antigravity directly.
- `app_up_no_cdp` -> confirm dialog, then restart with debug args.
- `app_up_cdp_not_ready` -> bounded retry before escalation.

### Remote/SSH/WSL

- `app_down` -> return instruction: user opens Antigravity on Host.
- `app_up_no_cdp` -> remote may request restart, but Host must show confirmation and execute.
- `app_up_cdp_not_ready` -> wait/retry and refresh forwarded mapping.

## Port Forwarding Strategy

Remote sidecar resolves `local_endpoint` with:

1. API path (preferred): Antigravity/VS Code port forwarding API.
2. CLI path (fallback): command-based forwarded-port discovery.

If Host `source_endpoint=127.0.0.1:9000`, remote may map it to `127.0.0.1:19000`.  
Server in remote environment uses only `127.0.0.1:19000`.

No requirement that remote port equals host CDP port.

## Sidecar-to-Sidecar Protocol

### Sync model

- Host publishes snapshots (`version`, `updated_at`, `ttl_ms`).
- Remote mirrors snapshot to local registry with translated `local_endpoint`.
- Consistency target is eventual consistency (not strong consistency).

### Auth model (Phase 1)

- Static shared token + `timestamp` + `nonce` + `HMAC`.
- Reject if timestamp skew/nonce replay/signature mismatch.

## Server Behavior

Server algorithm is intentionally minimal:

1. Read local registry entry by `workspace_id`.
2. Validate `schema_version`, `state=ready`, and non-stale TTL.
3. Connect to `local_endpoint`.
4. Execute normal ask flow.

If registry entry is absent/stale/error, return structured diagnostics instead of environment probing.

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

## Testing Strategy

### Unit

- Workspace ID normalization/hash equivalence across Windows/WSL/SSH paths.
- State transitions and TTL expiry behavior.
- Auth signature and replay rejection.
- Endpoint selection and precedence.

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

## Rollout Plan

1. Introduce schema v1 writer in sidecar behind feature flag.
2. Add remote mirror and forwarding resolver (API first, CLI fallback).
3. Switch server to strict local registry consumption.
4. Enable Host-authoritative recovery policies.
5. Remove legacy environment-specific probe paths after stability window.

## Decision Summary

1. Host is source-of-truth.
2. Server remains local read-only.
3. `local_endpoint` is the only server connection target.
4. WSL is treated as Remote/SSH class behavior.
5. `app_down` and `app_up_no_cdp` recovery are intentionally different.
