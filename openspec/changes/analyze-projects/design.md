## Context

External AI agents (like Claude Code, Cursor) operate through the Model Context Protocol (MCP) to interact with external systems. To automate massive codebase refactors or specialized debugging tasks inside Antigravity's rich development environment, those agents need an MCP server that speaks "Antigravity". 

This proposes to build `antigravity-mcp-server` using TypeScript, an Express/ws/CDP hybrid based on the successes of `OmniAntigravityRemoteChat` (which handles the CDP DOM interaction) and `gemini-mcp-tool` (which handles the MCP `stdio` streaming and Tool exposure).

## Goals / Non-Goals

**Goals:**
- Provide a headless, lightweight CLI (`npx antigravity-mcp-server`) that an external MCP client can spawn.
- Expose `ask-antigravity`: Inject prompts over CDP into a local Antigravity window.
- Implement robust progress polling: Detect when generation finishes (e.g. by polling DOM for the "Submit" vs "Stop" buttons).
- Capture and return the resulting text from the final AI bubble back to the MCP Client.

**Non-Goals:**
- Supporting multiple simultaneous Antigravity window generations (currently scope to single-window for simplicity).
- Developing a custom UI server. This is purely a backend bridging daemon.
- Intercepting deeply embedded Antigravity system logs—we will stick to DOM/Evaluate-based interaction for simplicity.

## Decisions

- **Foundation Frameworks**: 
  - We'll use `@modelcontextprotocol/sdk` to construct the `Server` object over `StdioServerTransport` (same as gemini-mcp-tool).
  - We'll use `ws` for the WebSocket connection over CDP to Antigravity's debug port `7800` (porting code from Omni).
- **Execution Lifecycle Engine**: 
  - To prevent timeout on external MCP Clients (which assume tools return within ~60s), we will utilize `sendProgressNotification` (from gemini-mcp-tool) inside a `setInterval()` loop.
  - The loop will poll Antigravity via CDP `Runtime.evaluate` to see if the generation has stopped (e.g., checking if the 'input-send-button-cancel-tooltip' is visible).
- **Result Parsing Strategy**:
  - Once generation finishes, a final CDP Evaluate call will query `document.querySelectorAll('.bubble')` (or similar chat classes) to scrape the `innerHTML/innerText` of the latest assistant output, parsing out code blocks.

## Risks / Trade-offs

- **DOM Fragility**: Relying on DOM selectors (e.g., `document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]')`) is inherently fragile. If Antigravity changes its UI structure, the MCP server will fail. Trade-off: This is the fastest way to build integration without requiring an official Antigravity API.
- **MCP Timeout Limitations**: Although `sendProgressNotification` helps keep connections alive, some strictly configured MCP clients might still hard-timeout after 3-5 minutes. We must document that external agents shouldn't ask Antigravity to do 10-minute tasks in a single prompt.
- **Port Clashes**: Antigravity might spawn on ports `7800-7850`. The daemon will attempt port discovery incrementally until it finds a valid `workbench.html` WebSocket target.
