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

### CDP Port Discovery & WSL Support (The Sidecar Architecture)
- **Problem**: Port scanning is brittle and slow. In WSL setups, port scanning completely fails because the Windows host (where the UI runs) and WSL (where the MCP server runs) have different network interfaces and 127.0.0.1 loopbacks.
- **Solution (antigravity-mcp-sidecar)**: We built a dedicated VS Code companion extension (`antigravity-mcp-sidecar`). By running natively inside the Antigravity extension host:
  1. It handles the auto-accept looping far more efficiently (combining native `vscode.commands` and CDP webview clicks).
  2. It dynamically reads its own CDP debug port and explicitly detects the Windows host IP (via `/etc/resolv.conf` nameserver) if running in WSL.
  3. It writes the `[Workspace Path] -> {port, ip}` mapping to a flat JSON file at `~/.antigravity-mcp/registry.json`.
- **MCP Server Discovery**: The `antigravity-mcp-server` simply reads `registry.json`. It looks up the target directory and instantly gets the exact IP and port to connect to. No scanning required.

### MCP Transport
- We'll use `@modelcontextprotocol/sdk` to construct the `Server` object over `StdioServerTransport` (same as gemini-mcp-tool).
- We'll use `ws` for the WebSocket connection over CDP.

### Execution Lifecycle Engine
- To prevent timeout on external MCP Clients (which assume tools return within ~60s), we will utilize `sendProgressNotification` (from gemini-mcp-tool) inside a `setInterval()` loop at `KEEPALIVE_INTERVAL` (25 seconds).
- The loop will poll Antigravity via CDP `Runtime.evaluate` to check:
  1. **Is generation active?** — Look for the Cancel/Stop button (`[data-tooltip-id="input-send-button-cancel-tooltip"]`).
  2. **Are there blocking confirmation dialogs?** — Look for accept-class buttons using the selectors from `auto-accept-agent` (`.bg-ide-button-background` for Antigravity, text matching `['accept', 'run', 'apply', 'execute', 'confirm', 'allow']`). Auto-click them with banned-command safety checks intact.

### Auto-Accept Pipeline (Delegated to Sidecar)
- The initial plan was to run auto-accept inside the MCP server via CDP DOM clicks.
- **Revised Run-Time Decision**: To improve reliability and reduce coupling on the MCP server, the entire Auto-Accept pipeline (native commands + CDP webview clicks for Always Allow) was migrated into `antigravity-mcp-sidecar` directly. 
- The external MCP Server only focuses on prompt injection (`ask-antigravity`), progress polling, and result extraction.

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
