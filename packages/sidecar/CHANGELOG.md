# Changelog

All notable changes to `antigravity-mcp-sidecar` are tracked in git history.

## [Unreleased]

- Fixed multi-window CDP port conflicts: each Antigravity window now gets a unique port from `9000-9014` range via dynamic allocation
- Reduced CDP probe time by 79% (35s → 7.5s worst case) by narrowing default port spec from 70 ports to 15 (`9000-9014`)

## [0.1.11]

- Sync package-lock with `package.json` dependencies to keep CI/npm workflows deterministic.
- Bundle server runtime aligned to `antigravity-mcp-server v0.1.2`.
- README/settings docs aligned with current quota and registry-control behavior.

## [0.1.10]

- Bundled MCP server runtime packaging
- CDP discovery and startup robustness improvements
- Quota snapshot display and `quota-status` integration support
- Host/remote runtime simplification for SSH-oriented workflows
