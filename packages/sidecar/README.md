# Antigravity MCP Sidecar

All-in-one companion extension for Antigravity.

## Features

- **Auto-Accept**: Automatically clicks Run, Accept, Always Allow buttons in the agent panel
- **CDP Negotiation Registry**: Publishes negotiated CDP endpoint/state for external MCP server routing
- **Bundled MCP Server Runtime**: VSIX ships with the server runtime in `packages/sidecar/server-runtime/dist` so one VSIX can bootstrap server usage
- **Manual Launch Controls**: Commands to launch/restart Antigravity (restart requires confirmation)
- **Cross-End Restart Control**: Remote sidecar can submit signed host restart requests; host side confirms via modal before restart
- **Structured Logging**: Writes JSONL logs with role/node/trace metadata to `~/.config/antigravity-mcp/logs/`
- **Status Bar Toggle**: One-click enable/disable from the status bar

## How It Works

### Launch and Restart Architecture

**Server (MCP):**
- Checks if Antigravity is running using CDP discovery
- For cold-start (not running): spawns `restart-worker.js` with `--cold-start` flag
- For restart requests: delegates to `restart-worker.js` without `--cold-start`
- Returns immediately with worker PID and port info

**Worker (`scripts/restart-worker.js`):**
- Runs as detached process, independent of server/sidecar lifecycle
- **Cold-start mode** (`--cold-start`): skip kill/wait, directly launch + verify CDP
- **Restart mode** (default): kill → wait → launch → verify CDP
- **Wait-exit mode** (`--wait-exit`): skip active kill, wait for Antigravity to exit on its own; sidecar calls `closeAndQuit` to trigger graceful exit, worker waits by PID (resolved via `lsof` on the CDP port)
- **Clear-auth mode** (`--clear-auth --db-path`): after process exits, deletes auth keys from SQLite DB before launching (used by Add Another Account)
- Writes status to `~/.config/antigravity-mcp/restart-status.json`
- Writes final result to `~/.config/antigravity-mcp/restart-result.json`
- Logs to `~/.config/antigravity-mcp/restart-worker.log`

**Account commands (Switch / Add Another Account / Restart):**
- All use wait-exit mode to avoid killing sidecar (which runs inside Antigravity)
- Sidecar triggers `closeAndQuit`, worker waits for the process to exit by PID, then launches a fresh instance

### Auto-Accept (Two Channels)
1. **Native Commands (500ms)**: Fires `antigravity.agent.acceptAgentStep` and related commands
2. **CDP Webview Injection (1500ms)**: Injects click scripts into the isolated agent panel via Chrome DevTools Protocol

