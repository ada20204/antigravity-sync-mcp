# Bundled antigravity-mcp-server runtime

This directory is a release artifact snapshot copied from `../antigravity-mcp-server/build/dist`.

Update process:
1. Build server: `npm --prefix antigravity-mcp-server run build`
2. Sync runtime:
   - `rm -rf antigravity-mcp-sidecar/server-runtime/dist`
   - `cp -r antigravity-mcp-server/build/dist antigravity-mcp-sidecar/server-runtime/dist`
3. Package sidecar VSIX.

The sidecar extension can launch this bundled runtime via a generated launcher script, so one VSIX can bootstrap MCP server usage.
