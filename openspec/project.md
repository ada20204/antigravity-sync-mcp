# Antigravity MCP Project Context

Last updated: 2026-03-01

Note:
- This file is the canonical detailed context.
- `openspec/config.yaml` intentionally keeps only minimal constraints + artifact rules to avoid duplication.

## 1. Project Purpose

This repository provides a practical bridge that lets external MCP clients (Claude Code, Cursor, etc.) drive Antigravity through a stable local contract.

Core objective:
- Use `antigravity-mcp-server` as the MCP runtime.
- Use `antigravity-mcp-sidecar` (VS Code extension) as the source of runtime truth (CDP status, quota snapshots, and cross-end restart control).

## 2. Main Components

### `packages/core`

Role:
- Shared package for registry types/schema, control constants, and platform/path helpers.
- Provides common primitives consumed by both server and sidecar.

### `packages/server`

Role:
- MCP tool host (`ask-antigravity`, `antigravity-stop`, `ping`, `launch-antigravity`).
- Connects to CDP and runs prompt injection/wait/extract loop.
- Applies quota-aware model fallback.

Hard constraints:
- Server is **read-only** for registry.
- Server reads only local `~/.config/antigravity-mcp/registry.json` (or `ANTIGRAVITY_REGISTRY_FILE` override for testing).
- Server does not perform broad network/port scanning as a primary path.

### `packages/sidecar`

Role:
- Discovers and verifies CDP endpoint.
- Writes registry entries (schema v2).
- Handles always-on auto-accept behavior.
- Collects quota snapshots and writes them to registry.
- Implements cross-end control plane (remote restart request -> host confirm -> restart execution).

Ownership:
- Sidecar/bridge logic are the only registry writers.
- Host sidecar is source-of-truth for runtime state.

## 3. Runtime Topology

### Single-host (local)

- Antigravity + sidecar + server run in same environment.
- Sidecar writes host entry with `local_endpoint`.
- Server picks matching workspace entry and connects directly.

### Host + remote (WSL/SSH class)

- Host sidecar owns true app/runtime state.
- Remote sidecar mirrors host entry to remote-local reachable endpoint and writes mirror entry locally.
- Remote server still reads only remote-local registry and connects only to local endpoint.

This keeps server logic environment-agnostic.

## 4. Registry Contract (Current)

Registry path:
- `~/.config/antigravity-mcp/registry.json`

Current schema baseline:
- `schema_version: 2`
- `protocol.compatible_schema_versions` present for negotiation.

Important fields used in behavior:
- Identity/routing:
  - `workspace_id`
  - `workspace_paths.normalized/raw`
  - `role` (`host` / `remote`)
  - `node_id`
- Connectivity:
  - `source_endpoint`
  - `local_endpoint` (server connection target)
- Health/state:
  - `state` (`app_down`, `launching`, `app_up_no_cdp`, `app_up_cdp_not_ready`, `ready`, `error`)
  - `verified_at`
  - `ttl_ms`
  - `last_error.code/message`
- Quota:
  - `quota`
  - `quota_meta`
- Control plane:
  - `__control__.restart_requests`

## 5. Local/Remote Interaction Model

### Data plane (CDP)

- Server reads local registry.
- Server validates schema/state/TTL/endpoint.
- Server connects only to `local_endpoint.host:local_endpoint.port`.

### Control plane (sidecar-to-sidecar)

- Remote sidecar creates signed restart request:
  - fields include `id/workspace_id/action/ts/nonce/from_node_id/to_node_id/signature`.
- Host sidecar verifies request with:
  - shared token
  - timestamp skew check
  - nonce replay protection
  - HMAC signature check
- Host shows modal confirmation.
- If approved, host executes restart and writes result status (`approved/applied/rejected/error`).

## 6. Security and Safety Rules

- Shared token managed via `~/.config/antigravity-mcp/bridge.token` by default (or config override).
- Replay defense through nonce cache + TTL.
- Timestamp skew bounded (`bridgeMaxSkewMs`).
- Pending control request expiration (`bridgeRequestTtlMs`).
- Host executes destructive restart actions only after explicit user confirmation.

## 7. Observability

Structured sidecar logs:
- Path: `~/.config/antigravity-mcp/logs/*.log`
- Required fields include:
  - `role`
  - `node_id`
  - `peer_node_id`
  - `workspace_id`
  - `trace_id`
  - `plane` (`ctrl` / `data`)
  - `state`
  - `error_code`

Retention:
- 7-day cleanup (startup + periodic sweep).

## 8. Model and Quota Behavior

- Quota snapshot is collected by sidecar and stored in registry.
- Server model policy uses quota when fresh, and falls back when exhausted.
- If quota is stale, server avoids over-filtering and falls back conservatively.

## 9. Build, Test, and Packaging

### Core

- Tests: `node --test packages/core/test/*.mjs`

### Server

- Build: `npm --workspace packages/server run build`
- Tests: `node --test packages/server/test/*.mjs`
- Package: `npm pack --workspace packages/server`

### Sidecar

- Syntax check:
  - `node -c packages/sidecar/src/extension.js`
  - `node -c packages/sidecar/src/structured-log.js`
  - `node -c packages/sidecar/src/bridge-auth.js`
- VSIX verification script:
  - `packages/sidecar/verify-vsix.sh`

## 10. Current Known Operational Constraints

- In restricted/offline environments, automatic `vsce` download may fail; packaging can require preinstalled tooling or offline repack workflow.
- Remote side cannot cold-start host app directly; remote restart path must go through host confirmation protocol.
- Registry freshness (`verified_at` + `ttl_ms`) is treated as a hard gate by server discovery.

## 11. Engineering Conventions for Future Changes

- Keep server as pure executor:
  - no registry writes
  - no environment-specific probe heuristics as primary behavior
- Keep sidecar as runtime truth source:
  - state machine updates
  - control-plane orchestration
  - quota snapshot publishing
- Any protocol change must update both:
  - schema/version negotiation in sidecar + server
  - strict error mapping for discovery diagnostics

## 12. Short Glossary

- Host: Environment where Antigravity UI/process is actually running.
- Remote: WSL/SSH-like environment where MCP server may run separately.
- Data plane: CDP request/response path used by server.
- Control plane: Sidecar coordination path for lifecycle/restart and bridge management.
