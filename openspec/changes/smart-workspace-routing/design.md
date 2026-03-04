## Context

The MCP server discovers its Antigravity target by computing a `workspace_id` (SHA-256 of normalized path, first 16 hex chars) from `--target-dir` and looking it up in `~/.config/antigravity-mcp/registry.json`. This creates two failure modes:

1. **Path mismatch**: `--target-dir` must be configured per-project in `.claude.json`; any path difference causes `workspace_not_found`.
2. **Global singleton**: `activeAskTask` serializes all `ask-antigravity` calls globally, blocking parallel use of multiple Antigravity windows.
3. **Bad cold-start**: When registry has no entries (Antigravity never opened a workspace), server attempts cold-start auto-launch which bypasses first-time authorization flow, silently fails or opens wrong workspace.

All changes are server-side only. Sidecar, registry schema, and control-plane remain untouched.

4. **Shared CDP port**: Sidecar launches all Antigravity windows with `--remote-debugging-port=9000` (fixed default). When multiple windows are open, they share the same CDP port — the second window either fails to bind or piggybacks on the first. This means registry entries for different workspaces all report `port: 9000`, and CDP connections always reach the same window regardless of `targetDir` routing.
5. **Bloated CDP probe range**: Default `cdpPortCandidates` is `9000-9014,8997-9003,9229,7800-7850` — 70 unique ports. The `7800-7850` range (51 ports, 73% of total) has no known use case. `9229` is Node.js inspector, not Antigravity CDP. `8997-8999` overlaps with the primary range. Worst-case probe time: 70 × 2 hosts × 250ms = 35s.

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

**Multi-window routing is broken by shared CDP port (CONFIRMED)** → Real-world testing with two Antigravity windows showed both registry entries report `port: 9000`. Server-side per-workspace task map works correctly in isolation, but CDP connections always reach the same window. This is a sidecar-side issue — see Open Questions.

## Migration Plan

1. Build and test server locally (`npm run build` + `node --test`)
2. Sync built dist to sidecar: `antigravity-mcp-sidecar/scripts/sync-server-runtime.mjs`
3. No registry schema changes — no migration required
4. Existing `--target-dir` configs continue to work (exact match still tried first)
5. Rollback: revert to previous bundled server runtime in sidecar

## Open Questions

### OQ-1: Sidecar 多窗口 CDP 端口冲突 (BLOCKING for multi-workspace)

**现象**: 两个 Antigravity 窗口同时打开时，registry 中两个 workspace 条目都报告 `port: 9000`。Server 端的 per-workspace task map 逻辑正确，但 CDP 连接始终到达同一个窗口。

**根因分析**:

1. **Sidecar 启动端口固定**: `antigravityLaunchPort` 默认 `9000`，所有窗口都用 `--remote-debugging-port=9000` 启动。
2. **Sidecar 探测逻辑无法区分窗口**: `findCdpTarget` 扫描端口范围找到第一个可用的 CDP endpoint 就返回，不验证该 endpoint 属于哪个窗口。
3. **Electron/Chromium 行为**: 第二个窗口用相同端口启动时，要么端口绑定失败（无 CDP），要么复用已有 debugger（两个窗口共享同一个 CDP 端口）。

**修复方向**: Sidecar 需要为每个窗口动态分配不同的 CDP 端口。

方案 A — **Sidecar 启动时自动递增端口**:
- 读取 registry 中已占用的端口，从 `9000-9014` 中选下一个空闲端口
- 优点：简单，无需改 Antigravity 本身
- 缺点：需要 sidecar 感知其他窗口的端口占用

方案 B — **Sidecar 探测时通过 CDP title/url 匹配窗口**:
- 探测到 CDP endpoint 后，检查 `/json/list` 返回的 `title` 是否包含当前 workspace 名称
- 优点：不需要改启动逻辑
- 缺点：title 匹配不可靠，Antigravity 可能不在 title 中包含 workspace 路径

方案 C — **组合方案（推荐）**:
- 启动时动态分配端口（方案 A）
- 探测时用 title 做二次验证（方案 B）
- Registry 中记录每个窗口的实际 CDP 端口

**影响范围**: 仅 sidecar 端（`extension.js`），server 端无需改动。

### OQ-2: cdpPortCandidates 范围过宽

**现状**: `DEFAULT_CDP_PORT_SPEC = '9000-9014,8997-9003,9229,7800-7850'` — 展开后 70 个端口。

**分析**:

| 范围 | 端口数 | 来源 | 结论 |
|------|--------|------|------|
| `9000-9014` | 15 | Antigravity 默认 CDP 端口 | **保留** — 核心范围，支持最多 15 个并发窗口 |
| `8997-9003` | 4 (去重) | 早期兼容？ | **移除** — 8997-8999 无实际用途，9000-9003 已在主范围内 |
| `9229` | 1 | Node.js inspector 默认端口 | **移除** — CDP ≠ Node inspector，误匹配风险 |
| `7800-7850` | 51 | 来源不明 | **移除** — 占 73% 探测量，无已知用途 |

**建议**: 收窄为 `9000-9014`（15 个端口）。

- 探测量从 70 降到 15，减少 79%
- 最坏探测时间从 35s 降到 7.5s（2 hosts × 15 ports × 250ms）
- 15 个端口足够支持同时打开 15 个 Antigravity 窗口
- 如果用户有特殊需求，可通过 `cdpPortCandidates` 配置项自定义
