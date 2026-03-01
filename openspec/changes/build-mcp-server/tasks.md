> Status: Historical (superseded)
> Superseded on 2026-03-01 by the current baseline in `openspec/project.md` and `openspec/config.yaml`.
> This task list is retained for traceability only; do not execute it as the current implementation plan.

## 1. Project Initialization & Setup (Completed)

- [x] 1.1 Create `antigravity-mcp-server` directory with `npm init -y` and TS setup
- [x] 1.2 Add dependencies: `@modelcontextprotocol/sdk`, `ws`, `typescript`, `@types/node`, `@types/ws`
- [x] 1.3 Configure `tsconfig.json` for ES2022 / Node16 module resolution
- [x] 1.4 Add npm scripts: `build` (tsc)

## 2. CDP Discovery & Connection (Registry Architecture - Completed)

- [x] 2.1 Develop `antigravity-mcp-sidecar` extension to run natively inside Antigravity.
- [x] 2.2 Sidecar writes `[Workspace Path] -> {port, ip}` mappings (`~/.antigravity-mcp/registry.json`), including WSL host detection via `/etc/resolv.conf`.
- [x] 2.3 `discoverCDP` in the MCP Server directly reads the registry to bypass port scanning and cross network barriers entirely.
- [x] 2.4 Implement `connectCDP(url)`: establish WebSocket, tracking execution contexts.

## 3. DOM Injection & Interaction Scripts

- [x] 3.1 Implement `injectMessage(cdp, prompt)`: inject text into `[contenteditable="true"]` and simulate submission. Port from `OmniRemote/src/server.js` `injectMessage()` (lines 432-490).
- [x] 3.2 Implement `pollCompletionStatus(cdp)`: check for Cancel button `[data-tooltip-id="input-send-button-cancel-tooltip"]` to determine if generation is active. Return `{isGenerating: boolean}`.
- [x] 3.3 ⚠️ **[REVERSE ENGINEERING REQUIRED]** Implement `extractLatestResponse(cdp)`: extract text content of the last AI assistant response from Antigravity's chat DOM. No reference implementation exists — must be developed against a live Antigravity instance by inspecting actual DOM structure.
- [x] 3.4 Implement `stopGeneration(cdp)`: find and click the Cancel/Stop button. Port from `OmniRemote/src/server.js` `stopGeneration()` (lines 592-623).

## 4. Auto-Accept Pipeline (Port from auto-accept-agent)

- [x] 4.1 Port `isAcceptButton(el)` logic: text-match against accept patterns `['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow']` and reject patterns `['skip', 'reject', 'cancel', 'close', 'refine']`. Source: `auto-accept-agent/extension/main_scripts/modules/03_clicking.js` and `00_selectors.js`.
- [x] 4.2 Port `isCommandBanned(commandText)` logic: scan nearby `<pre>/<code>` elements for dangerous commands. Default banned list: `['rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /']`. Source: `03_clicking.js`.
- [x] 4.3 Implement `autoAcceptPoll(cdp)`: single CDP evaluate call that finds all visible accept-class buttons, safety-checks them, and clicks safe ones. Designed to run inside the main polling interval alongside `pollCompletionStatus`.

## 5. MCP Server & Tool Routing (Port from gemini-mcp-tool)

- [x] 5.1 Create `Server` instance with `StdioServerTransport`, register `tools` and `logging` capabilities. Mirror `gemini-mcp-tool/src/index.ts` structure.
- [x] 5.2 Define `ask-antigravity` Tool schema: `{prompt: string}` input. Handler: discover CDP → connect → inject message → enter polling loop → return extracted response.
- [x] 5.3 Define `antigravity-stop` Tool schema: no required input. Handler: discover CDP → connect → click stop button → return confirmation.

## 6. Progress Keepalive & Polling Loop

- [x] 6.1 Implement `startProgressUpdates(progressToken)`: send `sendProgressNotification` every 25 seconds with status messages. Port from `gemini-mcp-tool/src/index.ts` (lines 86-161).
- [x] 6.2 Implement the unified polling loop inside `ask-antigravity` handler: every 1 second, run `pollCompletionStatus()` + `autoAcceptPoll()`. On each 25s boundary, send progress notification. On completion detected, break loop, run `extractLatestResponse()`, return result.
- [x] 6.3 Handle edge cases: CDP disconnect mid-task (reconnect or fail gracefully), generation never completes (configurable max timeout, default 5 minutes).

## 7. Testing & Integration

- [ ] 7.1 Manual integration test: configure MCP client (e.g., Claude Code or Cursor) to spawn `antigravity-mcp-server`, send a simple prompt, verify round-trip.
- [x] 7.2 Document setup instructions: how to launch Antigravity with debug port, how to register the MCP server in client config.
- [x] 7.3 Add a `Ping` tool for connection testing (same pattern as gemini-mcp-tool).
