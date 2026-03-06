#!/usr/bin/env bash

set -euo pipefail

# Verify that a VSIX package contains the bundled ws module.
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

if [[ ! -f "$WORK_DIR/extension/server-runtime/dist/index.js" ]]; then
  echo "FAIL: bundled server runtime missing in $(basename "$VSIX_PATH")"
  exit 1
fi

if [[ ! -d "$WORK_DIR/extension/node_modules/ws" ]]; then
  echo "FAIL: ws module missing in $(basename "$VSIX_PATH")"
  exit 1
fi

if [[ ! -d "$WORK_DIR/extension/node_modules/@modelcontextprotocol/sdk" ]]; then
  echo "FAIL: @modelcontextprotocol/sdk missing in $(basename "$VSIX_PATH")"
  exit 1
fi

echo "PASS: bundled server runtime + deps present in $(basename "$VSIX_PATH")"
exit 0
