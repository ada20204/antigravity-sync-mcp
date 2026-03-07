#!/usr/bin/env bash

set -euo pipefail

# Verify that a VSIX package contains the bundled server runtime,
# runtime dependencies, and the workspace core package payload.
# Usage:
#   ./verify-vsix.sh                 # newest .vsix in current directory
#   ./verify-vsix.sh path/to/x.vsix  # explicit package path

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [path-to-vsix]"
  exit 1
fi

if [[ $# -eq 1 ]]; then
  VSIX="$1"
else
  VSIX="$(ls -t *.vsix 2>/dev/null | head -1 || true)"
fi

if [[ -z "${VSIX:-}" ]]; then
  echo "No .vsix file found"
  exit 1
fi

if [[ ! -f "$VSIX" ]]; then
  echo "VSIX not found: $VSIX"
  exit 1
fi

VSIX_PATH="$(cd "$(dirname "$VSIX")" && pwd)/$(basename "$VSIX")"
echo "Checking $VSIX_PATH..."

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

unzip -q "$VSIX_PATH" -d "$WORK_DIR"

require_path() {
  local path="$1"
  local description="$2"

  if [[ ! -e "$WORK_DIR/extension/$path" ]]; then
    echo "FAIL: ${description} missing at extension/$path in $(basename "$VSIX_PATH")"
    exit 1
  fi
}

require_path "server-runtime/dist/index.js" "bundled server runtime entry"
require_path "server-runtime/node_modules/ws" "ws module"
require_path "server-runtime/node_modules/@modelcontextprotocol/sdk" "@modelcontextprotocol/sdk module"
require_path "server-runtime/node_modules/@antigravity-mcp/core/package.json" "@antigravity-mcp/core package metadata"
require_path "server-runtime/node_modules/@antigravity-mcp/core/dist/index.js" "@antigravity-mcp/core build output"

echo "PASS: bundled server runtime, runtime deps, and core package present in $(basename "$VSIX_PATH")"
exit 0
