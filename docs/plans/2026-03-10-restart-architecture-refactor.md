# Restart Architecture Refactor Plan

> Generated: 2026-03-10
> Status: Draft — pending prioritization

## Background

Current restart implementation works but has 6 known issues:
1. Too many restart entry points with unclear semantics
2. PID / port source scattered and inconsistent
3. wait-exit fallback degrades to 12s timeout silently
4. restart-worker.js and switch-worker.js have duplicated logic
5. Timeout constants are global but platform-dependent
6. Diagnostic information is process-log only, not structured

## 1. Restart Semantic Model

Replace overloaded "restart" with explicit operation types:

| Operation | Meaning | Port Policy | Exit Strategy |
|-----------|---------|-------------|---------------|
| `cold_start` | Launch new instance, nothing running | allocate/fixed | none |
| `relaunch_in_place` | Restart current instance | reuse current | wait-exit preferred |
| `relaunch_with_auth_clear` | Restart + clear auth (Add Another Account) | reuse current | wait-exit + DB clear |
| `switch_account_relaunch` | Restart + switch account | reuse current | wait-exit + DB restore |
| `force_restart` | Explicit kill + relaunch (recovery) | reuse/allocate | force-kill |

Standard request shape:
- `operation_type`
- `trigger` (manual_command, account_add, account_switch, remote_request, etc.)
- `workspace_path`
- `endpoint_policy` (reuse_required, allocate_allowed, fixed_only)
- `exit_strategy` (wait_pid, wait_port_owner, force_kill)
- `auth_mutation` (none, clear, restore)
- `wait_for_cdp`

## 2. Shared Worker Core

Create `packages/sidecar/scripts/worker-core/` with reusable modules:

- `request-schema.js` — Parse/validate args, backward-compatible flag mapping
- `endpoint-resolver.js` — Resolve target endpoint + source metadata
- `pid-resolver.js` — Resolve PID from endpoint ownership (lsof/netstat) with retry
- `waiter.js` — Wait strategies: by PID, by port release, by process pattern (degraded only)
- `launcher-core.js` — Launch invocation + platform method selection + CDP verify
- `db-mutation.js` — Auth clear/restore routines
- `result-writer.js` — Structured status/result JSON + legacy files
- `timeout-policy.js` — Platform + operation + phase timeout resolution

restart-worker.js and switch-worker.js become thin wrappers.

## 3. Structured Diagnostic/Result Schema (v2)

```json
{
  "schema_version": 2,
  "request_id": "...",
  "operation_type": "relaunch_with_auth_clear",
  "trigger": "account_add",
  "status": "success|failed|timeout|degraded",
  "phase": "complete",
  "started_at": 1773112375709,
  "ended_at": 1773112380000,
  "duration_ms": 4291,
  "workspace_path": "/Users/elliot/project",
  "endpoint": { "host": "127.0.0.1", "port": 9000 },
  "selected_port": 9000,
  "selected_port_source": "current|registry|allocated|fixed",
  "resolved_pid": 35805,
  "resolved_pid_source": "port_owner|provided|none",
  "wait_strategy": "by_pid|by_process_name|by_port_release",
  "wait_timeout_ms": 12000,
  "wait_timeout_hit": false,
  "launch_method": "open_a|direct_spawn|windows_spawn|fallback_direct",
  "auth_clear_applied": true,
  "auth_restore_applied": false,
  "cdp_verified": true,
  "timeouts_effective": {
    "wait_exit_ms": 12000,
    "port_release_ms": 0,
    "launch_detect_ms": 15000,
    "cdp_verify_ms": 10000,
    "absolute_ms": 60000,
    "relaunch_cooldown_ms": 0
  },
  "errors": [],
  "warnings": [],
  "degraded_fallbacks": []
}
```

Continue writing legacy fields during migration.

## 4. Platform-Aware Timeout Configuration

Replace global constants with policy map:

| Phase | macOS/Linux | Windows |
|-------|-------------|---------|
| wait_exit_ms | 12000 | 15000 |
| port_release_ms | 0 | 8000 |
| launch_detect_ms | 3000 | 15000 |
| cdp_verify_ms | 10000 | 15000 |
| absolute_ms | 30000 | 60000 |
| relaunch_cooldown_ms | 0 | 1500 |

Allow env overrides per key with clamp bounds.

## 5. Port/PID Resolution — Single Source of Truth

### Endpoint resolution by policy:
- `reuse_required`: resolve from active runtime endpoint (cdpTarget, then registry). Fail fast if unresolved.
- `allocate_allowed`: use allocator (fixed first, else available range).
- `fixed_only`: require configured fixed port to be available.

### PID resolution:
- Always derive from chosen endpoint via `resolveListeningPidForPort(selected_port)`.
- No independent process-name-first path for wait-exit mainline.
- Unresolved PID = explicit `degraded` mode, not silent 12s timeout.

### Unify sidecar and server allocator:
- Share one module for occupied-port collection + TCP availability check.

## 6. Phased Implementation Roadmap

### Phase 1: Semantics + Diagnostics Foundation (low risk)
- Add operation enum + request model in extension layer
- Pass explicit `operation_type` to existing workers
- Add v2 structured result writing (preserve legacy files)
- Update logs/UI messaging to use semantic names

### Phase 2: Endpoint/PID Resolver Unification (medium risk)
- Extract shared resolver from extension.js + server launch module
- Replace ad-hoc port selection chains with `resolveEndpoint(policy)`
- Strict wait-exit: unresolved PID → explicit error/degraded path

### Phase 3: Worker-Core Extraction (medium risk)
- Implement worker-core modules
- Migrate restart-worker.js to core
- Add parity tests against current behavior

### Phase 4: Switch Worker Consolidation (medium-high risk)
- Move switch-worker wait/launch/verify to worker-core
- Remove duplicate logic
- Keep command/API behavior unchanged

### Phase 5: Platform Timeout Tuning (low risk)
- Enable per-platform/per-op timeout policy
- Tune defaults using collected duration_ms and timeout-hit metrics

### Phase 6: Cleanup + Deprecation (low risk)
- Deprecate old flags/names
- Remove dead paths (restartAntigravity primitive if unused)
- Keep compatibility adapters one release, then prune

## 7. Backward Compatibility

- Existing VS Code commands and MCP launch-antigravity contract stay valid
- Old worker flags (--wait-exit, --cold-start, --clear-auth) map to new operation model
- Continue writing legacy status/result files during migration window
- Feature flag: `lifecycle_core_enabled` for incremental rollout
- Golden tests for old result parsing + E2E tests for all restart paths
