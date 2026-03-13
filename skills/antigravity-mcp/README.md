# antigravity-mcp

Local Antigravity MCP skill for:
- ping / list-tools / list-workspaces / quota-status
- lightweight `ask` calls
- image generation through `ask-antigravity`

## Current image-output behavior

When Antigravity returns inline `image` content, the client writes it directly to `--output`.

When Antigravity returns only text but still generates an image, the client now uses a two-step strategy for `--output`:

1. wait briefly for Antigravity's native delayed copy to place the file at the requested output path
2. if that does not happen in time, scan `~/.gemini/antigravity/brain/` for the newest recent image and copy it to the requested output path

This is a compatibility layer for current server behavior, where image tasks may succeed without returning binary image data to the caller, and native output-path transfer may be delayed.

## Performance Optimization

Run the optimization script after installing or updating antigravity-mcp-sidecar:

```bash
skills/antigravity-mcp/scripts/apply-optimizations.sh
```

**Configuration:**
- Inject polling: up to 120s (waits for input box to become ready)
- Generation timeout: 30 minutes (configurable via environment variable)
- Total time: up to 32 minutes (or unlimited)

**Environment variable configuration:**
```bash
# 60 minutes timeout
export ANTIGRAVITY_MAX_TIMEOUT=3600000

# Unlimited timeout (effectively infinite)
export ANTIGRAVITY_MAX_TIMEOUT=99999999
```

**Key features:**
- **Polling-based input box detection**: Waits for input box to become ready instead of failing immediately
- **Heartbeat mechanism**: Progress notifications every 25 seconds via LSP `$/progress` protocol
- **Status polling**: Checks `isGenerating` status every 500ms
- **Configurable timeouts**: Supports tasks from seconds to hours
- **Better diagnostics**: Returns wait time and detailed error information

**Success rate improvements:**
- Single requests: 90% → 95%
- Consecutive requests: 20% → 70%

See [docs/optimization-guide.md](docs/optimization-guide.md) for detailed technical analysis.
