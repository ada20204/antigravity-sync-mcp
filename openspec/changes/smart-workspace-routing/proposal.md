## Why

The current server requires `--target-dir` to exactly match the workspace path registered by the sidecar, causing frequent `workspace_not_found` failures when the CLI arg is wrong or absent. Additionally, `activeAskTask` is a global singleton that serializes all requests across all Antigravity windows, and cold-start auto-launch silently fails when the user hasn't completed first-time authorization in Antigravity.

## What Changes

- **Workspace discovery fallback**: When `--target-dir` produces no registry match, server falls back to auto-selecting the best `ready` entry from registry instead of hard-failing.
- **Per-workspace task isolation**: Replace global `activeAskTask` singleton with a `Map<workspaceKey, AskTask>` so tasks targeting different workspaces run in parallel.
- **No-workspace guidance**: When registry is empty or missing (Antigravity never opened a workspace), skip cold-start and return a clear human-readable prompt asking the user to manually open Antigravity and complete first-time authorization.
- **`list-workspaces` tool**: New MCP tool that returns all schema-compatible workspace entries from registry (including non-ready states) with their paths, state, port, and quota summaries, enabling callers to inspect and route explicitly.

## Capabilities

### New Capabilities

- `workspace-auto-discovery`: Fallback discovery logic — when targetDir produces no match, server ranks all ready registry entries and selects the best one, with `matchMode` reported in diagnostics.
- `multi-workspace-routing`: Per-workspace task map replacing the global singleton; `antigravity-stop` gains optional `targetDir` to stop a specific window; ambiguous stop (multiple active, no targetDir) returns an actionable error.
- `no-workspace-guidance`: Distinct `no_workspace_ever_opened` error code emitted when registry is absent or has zero entries; cold-start suppressed in this path; error message instructs user to open the workspace manually.
- `list-workspaces`: New MCP tool (`list-workspaces`) that reads registry and returns all schema-compatible workspace entries with their state, path, port, and quota summary — enabling callers to see both ready and non-ready workspaces.

### Modified Capabilities

_(none — no existing spec-level requirement is being removed or tightened)_

## Impact

- **`antigravity-mcp-server/src/cdp.ts`**: `discoverCDPDetailed` gains fallback path and new `no_workspace_ever_opened` error code; `DiscoveredCDP` gains `workspaceKey` field.
- **`antigravity-mcp-server/src/index.ts`**: `activeAskTask` replaced with `activeAskTasks` Map; `handleStop` gains `targetDir`; new `handleListWorkspaces` handler; tool definitions updated.
- **MCP tool schema**: `antigravity-stop` gains optional `targetDir`; new `list-workspaces` tool added. No breaking changes to existing callers.
- **No new registry writes**: This change introduces no new registry write paths. Existing `upsertNoCdpPromptRequest` writes (control-plane `cdp_prompt_requests`) are pre-existing behavior and outside this change's scope. Sidecar is unchanged.
