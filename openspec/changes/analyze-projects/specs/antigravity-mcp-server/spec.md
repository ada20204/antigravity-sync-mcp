> Status: Historical (superseded)
> Superseded on 2026-03-01 by the current baseline in `openspec/project.md` and `openspec/config.yaml`.
> This spec contains legacy assumptions (for example scanning `7800-7850`) and is not authoritative for current behavior.

## ADDED Requirements

### Requirement: MCP Server Protocol
The system SHALL act as a Model Context Protocol server, offering standard stdio or HTTP transport layers. 
The system SHALL surface the `@modelcontextprotocol/sdk` capabilities: Tools and Logging.

#### Scenario: Server Start
- **WHEN** the user executes `npx antigravity-mcp-server`
- **THEN** the system prints init logs, connects via a `StdioServerTransport`, and begins listening for MCP Client handshakes.

### Requirement: CDP Discovery
The system SHALL poll default ports (e.g. `7800-7850`) to find `http://127.0.0.1:<port>/json/list`.
The system SHALL identify active Antigravity "workbench.html" sessions.

#### Scenario: Missing CDP Target
- **WHEN** the server receives a task but no Antigravity instance is running with `--remote-debugging-port=7800`
- **THEN** the task fails immediately returning "Error: CDP not found. Ensure Antigravity is running with debug ports."

### Requirement: Tool `ask-antigravity`
The system SHALL expose the tool `ask-antigravity`, which accepts a `prompt` (string) argument.

#### Scenario: Single Task Delegation
- **WHEN** an external Agent calls `ask-antigravity` with `{prompt: "Refactor index.ts to use ES6 modules"}`
- **THEN** the system injects the text into Antigravity's chat box and simulates the `return` key execution.

### Requirement: Real-time Progress Monitoring
The system SHALL monitor the Antigravity chat DOM for execution state (e.g., checking for the 'Cancel' or 'Stop Generating' button).
The system SHALL periodically send `sendProgressNotification` to keep the delegating MCP client alive and updated on progress.

#### Scenario: Long-Running Antigravity Task
- **WHEN** Antigravity takes 2 minutes to generate a massive refactor
- **THEN** the system sends periodic progress updates ("Antigravity is still generating code...") every `KEEPALIVE_INTERVAL`.
- **AND WHEN** the generation completes
- **THEN** the system parses the final generated chat bubble and returns the text results back as the Tool's output content array.

### Requirement: Tool `antigravity-stop`
The system SHALL expose the tool `antigravity-stop` via the MCP interface to halt immediately any running AI operations in the Antigravity sub-agent.

#### Scenario: User Halts External Agent
- **WHEN** the external agent (like Cursor) is asked by the user to cancel the parent task, causing `antigravity-stop` to be invoked
- **THEN** the system finds the 'Cancel' button in Antigravity's chat interface via CDP evaluate, clicks it, and confirms it stopped.
