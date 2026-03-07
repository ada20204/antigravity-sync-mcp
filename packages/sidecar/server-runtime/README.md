# Bundled antigravity-mcp-server runtime

This directory is the VSIX runtime payload staged by `../scripts/sync-server-runtime.mjs`.

In the monorepo layout, sync copies these inputs into the packageable sidecar tree:
- `packages/server/build/dist` -> `packages/sidecar/server-runtime/dist`
- `packages/core/dist` -> `packages/sidecar/server-runtime/node_modules/@antigravity-mcp/core/dist`
- `packages/core/package.json` -> `packages/sidecar/server-runtime/node_modules/@antigravity-mcp/core/package.json`
- Hoisted runtime deps from workspace `node_modules` -> `packages/sidecar/server-runtime/node_modules`

Update process:
1. Build core: `npm --prefix packages/core run build`
2. Build server: `npm --prefix packages/server run build`
3. Sync runtime: `npm --prefix packages/sidecar run sync-server-runtime`
4. Package sidecar VSIX.

The sidecar extension can launch this bundled runtime via a generated launcher script, so one VSIX can bootstrap MCP server usage.
