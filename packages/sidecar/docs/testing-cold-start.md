# Testing Server Cold Start

## Prerequisites

1. Set environment variable:
   ```bash
   export ANTIGRAVITY_EXECUTABLE="/path/to/Antigravity.app/Contents/MacOS/Antigravity"
   ```

2. Ensure Antigravity is NOT running:
   ```bash
   pkill -9 Antigravity
   ```

## Test Scenario 1: Cold Start (Antigravity Not Running)

1. Verify Antigravity is not running:
   ```bash
   pgrep -i Antigravity
   # Should return nothing
   ```

2. Start MCP server:
   ```bash
   node packages/sidecar/server-runtime/dist/index.js --target-dir /path/to/workspace
   ```

3. Call `launch-antigravity` tool via MCP client

4. Expected behavior:
   - Server detects Antigravity not running
   - Server spawns restart-worker with --cold-start flag
   - Worker skips kill/wait phases
   - Worker launches Antigravity
   - Worker verifies CDP readiness
   - Server returns JSON with worker PID and port

5. Verify:
   ```bash
   # Check Antigravity is running
   pgrep -i Antigravity

   # Check CDP is responding
   curl http://127.0.0.1:9000/json/version

   # Check worker logs
   cat ~/.config/antigravity-mcp/restart-worker.log

   # Check worker result
   cat ~/.config/antigravity-mcp/restart-result.json
   ```

## Test Scenario 2: Reject When Already Running

1. Ensure Antigravity IS running:
   ```bash
   pgrep -i Antigravity
   # Should return PID
   ```

2. Call `launch-antigravity` tool via MCP client

3. Expected behavior:
   - Server detects Antigravity is running
   - Server returns error: "Antigravity is already running. Close it first or use a restart mechanism if available."
   - No worker is spawned
   - Antigravity continues running normally

## Test Scenario 3: Worker Status Files

1. After cold-start, check status file:
   ```bash
   cat ~/.config/antigravity-mcp/restart-status.json
   ```

   Expected fields:
   - `requestId`: unique ID
   - `phase`: "complete"
   - `status`: "success"
   - `createdAt`, `updatedAt`: timestamps

2. Check result file:
   ```bash
   cat ~/.config/antigravity-mcp/restart-result.json
   ```

   Expected fields:
   - `status`: "success"
   - `phase`: "complete"
   - `mode`: "cold-start"
   - `port`: allocated CDP port
   - `workspace`: target directory
   - `cdpVerified`: true/false
   - `logs`: array of log lines

## Cleanup

```bash
# Stop Antigravity
pkill -9 Antigravity

# Remove status files
rm ~/.config/antigravity-mcp/restart-*.json
rm ~/.config/antigravity-mcp/restart-worker.log
```
