## Context

Sidecar currently uses a fixed `antigravityLaunchPort` (default 9000) for all Antigravity windows. When launching via `executeManualLaunch()`, it calls `buildLaunchArgsForWorkspace(workspacePath, selectedPort, extraArgs)` where `selectedPort = cdpFixedPort > 0 ? cdpFixedPort : antigravityLaunchPort`. This means:

1. **First window**: Binds to port 9000 successfully
2. **Second window**: Either fails to bind (no CDP), or Electron/Chromium reuses the existing debugger (both windows share port 9000)
3. **Registry entries**: Both workspaces report `local_endpoint.port: 9000`
4. **Server routing**: Per-workspace task map works correctly, but CDP connections always reach the same window

Additionally, `DEFAULT_CDP_PORT_SPEC = '9000-9014,8997-9003,9229,7800-7850'` expands to 70 ports:
- `9000-9014`: 15 ports (core range)
- `8997-9003`: 4 ports after deduplication (8997-8999 redundant)
- `9229`: 1 port (Node.js inspector, not Antigravity CDP)
- `7800-7850`: 51 ports (73% of total, unknown origin, no known use case)

Worst-case probe time: 70 ports × 2 hosts × 250ms = 35 seconds.

Current flow:
```
User opens window 2 → sidecar calls executeManualLaunch()
  → selectedPort = antigravityLaunchPort (9000)
  → buildLaunchArgsForWorkspace(path, 9000, extraArgs)
  → launchAntigravityDetached with --remote-debugging-port=9000
  → Port conflict → shared CDP or no CDP
```

## Goals / Non-Goals

**Goals:**
- Each Antigravity window gets a unique CDP port from `9000-9014` range
- Registry entries accurately reflect each window's actual CDP port
- Multi-window routing works correctly (server can reach the intended window)
- Reduce CDP probe time by 79% (35s → 7.5s worst case)
- Backward compatible — single-window users see no behavior change
- No registry schema changes

**Non-Goals:**
- Server-side changes (server already supports per-workspace routing)
- Cross-platform CDP port discovery beyond current probe logic
- Dynamic port range expansion beyond 15 ports (sufficient for 15 concurrent windows)
- Automatic port conflict resolution for user-specified `cdpFixedPort` (if user sets fixed port, respect it)

## Decisions

### Decision 1: Dynamic port allocation strategy

**Chosen**: Scan registry before launch, allocate next available port from `9000-9014`.

Implementation:
```javascript
function allocateFreeCdpPort(registry, portRange = [9000, 9014]) {
  const occupiedPorts = new Set();

  // Scan registry for occupied ports
  for (const [key, entry] of Object.entries(registry)) {
    if (key.startsWith('__')) continue;
    const port = entry?.local_endpoint?.port;
    if (Number.isFinite(port)) occupiedPorts.add(port);
  }

  // Find first available port in range
  for (let port = portRange[0]; port <= portRange[1]; port++) {
    if (!occupiedPorts.has(port)) return port;
  }

  // Fallback: return first port (will conflict, but at least deterministic)
  return portRange[0];
}
```

Called in `executeManualLaunch()`:
```javascript
const registry = readRegistryObject() || {};
const allocatedPort = cdpFixedPort > 0
  ? cdpFixedPort
  : allocateFreeCdpPort(registry, [9000, 9014]);
const launchArgs = buildLaunchArgsForWorkspace(workspacePath, allocatedPort, extraArgs);
```

**Alternatives considered**:
- **Random port selection**: Less predictable, harder to debug. Rejected.
- **Increment from last used port**: Requires persistent state. Rejected for simplicity.
- **OS-assigned ephemeral port**: Chromium `--remote-debugging-port=0` assigns random port, but we can't discover it reliably. Rejected.

**Trade-offs**:
- Registry read adds ~1ms overhead per launch (acceptable)
- Port exhaustion after 15 windows → fallback to port 9000 (conflict, but rare)
- Race condition if two windows launch simultaneously → both might pick same port (mitigated by launch being user-initiated, not automated)

### Decision 2: Shrink CDP probe range

**Chosen**: Change `DEFAULT_CDP_PORT_SPEC` from `'9000-9014,8997-9003,9229,7800-7850'` to `'9000-9014'`.

Rationale:
- `9000-9014`: Core range, matches allocation range, keep
- `8997-8999`: No known use case, remove
- `9229`: Node.js inspector default, not Antigravity CDP, remove
- `7800-7850`: 51 ports (73% of probe time), unknown origin, remove

Impact:
- Probe time: 70 → 15 ports (79% reduction)
- Worst case: 35s → 7.5s (2 hosts × 15 ports × 250ms)
- Users with custom port needs can override via `cdpPortCandidates` config

