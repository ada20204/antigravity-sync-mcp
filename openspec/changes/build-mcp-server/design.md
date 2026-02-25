## Context

External AI agents (like Claude Code, Cursor) operate through the Model Context Protocol (MCP) to interact with external systems. To automate massive codebase refactors or specialized debugging tasks inside Antigravity's rich development environment, those agents need an MCP server that speaks "Antigravity".

This proposes to build `antigravity-mcp-server` using TypeScript, a CDP-over-WebSocket bridge based on the successes of:
- **`OmniAntigravityRemoteChat`** — CDP DOM interaction (discovery, connection, script injection)
- **`gemini-mcp-tool`** — MCP stdio streaming, Tool exposure, progress keepalive
- **`auto-accept-agent`** — Automatic approval of Antigravity confirmation dialogs via CDP DOM clicking

## Goals / Non-Goals

**Goals:**
- Provide a headless, lightweight CLI (`npx antigravity-mcp-server`) that an external MCP client can spawn.
- Expose `ask-antigravity`: Inject prompts over CDP into a local Antigravity window.
- Expose `antigravity-stop`: Halt any running AI operation.
- Implement robust progress polling: Detect when generation finishes by polling DOM for the "Stop/Cancel" button state.
- **Auto-accept intermediate confirmations**: Automatically click "Accept", "Run Command", "Apply" buttons that Antigravity presents during code generation, using ported logic from `auto-accept-agent`. This is essential — without it, Antigravity will block waiting for human input and the MCP call will hang forever.
- Capture and return the resulting text from the final AI response back to the MCP Client.

**Non-Goals:**
- Supporting multiple simultaneous Antigravity window generations (currently scoped to single-window for simplicity).
- Developing a custom UI server. This is purely a backend bridging daemon. No `express` needed.
- Intercepting deeply embedded Antigravity system logs — we stick to DOM/Evaluate-based interaction.
- Using VSCode Extension API commands (`vscode.commands.executeCommand`) — our MCP server runs as a standalone Node process, not a VSCode extension, so the Extension Command approach used by `auto-accept-agent` is unavailable to us.

## Decisions

### CDP Port Discovery
- **Default port**: `9000 ± 3` (range `8997-9003`). This is the default debug port used by Antigravity internally, as confirmed by `auto-accept-agent`'s `cdp-handler.js` (`BASE_PORT = 9000`).
- **Fallback ports**: `7800-7850`. These are non-default ports that require the user to launch Antigravity with `--remote-debugging-port=7800` (as documented in `OmniAntigravityRemoteChat`).
- Discovery order: Try `8997-9003` first, then `7800-7850` if nothing found.

### MCP Transport
- We'll use `@modelcontextprotocol/sdk` to construct the `Server` object over `StdioServerTransport` (same as gemini-mcp-tool).
- We'll use `ws` for the WebSocket connection over CDP.

### Execution Lifecycle Engine
- To prevent timeout on external MCP Clients (which assume tools return within ~60s), we will utilize `sendProgressNotification` (from gemini-mcp-tool) inside a `setInterval()` loop at `KEEPALIVE_INTERVAL` (25 seconds).
- The loop will poll Antigravity via CDP `Runtime.evaluate` to check:
  1. **Is generation active?** — Look for the Cancel/Stop button (`[data-tooltip-id="input-send-button-cancel-tooltip"]`).
  2. **Are there blocking confirmation dialogs?** — Look for accept-class buttons using the selectors from `auto-accept-agent` (`.bg-ide-button-background` for Antigravity, text matching `['accept', 'run', 'apply', 'execute', 'confirm', 'allow']`). Auto-click them with banned-command safety checks intact.

### Auto-Accept Pipeline (CDP DOM Track Only)
- We can **only** use the CDP DOM approach (find buttons in DOM, dispatch click events).
- We **cannot** use the Extension Command approach (`antigravity.agent.acceptAgentStep` etc.) because our server is a standalone Node process, not a VSCode extension.
- We port the `isAcceptButton()`, `performClick()`, and `isCommandBanned()` logic from `auto-accept-agent/extension/main_scripts/modules/03_clicking.js`.
- Default banned command list: `['rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /']`.

### Result Parsing Strategy (⚠️ Requires Reverse Engineering)
- Once generation finishes, a final CDP Evaluate call will extract the text content of the last AI response.
- **IMPORTANT**: Neither `OmniAntigravityRemoteChat` nor `auto-accept-agent` implement response text extraction. Omni mirrors the entire HTML; Auto-Accept only clicks buttons. The actual DOM structure of Antigravity's chat bubbles (class names, nesting) is **unknown** and must be reverse-engineered against a live Antigravity instance.
- Implementation approach: Use CDP `Runtime.evaluate` with a discovery script (e.g., find the last child inside `#conversation` that looks like an assistant message), then iteratively refine the selector.

## Risks / Trade-offs

- **DOM Fragility**: Relying on DOM selectors is inherently fragile. If Antigravity changes its UI structure, the MCP server will fail. Trade-off: This is the fastest way to build integration without requiring an official Antigravity API.
- **MCP Timeout Limitations**: Although `sendProgressNotification` helps keep connections alive, some strictly configured MCP clients might still hard-timeout after 3-5 minutes. We must document that external agents shouldn't ask Antigravity to do 10-minute tasks in a single prompt.
- **Port Discovery Brittleness**: Antigravity's default debug port (9000) is not officially documented and could change. We mitigate by supporting a configurable `ANTIGRAVITY_CDP_PORT` environment variable.
- **Auto-Accept Safety**: Automatically clicking "Run Command" buttons could execute dangerous operations. We mitigate with the banned-command detection logic ported from `auto-accept-agent`, but users should be warned that this tool enables autonomous code execution.
- **Response Extraction is Uncharted**: No reference project has implemented chat text extraction from Antigravity's DOM. This is the highest-risk task and may require significant trial-and-error.
