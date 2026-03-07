# Monorepo + Core Layer Refactor

## Problem

Current codebase has significant maintainability issues:

1. **Code duplication** - Registry types, schema definitions, and read logic duplicated between sidecar (JS) and server (TS)
2. **Large monolithic files** - `extension.js` (2,622 lines), `index.ts` (1,114 lines) with mixed responsibilities
3. **Type drift risk** - TypeScript types in server vs JSDoc in sidecar can diverge
4. **Schema evolution pain** - Upgrading registry schema requires synchronized changes in multiple places
5. **Testing gaps** - Core logic (registry validation, schema compatibility) not independently testable

## Goals

1. **Extract shared core layer** - Create `@antigravity-mcp/core` package with:
   - Registry types and schema definitions (single source of truth)
   - Registry I/O utilities
   - CDP type definitions
   - Quota data structures
   - Control plane constants

2. **Establish clear layering** - Refactor sidecar and server into:
   - Core layer (shared primitives)
   - Service layer (business logic)
   - Interface layer (VS Code commands / MCP tools)

3. **Convert to monorepo** - Use npm workspaces for:
   - Simplified dependency management
   - Better development experience
   - Easier cross-package refactoring

## Non-Goals

- Changing external APIs (MCP tools, VS Code commands remain the same)
- Modifying registry schema (stays at v2)
- Rewriting in different language
- Bundling/build optimization (separate concern)

## Success Criteria

1. **Zero behavior change** - All existing tests pass, no functional regressions
2. **Type safety** - Sidecar uses JSDoc to reference core TypeScript types
3. **Single source of truth** - Registry schema defined once in core
4. **Improved testability** - Core layer has 100% test coverage
5. **Better maintainability** - No file over 500 lines, clear module boundaries

## Impact

### Data Plane
- No impact - CDP connection logic remains the same
- Server still reads local registry and connects to `local_endpoint`

### Control Plane
- No impact - Bridge auth, restart requests unchanged
- Shared constants moved to core but values identical

### Backward Compatibility
- Full compatibility - no breaking changes
- Existing registry entries work as-is
- MCP clients see no difference
- VS Code extension behavior unchanged

## Risks

1. **Migration complexity** - Moving 7,000+ lines of code
   - Mitigation: Phased approach (core → server → sidecar)

2. **Build chain changes** - TypeScript project references
   - Mitigation: Comprehensive build verification tasks

3. **VSIX packaging** - Sidecar must bundle core
   - Mitigation: Update sync-server-runtime.mjs to include core

4. **Type compatibility** - JS sidecar consuming TS core types
   - Mitigation: Use JSDoc `@typedef {import('@antigravity-mcp/core').RegistryEntry}`
