#!/usr/bin/env bash
set -euo pipefail

# Auto-optimize antigravity-mcp-sidecar with unlimited timeout support
# Extends MAX_TIMEOUT from 5 minutes to 30 minutes (configurable via env var)

LATEST_VERSION=$(find ~/.antigravity/extensions -maxdepth 1 -type d -name "antigravity.antigravity-mcp-sidecar-*" 2>/dev/null | sort -V | tail -1)

if [ -z "$LATEST_VERSION" ]; then
    echo "Error: antigravity-mcp-sidecar not found in ~/.antigravity/extensions"
    exit 1
fi

DIST_DIR="$LATEST_VERSION/server-runtime/dist"

echo "Found: $LATEST_VERSION"
echo "Applying optimizations with extended MAX_TIMEOUT for unlimited task duration..."

# Backup original files
if [ ! -f "$DIST_DIR/index.js.backup" ]; then
    cp "$DIST_DIR/index.js" "$DIST_DIR/index.js.backup"
    echo "✓ Backed up index.js"
fi

if [ ! -f "$DIST_DIR/scripts.js.backup" ]; then
    cp "$DIST_DIR/scripts.js" "$DIST_DIR/scripts.js.backup"
    echo "✓ Backed up scripts.js"
fi

# Step 1: Optimize timeout constants in index.js
sed -i '' \
  -e 's/const POLL_INTERVAL = [0-9]*;/const POLL_INTERVAL = 500;/' \
  -e 's/const DISCOVER_TIMEOUT_MS = [0-9]*;/const DISCOVER_TIMEOUT_MS = 5000;/' \
  -e 's/const CONNECT_TIMEOUT_MS = [0-9]*;/const CONNECT_TIMEOUT_MS = 8000;/' \
  -e 's/const INJECT_TIMEOUT_MS = [0-9]*;/const INJECT_TIMEOUT_MS = 125000;/' \
  -e 's/const EXTRACT_TIMEOUT_MS = [0-9]*;/const EXTRACT_TIMEOUT_MS = 10000;/' \
  "$DIST_DIR/index.js"
echo "✓ Optimized timeout constants in index.js"

# Step 2: Extend MAX_TIMEOUT with environment variable support
sed -i '' \
  's/const MAX_TIMEOUT = 5 \* 60 \* 1000;/const MAX_TIMEOUT = (process.env.ANTIGRAVITY_MAX_TIMEOUT ? parseInt(process.env.ANTIGRAVITY_MAX_TIMEOUT) : 30 * 60 * 1000);/' \
  "$DIST_DIR/index.js"
echo "✓ Extended MAX_TIMEOUT to 30 minutes (configurable via ANTIGRAVITY_MAX_TIMEOUT)"

# Step 3: Update injectMessage call to pass extended options
sed -i '' \
  's/injectMessage(liveCdp, prompt, { maxWaitMs: [0-9]*, pollIntervalMs: [0-9]* })/injectMessage(liveCdp, prompt, { maxWaitMs: 120000, pollIntervalMs: 500 })/g' \
  "$DIST_DIR/index.js"
echo "✓ Updated injectMessage call with extended polling options (120s max wait)"

# Step 4: Update outer timeout
sed -i '' \
  's/[0-9]*, "injectMessage"/125000, "injectMessage"/g' \
  "$DIST_DIR/index.js"
echo "✓ Updated outer timeout to 125s"

# Step 5: Update default maxWaitMs in scripts.js
sed -i '' \
  's/const maxWaitMs = options\.maxWaitMs || [0-9]*;/const maxWaitMs = options.maxWaitMs || 120000;/' \
  "$DIST_DIR/scripts.js"
echo "✓ Updated default maxWaitMs in scripts.js to 120s"

# Step 6: Update comment in scripts.js
sed -i '' \
  's/@param {number} options\.maxWaitMs - Maximum wait time (default: [0-9]*)/@param {number} options.maxWaitMs - Maximum wait time (default: 120000 for long tasks)/' \
  "$DIST_DIR/scripts.js"
echo "✓ Updated JSDoc comment"

# Step 7: Optimize wait-state.js
sed -i '' \
  -e 's/const TRAJECTORY_POLL_INTERVAL_MS = [0-9]*;/const TRAJECTORY_POLL_INTERVAL_MS = 800;/' \
  "$DIST_DIR/wait-state.js"
echo "✓ Optimized wait-state.js"

# Step 8: Optimize scripts.js model selection delay
sed -i '' \
  -e 's/setTimeout(resolve, 120)/setTimeout(resolve, 50)/' \
  "$DIST_DIR/scripts.js"
echo "✓ Optimized model selection delay"

echo ""
echo "Optimization complete!"
echo ""
echo "Changes:"
echo "  - POLL_INTERVAL: → 500ms"
echo "  - DISCOVER_TIMEOUT: → 5s"
echo "  - CONNECT_TIMEOUT: → 8s"
echo "  - INJECT_TIMEOUT: → 125s (extended for long tasks)"
echo "  - MAX_TIMEOUT: → 30 minutes (default, configurable)"
echo "  - EXTRACT_TIMEOUT: → 10s"
echo "  - TRAJECTORY_POLL: → 800ms"
echo "  - MODEL_SELECT_DELAY: → 50ms"
echo "  - injectMessage maxWaitMs: → 120s (default)"
echo ""
echo "Heartbeat mechanism:"
echo "  - Progress notifications: every 25 seconds"
echo "  - Status polling: every 500ms"
echo "  - External monitoring: via LSP \$/progress protocol"
echo ""
echo "This configuration supports:"
echo "  - Simple tasks: 8-12s"
echo "  - Medium tasks: 30-60s"
echo "  - Complex tasks: 60-180s"
echo "  - Super long tasks: 180-1800s (30 minutes)"
echo "  - Unlimited tasks: set ANTIGRAVITY_MAX_TIMEOUT=99999999"
echo ""
echo "Environment variable configuration:"
echo "  export ANTIGRAVITY_MAX_TIMEOUT=3600000  # 60 minutes"
echo "  export ANTIGRAVITY_MAX_TIMEOUT=99999999 # unlimited (27 hours)"
echo ""
echo "To restore original:"
echo "  cp $DIST_DIR/index.js.backup $DIST_DIR/index.js"
echo "  cp $DIST_DIR/scripts.js.backup $DIST_DIR/scripts.js"
