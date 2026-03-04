## Context

The MCP server discovers its Antigravity target by computing a `workspace_id` (SHA-256 of normalized path, first 16 hex chars) from `--target-dir` and looking it up in `~/.config/antigravity-mcp/registry.json`. This creates two failure modes:

1. **Path mismatch**: `--target-dir` must be configured per-project in `.claude.json`; any path difference causes `workspace_not_found`.
2. **Global singleton**: `activeAskTask` serializes all `ask-antigravity` calls globally, blocking parallel use of multiple Antigravity windows.
3. **Bad cold-start**: When registry has no entries (Antigravity never opened a workspace), server attempts cold-start auto-launch which bypasses first-time authorization flow, silently fails or opens wrong workspace.

All changes are server-side only. Sidecar, registry schema, and control-plane remain untouched.

## Goals / Non-Goals

**Goals:**
- `--target-dir` becomes an optional routing hint, not a required exact-match key
- Multiple Antigravity windows can handle `ask-antigravity` concurrently
- Empty/missing registry returns a human-readable onboarding message instead of triggering cold-start
- New `list-workspaces` tool exposes available workspaces to callers
- Full backward compatibility — existing configs and callers work without changes

**Non-Goals:**
- Sidecar changes of any kind
- Registry writes from server
- Remote (SSH/WSL) topology changes
- Automatic Antigravity launch on first use (deliberately excluded — auth flow requires human)

## Decisions

### Decision 1: Fallback discovery order

When `targetDir` is provided but produces no registry match, server falls back to `rankRegistryEntries()` across all entries rather than hard-failing.

Fallback priority (existing `rankRegistryEntries` logic):
1. `state === "ready"` entries first
2. Fresh `verified_at` within `ttl_ms`
3. `role === "host"` preferred over remote
4. `priority` field as tiebreaker

Alternatives considered:
- **Hard-fail always**: Current behavior. Forces per-project config, poor DX.
- **Ignore targetDir entirely**: Loses explicit routing for multi-window case.

Chosen: soft-match — try exact first, fall back to ranked auto-select, report `matchMode` in diagnostics.

`discoverCDPDetailed` gains a `matchMode` field on success response: `"exact"` | `"auto_fallback"`.

### Decision 2: `no_workspace_ever_opened` error code

Detect "never opened" as: registry file missing OR registry has zero non-`__control__` entries.

In this case:
- Emit new error code `no_workspace_ever_opened`
- **Suppress cold-start entirely** — do not call `launchAntigravityForWorkspace`
- Return message: `"No Antigravity workspace is open. Please open your project in Antigravity and complete first-time authorization, then retry."`

Alternatives considered:
- **Proceed with cold-start using `process.cwd()`**: Unreliable cwd in MCP server process; bypasses auth flow.
- **Prompt for path interactively**: MCP stdio transport doesn't support interactive input.

### Decision 3: Per-workspace task map

Replace:
```ts
let activeAskTask: AskTask | null = null;
```
With:
```ts
const activeAskTasks = new Map<string, AskTask>();
```

`workspaceKey` = `matched.workspace_id ?? matched.original_workspace_id ?? "${ip}:${port}"` (stable identifier added to `DiscoveredCDP`).

Concurrency rules:
- Same `workspaceKey`: one task at a time (prevent concurrent DOM injection into same window)
- Different `workspaceKey`: parallel allowed

`antigravity-stop` without `targetDir`:
- 0 active tasks → "Nothing is running"
- 1 active task → stop it (unchanged behavior)
- 2+ active tasks → error: "Multiple workspaces active, specify targetDir"

### Decision 4: `list-workspaces` tool

Reads registry synchronously, filters to schema-compatible entries, returns structured list. Does not attempt CDP connection — registry data only.

Fields per entry: `workspacePath`, `workspaceId`, `state`, `port`, `role`, `verifiedAt`, `quotaSummary` (model count + prompt remaining if present).

No new dependencies required.

## Risks / Trade-offs

**Auto-fallback selects wrong window** → Mitigated: `matchMode: "auto_fallback"` is logged and returned in diagnostics; callers can detect and pass explicit `targetDir` next time. Single-window users are unaffected.

**Parallel tasks on different windows share CDP connection pool** → Each `ask-antigravity` call opens and closes its own CDP WebSocket; no shared state between tasks. No risk.

**`no_workspace_ever_opened` suppresses cold-start permanently** → Only suppressed when registry is truly empty. Once user opens a workspace, registry gets an entry and normal flow resumes.

**`workspaceKey` falls back to `ip:port`** → Only for env-override path (`ANTIGRAVITY_CDP_PORT`). In normal registry path, `workspace_id` is always present. Low risk.

## Migration Plan

1. Build and test server locally (`npm run build` + `node --test`)
2. Sync built dist to sidecar: `antigravity-mcp-sidecar/scripts/sync-server-runtime.mjs`
3. No registry schema changes — no migration required
4. Existing `--target-dir` configs continue to work (exact match still tried first)
5. Rollback: revert to previous bundled server runtime in sidecar

## Open Questions

_(none — scope is fully defined)_
