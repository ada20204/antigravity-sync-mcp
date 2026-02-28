# Antigravity Startup Orchestration Design

## Context

Current startup relies heavily on CDP auto-discovery. In real Windows environments, fixed ports like `9222` can be occupied by system services (`iphlpsvc`/portproxy), causing false startup failures and poor operator experience.

The project now needs deterministic startup behavior:

- Client-triggered flow can actively bring up Antigravity.
- Manual user startup remains supported.
- Restart operations require explicit user confirmation.
- If Antigravity opens for the wrong project, startup should target a **new window** for the requested workspace.

## Goal

Deliver a two-layer startup strategy:

1. **Cold start**: server can bring Antigravity up when sidecar is not yet alive.
2. **Warm control**: sidecar manages runtime checks, manual launch/restart commands, and stable registry signaling.

## Non-Goals

- Building a full process supervisor/daemon outside server + sidecar.
- Auto-restarting Antigravity without user confirmation.
- Supporting arbitrary third-party browsers in the CDP path.

## High-Level Architecture

### Layer A: Server Orchestrator

- `ask-antigravity` starts with `ensureAntigravityReady()`.
- If `registry.cdp.state=ready` and endpoint is fresh, proceed directly.
- If no ready endpoint and sidecar heartbeat is absent/stale, server performs **cold start launch**.
- After launch, server waits for `cdp.ready` and continues normal ask flow.

### Layer B: Sidecar Runtime Controller

- Sidecar exposes manual commands:
  - `Launch Antigravity`
  - `Restart Antigravity` (with confirmation dialog)
- Sidecar monitors CDP health and updates registry contract.
- Sidecar never performs implicit restart during cold-start adoption window.

### Shared Contract: Registry Negotiation

Registry (`~/.antigravity-mcp/registry.json`) gains explicit launch/CDP state:

- `cdp.state`: `idle|probing|ready|error`
- `cdp.active`: `{ host, port, source, verifiedAt }`
- `cdp.generation`, `cdp.probeSummary`, `cdp.lastError`
- `launch`: request/response envelope between orchestrator and executor.

## Lifecycle Design

### 1) Cold Start (Server-led)

- Preconditions:
  - no fresh `cdp.ready`
  - sidecar not online (or not yet available)
- Server chooses launch parameters:
  - host defaults to `127.0.0.1`
  - port strategy: fixed port (if configured) else candidate list
- Server launches:
  - `Antigravity.exe "<targetDir>" --new-window --remote-debugging-port=<port> --remote-debugging-address=0.0.0.0`
- Server polls for ready CDP endpoint and registry confirmation.

### 2) Warm Adoption (Sidecar-led)

- Sidecar starts inside Antigravity and adopts active endpoint.
- Sidecar writes `cdp.ready` with fresh `verifiedAt`.
- During protection window (e.g., 120s after cold start), sidecar does not auto-restart.

### 3) Manual Recovery

- `Restart Antigravity` requires user confirmation every time.
- `Launch Antigravity` only starts if not running or if explicit action chosen.
- On restart success, sidecar re-verifies and writes fresh `cdp.ready`.

## Launch Protocol (Plain Language)

- Server writes a launch request (`launch.status=pending`).
- Executor (server cold path or sidecar warm path) marks `running`.
- On success: write `launch.succeeded` + `cdp.ready`.
- On failure/timeout: write `launch.failed|expired` + structured error code/message.

## Default Behavior Decisions

- **No implicit restart** in normal runtime.
- **Restart always requires user confirmation**.
- **Project mismatch uses new window** by default.
- **Port conflict does not block flow**: choose next candidate and report diagnostics.

## Error Handling

Standardized error categories:

- `port_in_use`
- `launch_failed`
- `start_timeout`
- `cdp_not_reachable`
- `cdp_not_antigravity`
- `registry_write_failed`

Each failure writes:

- machine-readable code
- short human-readable message
- last probe tuple (`host:port`, stage)

## Observability

Required logs/events:

- cold start attempt + selected port
- sidecar adoption event
- restart confirmation decision
- final ready endpoint (`host:port`)
- launch failure code + last probe reason

Registry stores compact probe summary for postmortem without huge file growth.

## Security/Safety Notes

- Only allow executable path from trusted config/default install path.
- Escape and validate workspace path before process spawn.
- Never execute arbitrary shell fragments from registry.

## Test Strategy

### Unit

- Port candidate parsing and fixed-port precedence.
- Registry state transitions (`pending->running->succeeded/failed`).
- Freshness and protection-window logic.

### Integration (local)

- Simulate occupied `9222` and verify fallback to `9000`.
- Cold start from no Antigravity process.
- Warm flow with sidecar alive and no restart.
- Manual restart requires explicit confirmation.

### Acceptance

- From a clean desktop session, one `ask-antigravity` can boot Antigravity and return answer.
- Wrong-project scenario opens target workspace in a new window.

## Rollout Plan

1. Ship behind config flags:
   - server auto-launch enable
   - sidecar restart policy
2. Validate with known problematic Windows hosts (`iphlpsvc` occupying 9222).
3. Enable by default after telemetry/log confidence.

## Open Questions (Captured)

- Whether to expose launch protocol diagnostics in a dedicated sidecar command panel.
- Whether future versions should allow custom launch arguments per workspace.

