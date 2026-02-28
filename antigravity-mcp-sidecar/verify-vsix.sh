#!/bin/bash
# Verify vsix package contains required dependencies

set -e

VSIX_FILE="$1"
if [ -z "$VSIX_FILE" ]; then
    echo "Usage: $0 <path-to-vsix>"
    exit 1
fi

if [ ! -f "$VSIX_FILE" ]; then
    echo "Error: $VSIX_FILE not found"
    exit 1
fi

echo "Verifying $VSIX_FILE..."

# Extract to temp dir
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

unzip -q "$VSIX_FILE" -d "$TEMP_DIR"

# Check required dependencies
REQUIRED_DEPS=("ws")
MISSING=()

for dep in "${REQUIRED_DEPS[@]}"; do
    if [ ! -d "$TEMP_DIR/extension/node_modules/$dep" ]; then
        MISSING+=("$dep")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "❌ FAILED: Missing dependencies: ${MISSING[*]}"
    exit 1
fi

# Check file count
FILE_COUNT=$(find "$TEMP_DIR/extension" -type f | wc -l)
echo "✅ PASSED: All required dependencies present"
echo "   Files: $FILE_COUNT"
echo "   Size: $(du -h "$VSIX_FILE" | cut -f1)"

# List node_modules
echo "   Dependencies:"
ls "$TEMP_DIR/extension/node_modules/" | sed 's/^/     - /'
