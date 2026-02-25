## 1. Project Initialization & Setup

- [ ] 1.1 Create `antigravity-mcp` directory (npm init + TS setup based on gemini-mcp-tool pattern)
- [ ] 1.2 Add dependencies: `@modelcontextprotocol/sdk`, `ws`, `express` (if needed for fallbacks), `typescript`, etc.
- [ ] 1.3 Configure `tsconfig.json` for Node 18+ module exports

## 2. CDP Extractor & Adapter (From OmniRemote)

- [ ] 2.1 Port `discoverCDP` and `discoverAllCDP` logic to fetch target WebSocket URLs locally running on ports 7800-7850
- [ ] 2.2 Re-implement `connectCDP(url)` wrapper for maintaining the headless WebSocket and keeping tracking of Contexts
- [ ] 2.3 Create robust DOM evaluation scripts (`evaluateExpression(script, context)`)

## 3. DOM Injection Scripts

- [ ] 3.1 Implement `injectMessage(prompt)` scripts to inject payload into the Antigravity chat input and simulate submission
- [ ] 3.2 Implement `pollCompletionStatus()` script searching for cancel UI elements, indicating generation active state vs complete
- [ ] 3.3 Implement `extractLatestResponse()` script identifying the DOM sequence of the last active Assistant bubble and fetching text

## 4. MCP Server Routing (From Gemini MCP Tool)

- [ ] 4.1 Define the `ask-antigravity` Tool schema using `@modelcontextprotocol/sdk` validation shapes
- [ ] 4.2 Set up `StdioServerTransport` server listening loop
- [ ] 4.3 Configure tool routers: when `ask-antigravity` is hit, invoke the CDP adapter

## 5. Streaming & Progress Integration

- [ ] 5.1 Implement `startProgressUpdates()` leveraging `sendProgressNotification` to ping the MCP client during long waits
- [ ] 5.2 Set up periodic interval execution of `pollCompletionStatus()` during tool execution
- [ ] 5.3 On completion, clear intervals, grab output from `extractLatestResponse()`, and return `{ content: [...] }` payload back to the external Agent.

## 6. Testing & Sandbox Automation

- [ ] 6.1 Create `antigravity-stop` Tool mapped directly to `stopGeneration` DOM scripts for emergency exit mappings
- [ ] 6.2 Test integration via external MCP agent configuration, e.g., Cursor or Claude Code, calling into a locally running Antigravity.
