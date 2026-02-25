# antigravity-mcp-server

MCP server that bridges external AI agents (Claude Code, Cursor, etc.) to a local Antigravity instance via Chrome DevTools Protocol (CDP).

## Prerequisites

1. **Node.js 18+**
2. **Antigravity** running with debug port enabled:
   - Default: Antigravity typically exposes CDP on port `9000` (auto-detected)
   - Manual: `antigravity . --remote-debugging-port=7800`

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
| `ask-antigravity` | Send a prompt to Antigravity and wait for the AI response. Auto-accepts file changes and safe commands. |
| `antigravity-stop` | Stop the current AI generation in Antigravity. |
| `ping` | Test connectivity and check CDP availability. |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTIGRAVITY_CDP_PORT` | auto-detect | Override CDP port (skips port scanning) |

## How It Works

1. External agent calls `ask-antigravity` with a prompt
2. Server discovers Antigravity via CDP port scan (9000±3, then 7800-7850)
3. Connects via WebSocket and injects the prompt into the chat input
4. Polls for completion while auto-accepting confirmation dialogs
5. Extracts the final AI response and returns it to the calling agent

## Safety

The auto-accept pipeline includes a banned-command safety net. Commands matching these patterns will NOT be auto-executed:
- `rm -rf /`, `rm -rf ~`, `rm -rf *`
- `format c:`, `dd if=`, `mkfs.`
- Fork bombs, disk wipes, etc.
