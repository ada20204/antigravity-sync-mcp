# antigravity-mcp-server

MCP server that bridges external AI agents (Claude Code, Cursor, etc.) to a local Antigravity instance via Chrome DevTools Protocol (CDP).

## Prerequisites

1. **Node.js 18+**
2. **Antigravity** running with debug port enabled, or allow cold-start auto launch (see Configuration)
3. **packages/sidecar** extension enabled in your active workspace (writes CDP/LS/quota registry)

## Quick Start

```bash
# Install workspace dependencies
npm install

# Build server package
npm --workspace packages/server run build

# Test connectivity
node packages/server/build/dist/index.js  # (runs as stdio MCP server)
```

## Single VSIX Option

If you install `packages/sidecar` VSIX, you can bootstrap this server without separate npm install:

1. In Antigravity command palette run: `Install Bundled MCP Server Launcher`
2. Use generated launcher:
   - Unix: `~/.config/antigravity-mcp/bin/antigravity-mcp-server`
   - Windows: `~/.config/antigravity-mcp/bin/antigravity-mcp-server.cmd`
3. Run sidecar command `Show AI MCP Config Prompt` to copy ready MCP config snippet.

## Register with MCP Client

### Claude Code
```bash
claude mcp add antigravity-mcp -- node /path/to/repo/packages/server/build/dist/index.js
```

### Claude Desktop / Cursor
Add to your MCP config:
```json
{
  "mcpServers": {
    "antigravity-mcp": {
      "command": "node",
      "args": ["/path/to/repo/packages/server/build/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ask-antigravity` | Send a prompt to Antigravity and wait for the AI response. Supports optional `mode` (`fast`/`plan`), `model`, and per-request `targetDir`; server applies quota-aware model fallback. |
| `antigravity-stop` | Stop the current AI generation in Antigravity. |
| `ping` | Test connectivity and check CDP availability. |
| `quota-status` | Query quota status for models/prompt credits. Prefers live LS query and falls back to registry snapshot; also prints policy recommendation preview for model routing. |
| `launch-antigravity` | Launch Antigravity in a new window with CDP flags and optionally wait for CDP readiness. |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTIGRAVITY_CDP_PORT` | auto-detect | Override CDP port (skips port scanning) |
| `ANTIGRAVITY_CDP_HOST` | auto-detect | Override CDP host (used with port overrides) |
| `ANTIGRAVITY_CDP_BIND_ADDRESS` | `127.0.0.1` | Bind address used when server cold-starts Antigravity with CDP flags |
| `ANTIGRAVITY_EXECUTABLE` | auto-detect | Absolute path to Antigravity executable for cold-start launch |
| `ANTIGRAVITY_LAUNCH_PORT` | `9000` | Port used when server cold-starts Antigravity |
| `ANTIGRAVITY_LAUNCH_EXTRA_ARGS` | empty | Extra args appended on cold-start launch |
| `ANTIGRAVITY_REGISTRY_FILE` | `~/.config/antigravity-mcp/registry.json` | Override registry file path used for discovery/control requests |

`ask-antigravity` input schema:
- `prompt` (required): prompt text
- `mode` (optional): `fast` or `plan`
- `model` (optional): preferred model (for example `gemini-3-flash`, `gemini-3-pro-high`, `opus-4.6`)
- `targetDir` (optional): workspace directory for this request

Target directory resolution order for `ask-antigravity`:
1. request `targetDir`
2. process `--target-dir`
3. `process.cwd()`

## How It Works

1. External agent calls `ask-antigravity` with a prompt
2. Server discovers target workspace via sidecar registry (`~/.config/antigravity-mcp/registry.json`)
3. If CDP is unavailable, server performs one cold-start launch attempt (`<targetDir> --new-window --remote-debugging-port=<port>`)
4. Server applies mode/model policy with quota-aware fallback (using registry quota snapshot when fresh)
5. Connects via WebSocket and injects the prompt through CDP (send path unchanged)
6. Waits for completion with LS-first strategy: reactive stream -> cascade trajectory -> DOM fallback
7. Extracts the final answer segment and returns it to the calling agent

When CDP is unavailable, server may also write `__control__.cdp_prompt_requests` into registry so sidecar can show deferred user guidance at connection time.

## Safety

The auto-accept pipeline includes a banned-command safety net. Commands matching these patterns will NOT be auto-executed:
- `rm -rf /`, `rm -rf ~`, `rm -rf *`
- `format c:`, `dd if=`, `mkfs.`
- Fork bombs, disk wipes, etc.
