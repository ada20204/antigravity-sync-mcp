## Context

`antigravity-mcp-server` currently sends prompts and determines completion via CDP DOM state. This works for many flows but remains sensitive to UI selector drift, temporary UI pauses, and ambiguous completion transitions. In addition, model routing is static and does not account for real-time quota exhaustion. This leads to avoidable retries and degraded reliability for long-running tasks.

The target architecture is a hybrid: keep CDP as the action channel for prompt submission and UI controls, while introducing LS-driven state and quota policy for correctness and resilience. This change spans both `antigravity-mcp-server` and `antigravity-mcp-sidecar`.

## Goals / Non-Goals

**Goals:**
- Improve wait-state correctness by prioritizing LS signals (`StreamCascadeReactiveUpdates`) and falling back to `GetCascadeTrajectory`, with current DOM polling as last resort.
- Keep CDP prompt injection as the primary submission mechanism.
- Add explicit model and mode routing inputs to `ask-antigravity`.
- Add quota snapshot collection and consumption for policy decisions.
- Add automatic model fallback when quota is exhausted or model status is unavailable.
- Preserve backward compatibility for existing callers that only provide `prompt`.

**Non-Goals:**
- Replacing CDP prompt injection with LS message submission in this change.
- Building full LS proxy functionality outside the required wait/quota/routing surfaces.
- Introducing new external runtime dependencies beyond existing Node/TypeScript tooling.

## Decisions

### 1. Hybrid wait-state engine with ordered fallbacks
- Decision: introduce a wait engine with three ordered sources:
  1) LS stream events (`StreamCascadeReactiveUpdates`),
  2) LS polling (`GetCascadeTrajectory`),
  3) existing DOM polling (`pollCompletionStatus`).
- Rationale: LS state is less UI-fragile; DOM fallback preserves current behavior when LS endpoints are unavailable.
- Alternatives considered:
  - DOM-only (rejected: fragile and ambiguous completion).
  - LS-only (rejected: riskier rollout and dependency on cascade ID resolution in all environments).

### 2. Keep CDP as send path, separate policy from action
- Decision: keep `injectMessage()` for prompt submission and use policy outputs to drive model/mode UI selection before send.
- Rationale: maintains compatibility with current successful flows and avoids broad protocol migration.
- Alternatives considered:
  - switch to LS `SendUserCascadeMessage` now (rejected for scope and migration risk).

### 3. Sidecar-owned quota snapshot, server-owned routing policy
- Decision: sidecar fetches LS quota (`GetUserStatus`) and publishes normalized snapshot; MCP server consumes snapshot and applies routing/fallback policy.
- Rationale: sidecar already bridges local runtime concerns and can publish shared state for WSL/host setups.
- Alternatives considered:
  - server directly querying LS quota (rejected for first iteration due to host/runtime boundary complexity).

### 4. Deterministic fallback chains by mode
- Decision: define ordered candidate chains and threshold-based gating:
  - fast: flash-first chain,
  - plan: deep-reasoning-first chain.
- Rationale: deterministic policy is debuggable and testable.
- Alternatives considered:
  - dynamic scoring model only (rejected: higher complexity, harder to validate quickly).

### 5. Observability-first response metadata
- Decision: include selected model and fallback rationale in textual output/logs without changing MCP protocol shape.
- Rationale: preserves compatibility while making behavior auditable.

## Risks / Trade-offs

- [Cascade ID correlation may fail in some UI states] -> Mitigation: retain LS polling + DOM fallback and keep extraction path unchanged.
- [Quota snapshot may become stale] -> Mitigation: include timestamp and freshness threshold; ignore stale data and use default chain.
- [Model selector DOM drift] -> Mitigation: layered selector strategy and safe no-op fallback to current default model.
- [Increased complexity in ask flow] -> Mitigation: isolate logic into dedicated modules (`wait-state`, `quota-policy`, `quota-snapshot`).

## Migration Plan

1. Add artifact-level docs (`design/specs/tasks`) and implement behind backward-compatible inputs.
2. Extend sidecar registry payload with `quota` snapshot while preserving existing fields.
3. Add MCP server modules for quota parsing, model routing, and LS wait state.
4. Integrate into `ask-antigravity` path with feature-safe fallbacks.
5. Run unit tests and build; verify unchanged behavior for `prompt`-only calls.
6. Rollback path: disable LS wait/quota usage via internal guards, preserving legacy DOM-only behavior.

## Open Questions

- Exact LS event fields used to identify terminal stream states may vary by Antigravity version; first implementation should treat unknown payloads as non-terminal and rely on fallback.
- Final model names exposed in UI may differ from internal aliases; mapping table will need periodic maintenance.
