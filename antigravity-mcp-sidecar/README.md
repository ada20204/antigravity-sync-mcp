# Antigravity MCP Sidecar

All-in-one companion extension for Antigravity (Cursor fork).

## Features

- **Auto-Accept**: Automatically clicks Run, Accept, Always Allow buttons in the agent panel
- **CDP Negotiation Registry**: Publishes negotiated CDP endpoint/state for external MCP server routing
- **Manual Launch Controls**: Commands to launch/restart Antigravity (restart requires confirmation)
- **Status Bar Toggle**: One-click enable/disable from the status bar

## How It Works

### Auto-Accept (Two Channels)
1. **Native Commands (500ms)**: Fires `antigravity.agent.acceptAgentStep` and related commands
2. **CDP Webview Injection (1500ms)**: Injects click scripts into the isolated agent panel via Chrome DevTools Protocol

### MCP Registry
Writes workspace state to `~/.antigravity-mcp/registry.json`:
- legacy fields: `ip`, `port`
- negotiated fields: `cdp.state`, `cdp.active`, `cdp.probeSummary`, `cdp.lastError`
- quota fields: `quota`, `quotaError`

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravityMcpSidecar.enabled` | `true` | Enable/disable auto-accept |
| `antigravityMcpSidecar.nativePollInterval` | `500` | Native command polling interval (ms) |
| `antigravityMcpSidecar.cdpPollInterval` | `1500` | CDP webview polling interval (ms) |
| `antigravityMcpSidecar.cdpFixedHost` | `""` | Optional fixed CDP host override |
| `antigravityMcpSidecar.cdpFixedPort` | `0` | Optional fixed CDP port override (`0` = auto) |
| `antigravityMcpSidecar.cdpPortCandidates` | `9222,9229,9000-9014,8997-9003,7800-7850` | Candidate ports for negotiation |
| `antigravityMcpSidecar.antigravityExecutablePath` | `""` | Optional explicit Antigravity executable path |
| `antigravityMcpSidecar.antigravityLaunchPort` | `9000` | Launch port when no fixed CDP port is set |
| `antigravityMcpSidecar.antigravityLaunchExtraArgs` | `""` | Extra launch args appended when starting app |

## Commands

- `Toggle Antigravity Sidecar Auto-Accept`
- `Show Antigravity Quota Snapshot`
- `Show Antigravity Model Quota Table`
- `Refresh Antigravity Quota Snapshot`
- `Launch Antigravity (New Window)`
- `Restart Antigravity (Confirm)`

## Requirements

Antigravity should run with debug port enabled, typically:

`--remote-debugging-port=9000 --remote-debugging-address=0.0.0.0`

## Usage

1. Install the extension
2. Open a workspace in Antigravity
3. The status bar shows: `⚡ Sidecar: ON` / `🔴 Sidecar: OFF` / `⚠ Sidecar: No CDP`
4. Click the status bar item to toggle auto-accept on/off
5. Use command palette for launch/restart and quota tools
6. View logs: Output panel → "Antigravity MCP Sidecar"
