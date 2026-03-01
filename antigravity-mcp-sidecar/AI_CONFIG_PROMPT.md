# Antigravity MCP AI Config Prompt

Use this with your AI client setup flow:

1. Ensure sidecar command `Install Bundled MCP Server Launcher` has been run at least once.
2. Use launcher path in MCP config.

Example config (Linux/macOS / WSL MCP client):

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

Windows recommendation (avoid extra cmd window popups):

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

Recommended instruction to AI:
- Prefer tool `ask-antigravity` for delegated coding tasks.
- Use `mode=fast` for quick iteration, `mode=plan` for deep tasks.
- If server returns `registry_not_ready`, guide user to open/restart Antigravity with sidecar enabled.
