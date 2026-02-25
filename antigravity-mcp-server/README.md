# antigravity-mcp-server

MCP server that bridges external AI agents (Claude Code, Cursor, etc.) to a local Antigravity instance via Chrome DevTools Protocol (CDP).

## Prerequisites

1. **Node.js 18+**
2. **Antigravity** running with debug port enabled:
   - `--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0`
3. **antigravity-mcp-sidecar** extension enabled in your active workspace (writes CDP/LS/quota registry)

## Quick Start

```bash
# Build
cd antigravity-mcp-server
npm install
npm run build

# Test connectivity
node dist/index.js  # (runs as stdio MCP server)
```

## Register with MCP Client

### Claude Code
```bash
claude mcp add antigravity-mcp -- node /path/to/antigravity-mcp-server/dist/index.js
```

### Claude Desktop / Cursor
Add to your MCP config:
```json
{
  "mcpServers": {
    "antigravity-mcp": {
      "command": "node",
      "args": ["/path/to/antigravity-mcp-server/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ask-antigravity` | Send a prompt to Antigravity and wait for the AI response. Supports optional `mode` (`fast`/`plan`) and `model`; server applies quota-aware model fallback. |
| `antigravity-stop` | Stop the current AI generation in Antigravity. |
| `ping` | Test connectivity and check CDP availability. |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTIGRAVITY_CDP_PORT` | auto-detect | Override CDP port (skips port scanning) |

`ask-antigravity` input schema:
- `prompt` (required): prompt text
- `mode` (optional): `fast` or `plan`
- `model` (optional): preferred model (for example `gemini-3-flash`, `gemini-3-pro-high`, `opus-4.6`)

## How It Works

1. External agent calls `ask-antigravity` with a prompt
2. Server discovers target workspace via sidecar registry (`~/.antigravity-mcp/registry.json`)
3. Server applies mode/model policy with quota-aware fallback (using registry quota snapshot when fresh)
4. Connects via WebSocket and injects the prompt through CDP (send path unchanged)
5. Waits for completion with LS-first strategy: reactive stream -> cascade trajectory -> DOM fallback
6. Extracts the final answer segment and returns it to the calling agent

## Safety

The auto-accept pipeline includes a banned-command safety net. Commands matching these patterns will NOT be auto-executed:
- `rm -rf /`, `rm -rf ~`, `rm -rf *`
- `format c:`, `dd if=`, `mkfs.`
- Fork bombs, disk wipes, etc.
