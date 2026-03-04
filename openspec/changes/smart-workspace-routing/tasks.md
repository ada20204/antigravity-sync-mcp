## 1. cdp.ts — Discovery types and error codes

- [ ] 1.1 Add `matchMode: "exact" | "auto_fallback"` field to `DiscoveredCDP` type
- [ ] 1.2 Add `workspaceKey: string` field to `DiscoveredCDP` type
- [ ] 1.3 Add `no_workspace_ever_opened` to the error code union type
- [ ] 1.4 Replace `registry_missing` + empty-entries path with `no_workspace_ever_opened` detection logic (registry absent OR zero non-`__control__` entries)

## 2. cdp.ts — Fallback discovery logic

- [ ] 2.1 After exact `workspace_id` match fails, fall back to `rankRegistryEntries` over all schema-compatible entries
- [ ] 2.2 Set `matchMode: "exact"` when workspace_id matched; `"auto_fallback"` when fallback used
- [ ] 2.3 Set `workspaceKey` from `matched.workspace_id` ?? `matched.original_workspace_id` ?? `"${ip}:${port}"` (env-override path)
- [ ] 2.4 Log `matchMode` and `workspaceKey` at INFO level on every successful discovery

## 3. index.ts — Per-workspace task map

- [ ] 3.1 Replace `let activeAskTask: AskTask | null` with `const activeAskTasks = new Map<string, AskTask>()`
- [ ] 3.2 In `handleAskAntigravity`: gate concurrency per `workspaceKey` (reject if non-terminal task exists for same key)
- [ ] 3.3 In `handleAskAntigravity`: register task in `activeAskTasks` before connect; remove in `finally` block
- [ ] 3.4 Update error message for "already running" to include `workspaceKey` and active task id

## 4. index.ts — no_workspace_ever_opened handling

- [ ] 4.1 In `handleAskAntigravity` cold-start guard: detect `no_workspace_ever_opened` error code and skip `launchAntigravityForWorkspace`
- [ ] 4.2 Return human-readable message: instruct user to open Antigravity, open their workspace folder, and complete first-time authorization before retrying

## 5. index.ts — antigravity-stop multi-workspace

- [ ] 5.1 Add optional `targetDir` parameter to `antigravity-stop` tool schema
- [ ] 5.2 In `handleStop`: if 0 active tasks → return "Nothing is running"
- [ ] 5.3 In `handleStop`: if 1 active task and no `targetDir` → stop it (existing behavior)
- [ ] 5.4 In `handleStop`: if multiple active tasks and no `targetDir` → return error listing active workspace keys
- [ ] 5.5 In `handleStop`: if `targetDir` provided → require exact `workspace_id` match (no fallback); return error if no exact match found without stopping any task
- [ ] 5.6 In `handleStop`: if exact match found → cancel matching task only

## 6. index.ts — list-workspaces tool

- [ ] 6.1 Add `list-workspaces` to `TOOLS` array with schema (no required params)
- [ ] 6.2 Implement `handleListWorkspaces`: read registry, filter schema-compatible entries, return structured list
- [ ] 6.3 Include per-entry fields: `workspacePath`, `workspaceId`, `state`, `port`, `role`, `verifiedAt`, `quotaSummary` (if quota present)
- [ ] 6.4 Return empty-list message when registry has no workspace entries
- [ ] 6.5 Wire `list-workspaces` into tool dispatch switch

## 7. Tests

- [ ] 7.1 Add test: `discoverCDPDetailed` with mismatched targetDir falls back to ready entry (`matchMode: "auto_fallback"`)
- [ ] 7.2 Add test: `discoverCDPDetailed` with no targetDir selects best ready entry (`matchMode: "auto_fallback"`)
- [ ] 7.3 Add test: `discoverCDPDetailed` with exact match sets `matchMode: "exact"`
- [ ] 7.4 Add test: empty registry returns `no_workspace_ever_opened` (not `registry_missing`)
- [ ] 7.5 Add test: missing registry file returns `no_workspace_ever_opened`
- [ ] 7.6 Add test: two concurrent `ask-antigravity` calls on different workspaceKeys both proceed
- [ ] 7.7 Add test: `antigravity-stop` with multiple active tasks and no targetDir returns error with workspace list
- [ ] 7.8 Add test: `antigravity-stop` with mismatched targetDir returns error without stopping any task
- [ ] 7.9 Add test: `list-workspaces` returns entries without opening any CDP/WebSocket connection
- [ ] 7.10 Add test: `no_workspace_ever_opened` error message does not suggest or attempt auto-launch

## 8. Tool descriptions

- [ ] 8.1 Update `ask-antigravity` tool description: `targetDir` is optional routing hint (not required exact match); mention fallback behavior and `list-workspaces` for explicit routing
- [ ] 8.2 Update `antigravity-stop` tool description: document optional `targetDir`, exact-match requirement, and multi-workspace ambiguity error
- [ ] 8.3 Update `ping` tool description: note it will show `matchMode` in diagnostics output

## 9. Build and sync

- [ ] 9.1 Run `npm --prefix antigravity-mcp-server run build` and confirm zero errors
- [ ] 9.2 Run `node --test antigravity-mcp-server/test/*.mjs` and confirm all tests pass
- [ ] 9.3 Run `node antigravity-mcp-sidecar/scripts/sync-server-runtime.mjs` to sync built dist into sidecar bundle
- [ ] 9.4 Run sidecar syntax checks: `node -c antigravity-mcp-sidecar/src/extension.js`
