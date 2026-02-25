# Antigravity MCP Sidecar

All-in-one companion extension for Antigravity (Cursor fork).

## Features

- **Auto-Accept**: Automatically clicks Run, Accept, Always Allow buttons in the agent panel
- **MCP Registry**: Registers current workspace CDP port for external MCP server routing
- **Status Bar Toggle**: One-click enable/disable from the status bar

## How It Works

### Auto-Accept (Two Channels)
1. **Native Commands (500ms)**: Fires `antigravity.agent.acceptAgentStep` and related commands
2. **CDP Webview Injection (1500ms)**: Injects click scripts into the isolated agent panel via Chrome DevTools Protocol

### MCP Registry
Writes workspace path + CDP port to `~/.antigravity-mcp/registry.json` so external MCP servers can target the correct Antigravity window.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravityMcpSidecar.enabled` | `true` | Enable/disable auto-accept |
| `antigravityMcpSidecar.nativePollInterval` | `500` | Native command polling interval (ms) |
| `antigravityMcpSidecar.cdpPollInterval` | `1500` | CDP webview polling interval (ms) |

## Requirements

Antigravity must be launched with a debug port enabled (e.g. `--remote-debugging-port=9222`).

## Usage

1. Install the extension
2. Open a workspace in Antigravity
3. The status bar shows: `⚡ Sidecar: ON` / `🔴 Sidecar: OFF` / `⚠ Sidecar: No CDP`
4. Click the status bar item to toggle auto-accept on/off
5. View logs: Output panel → "Antigravity MCP Sidecar"
