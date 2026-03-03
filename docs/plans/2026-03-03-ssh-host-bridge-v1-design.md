# SSH Host Bridge v1 Design

## 1. Context

Current usage includes an SSH-remote development mode:
- Antigravity runs on the host machine.
- MCP server may run on the SSH remote host.
- Remote access to Host CDP relies on plugin-level port forwarding.

The system currently lacks a bundled host<->remote bridge component and requires clearer diagnostics for first-time connectivity.

## 2. Goal

Deliver a modular Bridge v1 that supports SSH-remote workflows while preserving existing invariants:
1. Server remains environment-agnostic and reads only local registry.
2. Host sidecar remains source-of-truth for Antigravity runtime state.
3. Remote sidecar mirrors host truth into remote-local reachable endpoints.
4. First-time recovery guidance is explicit: user opens Antigravity on Host and keeps SSH remote session active.

## 3. Non-Goals

- No generalized cross-machine process manager.
- No server-side registry writes.
- No mandatory pairing wizard.
- No WebSocket push in v1 (polling only).

## 4. Constraints (Locked)

1. Registry path per environment: `~/.config/antigravity-mcp/registry.json`.
2. Server only reads local registry.
3. Sidecar/bridge is the only writer of registry bridge entries.
4. Host bridge port is fixed in v1: `127.0.0.1:18900`.

## 5. Architecture

### 5.1 Components

- HostBridgeService (host sidecar)
  - Fixed HTTP endpoint on `127.0.0.1:18900`.
  - Exposes host snapshot and health APIs.
  - No remote-triggered restart execution in v1.

- RemoteBridgeClient (remote sidecar)
  - Reads forwarded host bridge endpoint.
  - Pulls host snapshots and writes mirrored local registry entries.

- BridgeProtocol (shared)
  - Request/response schema.
  - Auth/signature verification.
  - Versioned error code model.

- MCP Server
  - Reads local registry only.
  - Uses existing `original_workspace_id` fallback logic.

### 5.2 Control/Data Plane

- Control plane: Host snapshot pull + structured bridge diagnostics.
- Data plane: CDP traffic through mirrored `local_endpoint` (`mode=forwarded`).

## 6. Protocol Design (v1)

Base URL: `http://127.0.0.1:18900`

Auth headers (signed endpoints):
- `x-ag-bridge-ts`
- `x-ag-bridge-nonce`
- `x-ag-bridge-signature`
- `x-ag-bridge-node-id`

Signature input:
`METHOD\nPATH\nBODY_SHA256\nTS\nNONCE\nNODE_ID`

### 6.1 Endpoints

1. `GET /v1/health`
- Response: `status`, `bridge_version`, `node_role`.

2. `POST /v1/snapshot`
- Request: `workspace_id?`, `workspace_path?`, `want_quota?`.
- Response: `schema_version`, `entry`, `server_time`, `ttl_ms`.
- Errors: `auth_invalid`, `workspace_not_found`, `entry_not_ready`, `stale_snapshot`.

3. `POST /v1/control/request-no-cdp-help` (optional in v1)
- Requests host-side user guidance only.

## 7. Registry Model

### 7.1 Host Entry (authoritative)
- `role=host`
- `source_of_truth=host`
- `source_endpoint` points to host-side CDP source.
- `local_endpoint.mode=direct`

### 7.2 Remote Mirror Entry
- `role=remote`
- `original_workspace_id=<host_workspace_id>`
- `local_endpoint.mode=forwarded`
- `local_endpoint.host=127.0.0.1`
- `local_endpoint.port=<forwarded_cdp_port>`
- `source_of_truth=host`

## 8. SSH Scenario Behavior

### 8.1 First-time manual action (locked)

No pairing wizard. When remote cannot reach host Antigravity/CDP path, system must guide:
- "Please open Antigravity on Host and keep SSH remote session connected."
- "Connection is established through plugin port forwarding."

### 8.2 Trigger model

- Server is primary for user-facing actionable diagnostics.
- Sidecar only emits light guidance (no startup popup spam).

## 9. Error & Hint Strategy

Keep underlying discover errors unchanged, add bridge-aware hints:
- `hint_code=ssh_host_antigravity_not_reachable_yet`
- `hint_message` includes host-open + SSH-session + forwarded-path guidance.

Applied when:
- SSH-remote context is detected.
- Failure class indicates host/CDP not currently reachable (`registry_missing`, `workspace_not_found`, `endpoint_unreachable`, `entry_not_ready` with host-down/no-cdp states).

## 10. Refresh and TTL Policy

- Remote snapshot polling: every 3s.
- Failure backoff: 10s -> 30s.
- Mirror TTL: 30s.
- Expired mirror state becomes `stale` (do not hard-delete immediately).

## 11. Security

- Host bridge binds loopback only.
- HMAC with timestamp + nonce replay protection.
- Reject stale timestamp, reused nonce, invalid signature.

## 12. Testing & Acceptance

### 12.1 Unit
- Bridge auth validation and nonce replay checks.
- Snapshot request/response schema validation.
- Hint mapping logic for SSH failure classes.

### 12.2 Integration
- Remote server + no host Antigravity => actionable SSH hint returned.
- Host opens Antigravity => remote mirror updates => request succeeds.

### 12.3 Regression
- Local non-SSH workflow unchanged.
- Existing `discoverCDPDetailed` fallback behavior preserved.

## 13. Delivery Phases

- Phase A
  - Host `/v1/health` + `/v1/snapshot`
  - Remote pull + mirror write
  - Server hint integration

- Phase B
  - Optional host-side guidance request endpoint

- Phase C
  - Evaluate push transport (WebSocket) if polling latency is insufficient

## 14. Open Items

1. Exact forwarded port resolution source in remote sidecar (VS Code API vs configured static mapping).
2. Whether `request-no-cdp-help` ships in phase A or B.
3. Bridge token distribution/rotation policy for managed environments.
