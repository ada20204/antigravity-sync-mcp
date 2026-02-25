## Why

The current `ask-antigravity` flow relies on CDP DOM polling to decide when generation is complete, which is fragile and can misjudge completion when the UI changes or pauses briefly. At the same time, model selection is static and not quota-aware, so requests can fail or degrade when a model is exhausted without automatic fallback.

## What Changes

- Add a hybrid wait-state engine that prioritizes LS-backed status (`StreamCascadeReactiveUpdates`, with `GetCascadeTrajectory` fallback) to determine completion more reliably.
- Keep CDP as the primary prompt submission path, so message injection behavior and current UI automation remain compatible.
- Add model selection strategy inputs (requested model and mode preferences) so routing decisions are explicit and reproducible.
- Add quota monitoring based on local LS `GetUserStatus` data and expose normalized quota snapshots to the MCP runtime.
- Add automatic model fallback when the selected model is exhausted or unavailable, using ordered fallback chains by mode.
- Add diagnostic visibility for selected model, fallback reason, and quota state used for each request.

## Capabilities

### New Capabilities
- `ls-wait-state-tracking`: Track generation lifecycle using LS reactive updates first, then trajectory polling as fallback, with DOM polling as last-resort safety.
- `quota-aware-model-selection`: Select and switch models using requested mode/model plus real-time quota and model availability signals.
- `sidecar-quota-snapshot`: Collect and publish normalized quota snapshots from local LS status for MCP policy decisions.

### Modified Capabilities
- _(none — no existing capability specs are currently present under `openspec/specs/`)_

## Impact

- Affected systems:
  - `antigravity-mcp-server` request lifecycle and waiting state machine
  - `antigravity-mcp-server` tool input schema and model routing policy
  - `antigravity-mcp-sidecar` registry/snapshot publishing for quota data
- Affected behavior:
  - More reliable completion detection for long-running asks
  - Reduced failures from quota exhaustion via automatic fallback
  - Better observability of model and quota decisions
- Dependencies and interfaces:
  - Local LS method integration (`GetUserStatus`, `GetCascadeTrajectory`, `StreamCascadeReactiveUpdates`)
  - Existing CDP send path remains the default prompt submission mechanism
