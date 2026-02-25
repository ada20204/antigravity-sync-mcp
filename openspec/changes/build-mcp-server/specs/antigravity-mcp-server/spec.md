## ADDED Requirements

### Requirement: MCP Server Protocol
The system SHALL act as a Model Context Protocol server, offering standard stdio transport.
The system SHALL surface the `@modelcontextprotocol/sdk` capabilities: Tools and Logging.

#### Scenario: Server Start
- **WHEN** the user executes `npx antigravity-mcp-server`
- **THEN** the system prints init logs, connects via a `StdioServerTransport`, and begins listening for MCP Client handshakes.

### Requirement: CDP Discovery
The system SHALL scan default ports `8997-9003` (Antigravity's internal default around port 9000) to find `http://127.0.0.1:<port>/json/list`.
The system SHALL fall back to scanning ports `7800-7850` (user-configured `--remote-debugging-port`).
The system SHALL identify active Antigravity "workbench.html" sessions.
The system SHALL support a `ANTIGRAVITY_CDP_PORT` environment variable to override port scanning.

#### Scenario: Missing CDP Target
- **WHEN** the server receives a task but no Antigravity instance is running with a debug port
- **THEN** the task fails immediately returning "Error: CDP not found. Ensure Antigravity is running with debug ports enabled."

### Requirement: Tool `ask-antigravity`
The system SHALL expose the tool `ask-antigravity`, which accepts a `prompt` (string) argument.

#### Scenario: Single Task Delegation
- **WHEN** an external Agent calls `ask-antigravity` with `{prompt: "Refactor index.ts to use ES6 modules"}`
- **THEN** the system discovers a CDP target, injects the text into Antigravity's chat input box, and simulates submission.

### Requirement: Real-time Progress Monitoring
The system SHALL monitor the Antigravity chat DOM for execution state (e.g., checking for the 'Cancel' or 'Stop Generating' button).
The system SHALL periodically send `sendProgressNotification` (every ~25 seconds) to keep the delegating MCP client alive and updated on progress.

#### Scenario: Long-Running Antigravity Task
- **WHEN** Antigravity takes 2 minutes to generate a massive refactor
- **THEN** the system sends periodic progress updates ("Antigravity is still generating code...") every `KEEPALIVE_INTERVAL`.
- **AND WHEN** the generation completes
- **THEN** the system extracts the final AI response text and returns it as the Tool's output content array.

### Requirement: Auto-Accept Integration
The system SHALL automatically detect and click confirmation buttons (Accept, Run Command, Apply, Execute, Confirm, Allow) that Antigravity presents during code generation.
The system SHALL use CSS selector and text-matching heuristics ported from `auto-accept-agent`.
The system SHALL refuse to auto-click commands matching a banned-command safety list (e.g. `rm -rf /`, fork bombs, disk formatting commands).

#### Scenario: Antigravity Requests Command Execution
- **WHEN** Antigravity pauses generation and presents a "Run Command" button for `npm install express`
- **THEN** the system checks the nearby command text against the banned-command list.
- **AND** the command is not banned
- **THEN** the system auto-clicks the "Run Command" button and generation resumes.

#### Scenario: Antigravity Requests Dangerous Command
- **WHEN** Antigravity presents a "Run Command" button for `rm -rf /`
- **THEN** the system detects the command matches the banned list and does NOT click the button.
- **AND** the system logs a warning and continues polling (the task will eventually time out or the user can intervene manually).

### Requirement: Response Text Extraction
The system SHALL extract the text content of the last AI assistant response from Antigravity's chat DOM after generation completes.
The system SHALL return this text as structured MCP tool output.

#### Scenario: Successful Extraction
- **WHEN** generation completes and the final AI bubble contains "I've refactored 3 files..."
- **THEN** the system extracts this text via CDP `Runtime.evaluate` and returns it as `{content: [{type: "text", text: "I've refactored 3 files..."}]}`.

#### Scenario: Extraction Failure
- **WHEN** the DOM structure has changed and the extraction selector finds no matching elements
- **THEN** the system returns a fallback message: "Antigravity completed the task but response text could not be extracted. Check the Antigravity window directly."

### Requirement: Tool `antigravity-stop`
The system SHALL expose the tool `antigravity-stop` via the MCP interface to halt immediately any running AI operations in the Antigravity sub-agent.

#### Scenario: User Halts External Agent
- **WHEN** the external agent invokes `antigravity-stop`
- **THEN** the system finds the 'Cancel' button in Antigravity's chat interface via CDP evaluate, clicks it, and confirms it stopped.
