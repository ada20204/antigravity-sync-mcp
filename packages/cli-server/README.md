# @antigravity-mcp/cli-server

Standalone MCP server that drives the **Antigravity CLI (`agy`)** directly — no
IDE/CDP needed. Independent from the CDP server (`packages/server`); the two only
share this monorepo.

## Prerequisites

- Node.js 18+
- `agy` installed and already logged in (run `agy` once in a terminal to complete
  Google OAuth)

## Build & run

```bash
npm --workspace packages/cli-server run build
node packages/cli-server/build/dist/index.js   # runs as a stdio MCP server
```

## Register (project `.mcp.json`)

```json
{
  "mcpServers": {
    "antigravity-cli": {
      "command": "node",
      "args": ["packages/cli-server/build/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `ask-antigravity-cli` | Synchronous: send a prompt to `agy -p`, block until done, return the reply. Params: `prompt` (required), `model`, `workDir`, `changeMode`, `timeoutMs`. |
| `start-antigravity-task` | Asynchronous: start a long task, return a `runId` immediately (non-blocking). |
| `poll-antigravity-task` | Poll a task by `runId`: rolling output tail while running, full result once finished. |
| `cancel-antigravity-task` | Cancel a task by `runId` (kills the agy process group). |
| `list-antigravity-tasks` | List running + recent finished tasks (LRU-bounded). |
| `list-antigravity-models` | List usable model names live (`agy models`) — pass these to `model`. |

### No quota data (agy limitation)

There is no quota tool here on purpose: `agy` exposes no quota command or cache
file (its internal `quota_manager` only surfaces in logs). If you also run the
CDP server against the IDE with the same account, its `quota-status` /
`list-antigravity-models` report the same account's quota. Revisit if a future
agy version adds a quota subcommand.

## Design

- **Subprocess + closed stdin**: runs `agy -p` as a plain subprocess with stdin
  closed (stdio `ignore` = EOF). With a clean end-of-input, agy prints its full
  reply to stdout and **self-exits on completion** — that process exit is a
  deterministic completion signal. No pseudo-terminal, no idle heuristic, no
  native dependencies. (Closing stdin is the key; the "non-TTY hangs / empty
  stdout" symptom was just a missing stdin EOF.)
- **Serialized**: `agy` is not concurrency-safe (it rewrites shared
  `~/.gemini/antigravity-cli` index files), so all runs go through a global mutex —
  concurrent calls queue rather than race.
- **Process cleanup**: spawned detached; on cancel/timeout, SIGKILL the whole
  process group (agy may fork children).
- **`changeMode`**: wraps the prompt to return structured `OLD/NEW` edit blocks.
- **`sandbox`**: **refused** — `agy --sandbox` is a no-op in `-p` mode (no
  filesystem/network isolation), so passing it returns an error rather than a
  false sense of security.
- **`model`**: passed through as `agy --model`. Must be an exact name from
  `list-antigravity-models` (e.g. `"Gemini 3.1 Pro (High)"`); agy **silently
  ignores** unknown names and falls back to the active CLI model. Omit to use
  the active CLI model.
- **`workDir`**: passed through as `agy --add-dir`, adding the directory to agy's
  workspace so the run is scoped to it.
- Output is capped at 10 MB; the result's `truncated` flag is set if exceeded.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGY_BIN` | auto-resolve | Absolute path to the `agy` binary (falls back to PATH + `~/.local/bin`) |
