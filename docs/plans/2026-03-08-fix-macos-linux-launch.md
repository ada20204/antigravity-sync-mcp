# Fix macOS/Linux Antigravity Launch with CDP Parameters

**Date**: 2026-03-08
**Status**: Approved
**Platforms**: macOS, Linux

## Problem

The MCP `launch-antigravity` tool fails to start Antigravity with CDP (Chrome DevTools Protocol) parameters on macOS and Linux, while Windows works correctly.

### Root Cause

On macOS and Linux, the `antigravity` executable is a bash script that wraps the Electron binary. The current implementation uses:

```javascript
spawn(executable, args, { shell: false })
```

In `shell: false` mode, Node.js `spawn()` cannot properly pass arguments through bash scripts to the underlying Electron process. This causes CDP parameters like `--remote-debugging-port` to be lost, preventing MCP from connecting to Antigravity.

### Evidence

**Manual launch (works)**:
```bash
/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity \
  /path/to/workspace \
  --new-window \
  --remote-debugging-port=9002 \
  --remote-debugging-address=127.0.0.1
```
Result: CDP port 9002 listening ✓

**Current spawn() implementation (fails)**:
```javascript
spawn(executable, args, { shell: false })
```
Result: CDP port not listening ✗

## Solution

Use `bash -c` to execute the complete command, ensuring arguments are properly passed through the shell script wrapper.

### Implementation

Modify `packages/sidecar/src/services/launcher.js` function `launchAntigravityDetached()` (lines 147-157):

```javascript
// macOS/Linux: Use bash -c to properly pass arguments through shell script
if (restart) {
    try {
        spawn('pkill', ['-f', 'Antigravity'], { stdio: 'ignore' });
    } catch { }
}

// Escape arguments for safe shell execution
const escapedArgs = args.map(arg => {
    const escaped = String(arg).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${escaped}'`;
});
const cmd = `exec "${executable}" ${escapedArgs.join(' ')}`;

const child = spawn('bash', ['-c', cmd], {
    detached: true,
    stdio: 'ignore',
});
child.unref();
```

### Why This Works

1. **bash -c**: Executes the command in a bash shell, properly handling the script wrapper
2. **Argument escaping**: Handles special characters (spaces, quotes) in paths and arguments
3. **exec**: Replaces the bash process with Electron, avoiding unnecessary parent processes
4. **Consistent with manual launch**: Mimics the behavior of running the command in a terminal

## Platform Analysis

### Windows (No Change)
- Uses PowerShell `Start-Process` with proper argument arrays
- Already working correctly
- No modification needed

### macOS
- Executable: `/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity` (bash script)
- Issue confirmed through testing
- Fix required

### Linux
- Executable: `/usr/bin/antigravity` or `/usr/local/bin/antigravity` (bash script)
- Same structure as macOS (VS Code upstream pattern)
- Same fix applies (assumed, requires Linux testing for final verification)

## Testing Plan

1. **macOS**: Verify CDP port starts correctly with launch-antigravity tool
2. **Linux**: Test on Linux environment (pending)
3. **Windows**: Regression test to ensure no impact

## Notes

- macOS and Linux share the same fix logic in this implementation
- Both platforms use bash scripts with identical structure
- If Linux behavior differs, the fix can be adjusted in a follow-up
