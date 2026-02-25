## Why

I propose building "antigravity-mcp-server", a unified bridge that exposes Antigravity's capabilities to external AI Code Agents (like Cursor, Claude Code, or other MCP clients).

Currently, external AI agents cannot orchestrate tasks within the powerful Antigravity editor environment. By merging the Chrome DevTools Protocol (CDP) DOM interaction capabilities of `OmniAntigravityRemoteChat` with the Model Context Protocol (MCP) server architecture of `gemini-mcp-tool`, we can enable a "Agent-to-Agent" workflow where an external agent delegates complex coding, research, or execution tasks to Antigravity as a sub-agent.

This changes the paradigm from "Human prompting Antigravity" to "Agent prompting Antigravity via MCP", vastly expanding automation potential.

## What Changes

- **Introducing an MCP Server**: We will create a Node.js-based MCP Server (`antigravity-mcp-server`) that communicates over `stdio` or HTTP, adhering to the `@modelcontextprotocol/sdk`.
- **Exposing Antigravity Control Tools**: We will expose tools like `ask-antigravity`, `antigravity-status`, and `antigravity-stop` via the MCP protocol.
- **Integrating CDP Core**: We will port the core `discoverAllCDP()`, `injectMessage()`, and DOM-polling logic from `OmniAntigravityRemoteChat` to orchestrate real-time interactions with the local Antigravity window.
- **Handling Long-running Operations**: We will implement the `startProgressUpdates` keepalive mechanism from `gemini-mcp-tool` to prevent MCP clients from timing out while Antigravity generates long responses or intricate code changes.

## Capabilities

### New Capabilities
- `antigravity-mcp-server`: The core MCP server daemon that bridges MCP requests over stdio to CDP interactions.
- `mcp-tools-definition`: The suite of specific Model Context Protocol tools to remote control the Antigravity instance (prompting, managing tasks, and retrieving state).
- `cdp-automation-engine`: The ported logic that handles headless CDP connections to Antigravity, including robust parsing of chat DOM strings to extract generated code/results.

### Modified Capabilities

## Impact

The introduction of `antigravity-mcp-server` will:
- Establish a standard interface for external code assistants to command Antigravity as a specialized sub-agent.
- Enable massive composability (e.g., Cursor asking Antigravity to build a new feature inside the context-rich Antigravity environment).
- Require a robust error handling layer bridging two asynchronous protocols (MCP and CDP) over potentially long timescales (minutes per task).
