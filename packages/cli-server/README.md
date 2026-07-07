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

## Global install (decoupled from the repo checkout)

```bash
npm --workspace packages/cli-server run install:global
```

Copies the build output plus the MCP SDK to `~/.config/antigravity-mcp/cli-server/`
and generates a launcher at `~/.config/antigravity-mcp/bin/antigravity-mcp-cli`
(Unix only). Register it globally with:

```json
{
  "mcpServers": {
    "antigravity-cli": {
      "command": "~/.config/antigravity-mcp/bin/antigravity-mcp-cli",
      "args": []
    }
  }
}
```

No env needed: the `agy` binary is resolved at runtime via `AGY_BIN` / PATH /
`~/.local/bin`. Re-run the script after a rebuild to refresh the installed copy.

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
- **Permissions auto-approved**: every run passes `--dangerously-skip-permissions`.
  agy's file-write/shell tools require interactive permission approval, and print
  mode has no approver — without the flag they fail **silently** (exit 1, no
  output, nothing written to disk), which surfaces as "done but nothing happened".
  The flip side: agy can edit files and run shell commands unattended, so scope
  runs with `workDir` and verify its changes yourself. Note that `done`/process
  exit still only means the process ended, not that the task semantically
  completed.
- **Non-zero exits kill the run (agy bug, mitigated by plugin)**: in print mode,
  a shell command exiting non-zero silently aborts agy's whole agent loop (agy
  exits 0, stdout truncates, remaining steps are dropped) — test-red phases and
  expected-failure probes die mid-flight. Commands wrapped as `<cmd> || true`
  survive. Install the bundled `exit-code-guard` plugin (below) to enforce that
  wrapping deterministically.
- **Silent quota exhaustion**: when the selected model's quota is exhausted, agy
  exits 0 with empty output; the 429 RESOURCE_EXHAUSTED error goes only to
  `~/.gemini/antigravity-cli/cli.log`. The wrapper's empty-output error mentions
  this; models in the other quota group (Gemini vs Claude/GPT) keep working.
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

## agy plugin: exit-code-guard (recommended)

Bundled under `agy-plugin/exit-code-guard/`; `install:global` registers it
automatically, or install manually:

```bash
agy plugin install packages/cli-server/agy-plugin/exit-code-guard
```

A `PreToolUse` hook that denies any `run_command` not ending in `|| true`, with
a rewrite hint as the deny reason — the model resubmits the wrapped command and
the run survives failing commands (verified: an intentionally failing step no
longer kills the run; later steps complete). Cost: one extra deny/retry
round-trip per unwrapped command. Machine-level, applies to every agy run, not
just this MCP server. Remove with `agy plugin uninstall exit-code-guard`.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGY_BIN` | auto-resolve | Absolute path to the `agy` binary (falls back to PATH + `~/.local/bin`) |
