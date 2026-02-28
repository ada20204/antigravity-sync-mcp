#!/bin/bash

# Verify that the vsix package contains the ws module

VSIX=$(ls -t *.vsix 2>/dev/null | head -1)

if [ -z "$VSIX" ]; then
    echo "No .vsix file found"
    exit 1
fi

echo "Checking $VSIX..."

# Get absolute path
VSIX_PATH="$(pwd)/$VSIX"

# Extract and check
cd /tmp
rm -rf vsix_verify
mkdir vsix_verify
cd vsix_verify
unzip -q "$VSIX_PATH"

if [ -d "extension/node_modules/ws" ]; then
    echo "$VSIX: ws module present"
    exit 0
else
    echo "$VSIX: ws module MISSING"
    exit 1
fi