**Alternatives considered**:
- **Keep wide range for compatibility**: No evidence of usage outside 9000-9014. Rejected.
- **Make range configurable per-workspace**: Over-engineering. Rejected.

### Decision 3: No probe logic changes

**Chosen**: Keep existing `buildCdpProbePlan()` and `findCdpTarget()` unchanged.

Rationale:
- Probe logic already handles multiple ports correctly
- Shrinking the range is sufficient to fix performance
- No need to add window-title matching or other heuristics (allocation ensures uniqueness)

**Alternatives considered**:
- **Add title-based verification**: Probe could check `/json/list` title matches workspace name. Adds complexity, not needed if allocation works. Rejected for now (can add later if needed).

### Decision 4: Config migration

**Chosen**: No migration needed. Existing `antigravityLaunchPort` config remains valid.

Behavior:
- If user has `antigravityLaunchPort: 9000` (default) → dynamic allocation kicks in
- If user has `antigravityLaunchPort: 9005` (custom) → dynamic allocation still scans registry, but starts from 9005 if available
- If user has `cdpFixedPort: 9010` → always use 9010 (no dynamic allocation, existing behavior)

Config precedence (unchanged):
```
cdpFixedPort > allocateFreeCdpPort(registry, [9000, 9014])
```

## Risks / Trade-offs

**Port exhaustion after 15 windows** → Fallback to port 9000 causes conflict. Mitigation: Log warning when all ports occupied. Users opening >15 windows are rare; they can configure wider range via `cdpPortCandidates`.

**Race condition on simultaneous launch** → Two windows launched at exact same time might pick same port. Mitigation: Launch is user-initiated (manual or command), not automated. Probability is low. If it happens, second window will fail to bind or share CDP (same as current behavior).

**Registry read latency** → Adds ~1ms per launch. Mitigation: Acceptable overhead, launch is infrequent.

**Backward compatibility** → Existing single-window setups continue to use port 9000 (first available). No behavior change for them.

**Probe range shrink breaks custom setups** → Users with Antigravity on non-standard ports (e.g., 7800) will need to configure `cdpPortCandidates`. Mitigation: Document in changelog. Unlikely scenario (no evidence of usage outside 9000-9014).

## Migration Plan

1. **Code changes** (sidecar only):
   - Add `allocateFreeCdpPort(registry, portRange)` helper function
   - Update `executeManualLaunch()` to call `allocateFreeCdpPort()` before `buildLaunchArgsForWorkspace()`
   - Change `DEFAULT_CDP_PORT_SPEC` constant from `'9000-9014,8997-9003,9229,7800-7850'` to `'9000-9014'`

2. **Testing**:
   - Unit test: `allocateFreeCdpPort()` with various registry states (empty, 1 occupied, all occupied)
   - Integration test: Launch 3 Antigravity windows, verify registry has 3 unique ports
   - Regression test: Single-window launch still uses port 9000

3. **Deployment**:
   - Package sidecar VSIX with changes
   - Install in Antigravity
   - No registry migration needed (schema unchanged)

4. **Rollback**:
   - Revert to previous sidecar VSIX
   - Existing registry entries remain valid (port field is always present)

5. **Monitoring**:
   - Log allocated port in `executeManualLaunch()`: `Launching with allocated port=${allocatedPort}`
   - Log warning if all ports occupied: `All CDP ports (9000-9014) occupied, falling back to 9000`

## Open Questions

**OQ-1: Should we add title-based verification in probe logic?**

After allocation, probe could verify `/json/list` title contains workspace name. This would catch cases where allocation failed (race condition) or user manually launched with conflicting port.

Pros: Extra safety layer, catches edge cases
Cons: Adds complexity, title matching is heuristic (workspace name may not appear in title)

**Decision**: Defer to post-launch. Allocation alone should be sufficient. Can add verification later if conflicts are observed in practice.

**OQ-2: Should we support port ranges wider than 9000-9014?**

Current design hardcodes `[9000, 9014]` in allocation logic. Users needing >15 windows could configure `cdpPortCandidates` to wider range, but allocation wouldn't use it.

Pros: Supports power users with many windows
Cons: Adds complexity (parse `cdpPortSpec` to extract range)

**Decision**: Defer. 15 windows is sufficient for 99% of users. If demand exists, can make allocation range configurable later (read from `cdpPortCandidates` or new `cdpAllocationRange` config).

**OQ-3: Should we persist last-used port to avoid reusing recently closed ports?**

If user closes window on port 9001 and immediately opens new window, allocation might reuse 9001 before OS releases it.

Pros: Avoids transient bind failures
Cons: Requires persistent state, adds complexity

**Decision**: No. OS releases ports quickly (< 1s). User launch cadence is slow enough that this is not a practical issue. If bind fails, user can retry.
