# Bundled antigravity-mcp-server runtime

This directory is a release artifact snapshot copied from `../packages/server/build/dist`.

Update process:
1. Build server: `npm --prefix packages/server run build`
2. Sync runtime:
   - `rm -rf antigravity-mcp-sidecar/server-runtime/dist`
   - `cp -r packages/server/build/dist antigravity-mcp-sidecar/server-runtime/dist`
3. Package sidecar VSIX.

The sidecar extension can launch this bundled runtime via a generated launcher script, so one VSIX can bootstrap MCP server usage.