### MCP Registry
Writes workspace state to `~/.config/antigravity-mcp/registry.json`:
- legacy fields: `ip`, `port`
- negotiated fields: `schema_version`, `protocol`, `last_error`, `cdp.state`, `cdp.active`, `cdp.probeSummary`, `cdp.lastError`
- quota fields: `quota`, `quotaError`
- control-plane fields: `__control__.restart_requests.*` (signed request/approval records)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravityMcpSidecar.enabled` | `true` | Enable/disable auto-accept |
| `antigravityMcpSidecar.nativePollInterval` | `500` | Native command polling interval (ms) |
| `antigravityMcpSidecar.cdpPollInterval` | `1500` | CDP webview polling interval (ms) |
| `antigravityMcpSidecar.cdpFixedHost` | `""` | Optional fixed CDP host override |
| `antigravityMcpSidecar.cdpFixedPort` | `0` | Optional fixed CDP port override (`0` = auto). When set, only this port is probed |
| `antigravityMcpSidecar.cdpPortCandidates` | `9000-9014` | Candidate ports for CDP negotiation |
| `antigravityMcpSidecar.antigravityExecutablePath` | `""` | Optional explicit Antigravity executable path |
| `antigravityMcpSidecar.antigravityLaunchPort` | `9000` | Preferred launch port when no fixed CDP port is set; sidecar scans `9000-9014` if unavailable |
| `antigravityMcpSidecar.antigravityLaunchExtraArgs` | `""` | Extra launch args appended when starting app |
| `antigravityMcpSidecar.bridgeSharedToken` | `""` | Optional shared auth token for sidecar control plane (auto-managed if empty) |
| `antigravityMcpSidecar.bridgeMaxSkewMs` | `120000` | Max allowed timestamp skew for signed control requests |
| `antigravityMcpSidecar.bridgeRequestTtlMs` | `300000` | Auto-expire pending control requests after this age |
| `antigravityMcpSidecar.quotaWarnThresholdPercent` | `15` | Warning threshold (%) for quota status styling |
| `antigravityMcpSidecar.quotaCriticalThresholdPercent` | `5` | Critical threshold (%) for quota status styling |
| `antigravityMcpSidecar.quotaAlertCooldownMinutes` | `30` | Cooldown between repeated quota-level transitions |
| `antigravityMcpSidecar.quotaStaleMinutes` | `3` | Mark quota snapshot as stale after this many minutes |

## Commands

- `Toggle Antigravity Sidecar Auto-Accept`
- `Show Antigravity Quota Snapshot`
- `Show Antigravity Model Quota Table`
- `Refresh Antigravity Quota Snapshot`
- `Launch Antigravity (New Window)`
- `Restart Antigravity (Confirm)`
- `Request Host Restart (Remote)`
- `Sidecar: Switch Account`
- `Sidecar: Add Another Account`
- `Sidecar: Account Status`
- `Sidecar: Delete Saved Account`
- `Install Bundled MCP Server Launcher`
- `Show AI MCP Config Prompt`

`Request Host Restart (Remote)` currently requires an external host-bridge transport; if not configured, the command shows guidance only.

## One VSIX Deployment

After installing sidecar VSIX:

1. Run command: `Install Bundled MCP Server Launcher`
2. Sidecar generates launchers:
   - `~/.config/antigravity-mcp/bin/antigravity-mcp-server`
   - `~/.config/antigravity-mcp/bin/antigravity-mcp-server.cmd`
3. Sidecar prints and copies AI configuration prompt to clipboard.

This lets you configure MCP clients without separately installing the `packages/server` package.

## AI Config Prompt (Template)

Use command `Show AI MCP Config Prompt` to output and copy a ready-to-use snippet.

Linux/macOS MCP client example:

```json
{
  "mcpServers": {
    "antigravity-mcp": {
      "command": "~/.config/antigravity-mcp/bin/antigravity-mcp-server",
      "args": ["--target-dir", "/path/to/your/workspace"]
    }
  }
}
```

Windows recommendation (avoid extra cmd window popup):

```json
{
  "mcpServers": {
    "antigravity-mcp": {
      "command": "node",
      "args": [
        "c:\\Users\\<you>\\.antigravity\\extensions\\antigravity.antigravity-mcp-sidecar-<version>\\server-runtime\\dist\\index.js",
        "--target-dir",
        "c:\\path\\to\\workspace"
      ]
    }
  }
}
```

If your MCP client requires shell-style invocation on Windows, this compatibility form also works:

```json
{
  "mcpServers": {
    "antigravity-mcp": {
      "command": "cmd",
      "args": [
        "/c",
        "node",
        "c:\\Users\\<you>\\.antigravity\\extensions\\antigravity.antigravity-mcp-sidecar-<version>\\server-runtime\\dist\\index.js"
      ]
    }
  }
}
```

## Requirements

Antigravity should run with debug port enabled, typically:

`--remote-debugging-port=9000 --remote-debugging-address=127.0.0.1`

## Usage

1. Install the extension
2. Open a workspace in Antigravity
3. The status bar shows: `⚡ Sidecar: ON` / `🔴 Sidecar: OFF` / `⚠ Sidecar: No CDP`
4. Click the status bar item to toggle auto-accept on/off
5. Use command palette for launch/restart and quota tools
6. View logs: Output panel → "Antigravity MCP Sidecar"

## SSH Remote Setup

The sidecar supports SSH remote workflows where Antigravity runs on the host machine and the MCP server runs on a remote (SSH) machine.

### How it works

- **Host sidecar** (runs inside Antigravity on your local machine): starts a bridge HTTP server on `127.0.0.1:18900`
- **Remote sidecar** (runs inside code-server on the remote machine): polls the host bridge every 3s and mirrors the host registry entry locally
- **MCP server** (on the remote): reads the mirrored local registry entry and connects to CDP via the forwarded port

The role is detected automatically: when VS Code is connected to a remote (`vscode.env.remoteName` is non-empty), the sidecar activates as `remote`. On the local desktop it activates as `host`.

### Setup steps

1. **Install the sidecar on both sides** — install the VSIX in Antigravity (host) and in code-server (remote)

2. **Start Antigravity with CDP enabled** on the host:
   ```
   --remote-debugging-port=9000 --remote-debugging-address=127.0.0.1
   ```

3. **Configure port forwarding** in Antigravity so the remote can reach:
   - `127.0.0.1:18900` — host bridge (sidecar-to-sidecar snapshot sync)
   - `127.0.0.1:9000` — host CDP (MCP server → Antigravity)

4. **Share the bridge token** — host and remote must use the same HMAC token.

   **Option A** (recommended): set the same value in VS Code settings on both sides:
   ```json
   "antigravityMcpSidecar.bridgeSharedToken": "your-shared-secret"
   ```

   **Option B**: copy the auto-generated token file from host to remote:
   ```bash
   scp host:~/.config/antigravity-mcp/bridge.token ~/.config/antigravity-mcp/bridge.token
   ```

5. **Install the MCP server launcher** on the remote — run command `Install Bundled MCP Server Launcher` in code-server

6. **Configure your MCP client** on the remote with `--target-dir` pointing to your remote workspace

### Diagnostics

- Remote sidecar logs bridge poll results to Output → "Antigravity MCP Sidecar"
- If `bridgeSharedToken` is not configured, a warning is logged at startup
- When CDP discovery fails in SSH context, the MCP server returns `hint_code: ssh_host_antigravity_not_reachable_yet` with actionable guidance

### Settings (SSH-specific)

| Setting | Default | Description |
|---------|---------|-------------|
| `antigravityMcpSidecar.bridgeSharedToken` | `""` | Shared HMAC token — must match on host and remote |
| `antigravityMcpSidecar.bridgeHostEndpoint` | `127.0.0.1:18900` | Host bridge endpoint as seen from the remote (override if forwarded to a different port) |

