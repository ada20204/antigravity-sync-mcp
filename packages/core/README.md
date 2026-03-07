# @antigravity-mcp/core

Shared types and utilities for the Antigravity MCP monorepo.

This package centralizes code that is shared by both `packages/server` and `packages/sidecar`, so registry schema, control-plane constants, and platform helpers stay in sync after the core extraction.

## Contents

- Registry types and schema
- Control plane constants
- Platform utilities (path resolution, platform detection)

## Usage

```typescript
import { RegistryEntry, SCHEMA_VERSION, getRegistryPath } from '@antigravity-mcp/core';
```
