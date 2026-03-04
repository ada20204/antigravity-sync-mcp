## Why

Multiple Antigravity windows currently share the same CDP port (9000), causing registry entries for different workspaces to report identical ports. This breaks multi-window routing — server-side per-workspace task isolation works correctly, but CDP connections always reach the same window. Additionally, the default CDP probe range includes 70 ports (73% of which are unused), causing unnecessary 35s worst-case probe delays.

## What Changes

- **Dynamic CDP port allocation**: Sidecar reads registry to find occupied ports and allocates the next available port from `9000-9014` when launching Antigravity, instead of hardcoding `--remote-debugging-port=9000`.
- **Shrink CDP probe range**: Reduce `DEFAULT_CDP_PORT_SPEC` from `9000-9014,8997-9003,9229,7800-7850` (70 ports) to `9000-9014` (15 ports), removing unused ranges `7800-7850` (51 ports), `9229` (Node.js inspector), and redundant `8997-8999`.
- **Registry port accuracy**: Each workspace entry in registry will report its actual unique CDP port, enabling correct multi-window routing.

## Capabilities

### New Capabilities
- `dynamic-cdp-port-allocation`: Sidecar allocates unique CDP ports per Antigravity window from a configurable range, reading registry to avoid conflicts and ensuring each workspace gets a distinct debugger endpoint.

### Modified Capabilities
_(none — this is a sidecar-only fix; no existing spec-level requirements change)_

## Impact

**Sidecar (`antigravity-mcp-sidecar/src/extension.js`)**:
- `DEFAULT_CDP_PORT_SPEC` constant: change from `9000-9014,8997-9003,9229,7800-7850` to `9000-9014`
- `antigravityLaunchPort` resolution: replace fixed default with dynamic allocation logic
- `buildLaunchArgsForWorkspace()`: accept dynamic port parameter instead of reading global config
- New helper function: `allocateFreeCdpPort(registry, portRange)` to scan registry and return next available port

**Server**: No changes required — server already supports per-workspace routing via `workspaceKey`.

**Registry schema**: No changes — existing `local_endpoint.port` field will now contain accurate per-window values.

**User impact**:
- Multi-window scenarios will work correctly (currently broken)
- CDP probe time reduced from worst-case 35s to 7.5s (79% faster)
- Backward compatible — single-window users see no behavior change
