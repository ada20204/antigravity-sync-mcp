## 1. Project Initialization & Setup

- [ ] 1.1 Create `antigravity-mcp-server` directory with `npm init -y` and TS setup (mirror `gemini-mcp-tool` pattern: `"type": "module"`, `"main": "dist/index.js"`)
- [ ] 1.2 Add dependencies: `@modelcontextprotocol/sdk`, `ws`, `typescript`, `@types/node`, `@types/ws`
- [ ] 1.3 Configure `tsconfig.json` for ES2022 / Node16 module resolution (copy from `gemini-mcp-tool/tsconfig.json`)
- [ ] 1.4 Add npm scripts: `build` (tsc), `start` (node dist/index.js), `dev` (tsc && node dist/index.js)

## 2. CDP Discovery & Connection (Port from OmniRemote + Auto-Accept)

- [ ] 2.1 Implement `discoverCDP()`: scan `8997-9003` first (Antigravity default), then `7800-7850` (user-configured), then check `ANTIGRAVITY_CDP_PORT` env var override. Return first `workbench.html` target's WebSocket URL.
- [ ] 2.2 Implement `connectCDP(url)`: establish WebSocket, enable `Runtime.enable`, track execution contexts via `Runtime.executionContextCreated/Destroyed` events. Port from `OmniRemote/src/server.js` lines 241-300.
- [ ] 2.3 Implement `evaluateInAllContexts(script)`: iterate all contexts, try `Runtime.evaluate` in each, return first successful result. Port from Omni's pattern used in `captureSnapshot`/`injectMessage`.

## 3. DOM Injection & Interaction Scripts

- [ ] 3.1 Implement `injectMessage(cdp, prompt)`: inject text into `[contenteditable="true"]` and simulate submission. Port from `OmniRemote/src/server.js` `injectMessage()` (lines 432-490).
- [ ] 3.2 Implement `pollCompletionStatus(cdp)`: check for Cancel button `[data-tooltip-id="input-send-button-cancel-tooltip"]` to determine if generation is active. Return `{isGenerating: boolean}`.
- [ ] 3.3 ⚠️ **[REVERSE ENGINEERING REQUIRED]** Implement `extractLatestResponse(cdp)`: extract text content of the last AI assistant response from Antigravity's chat DOM. No reference implementation exists — must be developed against a live Antigravity instance by inspecting actual DOM structure.
- [ ] 3.4 Implement `stopGeneration(cdp)`: find and click the Cancel/Stop button. Port from `OmniRemote/src/server.js` `stopGeneration()` (lines 592-623).

## 4. Auto-Accept Pipeline (Port from auto-accept-agent)

- [ ] 4.1 Port `isAcceptButton(el)` logic: text-match against accept patterns `['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow']` and reject patterns `['skip', 'reject', 'cancel', 'close', 'refine']`. Source: `auto-accept-agent/extension/main_scripts/modules/03_clicking.js` and `00_selectors.js`.
- [ ] 4.2 Port `isCommandBanned(commandText)` logic: scan nearby `<pre>/<code>` elements for dangerous commands. Default banned list: `['rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /']`. Source: `03_clicking.js`.
- [ ] 4.3 Implement `autoAcceptPoll(cdp)`: single CDP evaluate call that finds all visible accept-class buttons, safety-checks them, and clicks safe ones. Designed to run inside the main polling interval alongside `pollCompletionStatus`.

## 5. MCP Server & Tool Routing (Port from gemini-mcp-tool)

- [ ] 5.1 Create `Server` instance with `StdioServerTransport`, register `tools` and `logging` capabilities. Mirror `gemini-mcp-tool/src/index.ts` structure.
- [ ] 5.2 Define `ask-antigravity` Tool schema: `{prompt: string}` input. Handler: discover CDP → connect → inject message → enter polling loop → return extracted response.
- [ ] 5.3 Define `antigravity-stop` Tool schema: no required input. Handler: discover CDP → connect → click stop button → return confirmation.

## 6. Progress Keepalive & Polling Loop

- [ ] 6.1 Implement `startProgressUpdates(progressToken)`: send `sendProgressNotification` every 25 seconds with status messages. Port from `gemini-mcp-tool/src/index.ts` (lines 86-161).
- [ ] 6.2 Implement the unified polling loop inside `ask-antigravity` handler: every 1 second, run `pollCompletionStatus()` + `autoAcceptPoll()`. On each 25s boundary, send progress notification. On completion detected, break loop, run `extractLatestResponse()`, return result.
- [ ] 6.3 Handle edge cases: CDP disconnect mid-task (reconnect or fail gracefully), generation never completes (configurable max timeout, default 5 minutes).

## 7. Testing & Integration

- [ ] 7.1 Manual integration test: configure MCP client (e.g., Claude Code or Cursor) to spawn `antigravity-mcp-server`, send a simple prompt, verify round-trip.
- [ ] 7.2 Document setup instructions: how to launch Antigravity with debug port, how to register the MCP server in client config.
- [ ] 7.3 Add a `Ping` tool for connection testing (same pattern as gemini-mcp-tool).
