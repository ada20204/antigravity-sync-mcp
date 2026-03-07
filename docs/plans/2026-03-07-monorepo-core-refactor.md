# Monorepo + Core Layer Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert antigravity-mcp project to monorepo with shared core layer, refactor server and sidecar into clean layered architecture.

**Architecture:** npm workspaces monorepo with three packages: @antigravity-mcp/core (shared types/utils), antigravity-mcp-server (MCP server), antigravity-mcp-sidecar (VS Code extension). Core provides registry types, CDP types, quota types, and platform utilities. Server and sidecar depend on core and are refactored into tools/services/utils layers.

**Tech Stack:** TypeScript 5.1+, npm workspaces, Node.js 18+, VS Code Extension API, MCP SDK

---

## Phase 0: Monorepo Conversion (1-2 days)

### Task 0.1: Create Root Workspace Configuration

**Files:**
- Create: `package.json` (root)

**Step 1: Create root package.json**

Create file with workspace configuration:
```json
{
  "name": "antigravity-mcp",
  "version": "0.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm test --workspaces --if-present",
    "clean": "npm run clean --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.1.3"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Step 2: Verify root package.json**

Run: `cat package.json`
Expected: File contains workspace configuration

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add root workspace configuration"
```

---

### Task 0.2: Move Server to packages/

**Files:**
- Move: `antigravity-mcp-server/` → `packages/server/`

**Step 1: Create packages directory**

```bash
mkdir -p packages
```

**Step 2: Move server package**

```bash
git mv antigravity-mcp-server packages/server
```

**Step 3: Verify move**

Run: `ls -la packages/server/package.json`
Expected: File exists

**Step 4: Commit**

```bash
git commit -m "chore: move server to packages/server"
```

---

### Task 0.3: Move Sidecar to packages/

**Files:**
- Move: `antigravity-mcp-sidecar/` → `packages/sidecar/`

**Step 1: Move sidecar package**

```bash
git mv antigravity-mcp-sidecar packages/sidecar
```

**Step 2: Verify move**

Run: `ls -la packages/sidecar/package.json`
Expected: File exists

**Step 3: Commit**

```bash
git commit -m "chore: move sidecar to packages/sidecar"
```

---

### Task 0.4: Install Workspace Dependencies

**Files:**
- Verify: `package.json` (root)

**Step 1: Clean existing node_modules**

```bash
rm -rf packages/server/node_modules packages/sidecar/node_modules
```

**Step 2: Install workspace dependencies**

Run: `npm install`
Expected: Creates root node_modules with hoisted dependencies

**Step 3: Verify workspace links**

Run: `npm ls --workspaces`
Expected: Shows packages/server and packages/sidecar

**Step 4: Commit lock file**

```bash
git add package-lock.json
git commit -m "chore: install workspace dependencies"
```

---

### Task 0.5: Verify Builds Still Work

**Files:**
- Verify: `packages/server/tsconfig.json`

**Step 1: Build server**

Run: `cd packages/server && npm run build`
Expected: Build succeeds, creates build/dist/

**Step 2: Build sidecar**

Run: `cd packages/sidecar && npm run sync-server-runtime`
Expected: Syncs dependencies

**Step 3: Run server tests**

Run: `cd packages/server && npm test`
Expected: All tests pass

**Step 4: Verify no regressions**

Run: `npm run build --workspaces`
Expected: Both packages build successfully

**Step 5: Commit verification**

```bash
git add -A
git commit -m "verify: Phase 0 complete - monorepo conversion successful"
```

---

## Phase 1: Extract Core Package (1 week)

Due to the length and complexity of this plan, Phase 1-4 detailed tasks will be provided in separate documents or upon request. The complete plan includes:

- Phase 1: Extract Core Package (Tasks 1.1-1.10)
  - Create core package structure
  - Extract registry types and schema
  - Extract CDP types
  - Extract quota types
  - Extract control plane constants
  - Extract platform utilities
  - Write comprehensive tests

- Phase 2: Refactor Server (Tasks 2.1-2.8)
  - Update server to depend on core
  - Extract tools layer
  - Extract services layer
  - Extract utils layer
  - Update tests

- Phase 3: Refactor Sidecar (Tasks 3.1-3.12)
  - Update sidecar to depend on core
  - Extract commands layer
  - Extract services layer
  - Extract core/lifecycle layer
  - Extract UI layer
  - Update VSIX packaging

- Phase 4: Cleanup and Optimization (Tasks 4.1-4.5)
  - Remove duplicate code
  - Optimize TypeScript configuration
  - Update documentation
  - Final integration tests

**Next Steps:**
1. Execute Phase 0 tasks (monorepo conversion)
2. Request detailed Phase 1 tasks when ready
3. Continue through phases sequentially

**Execution Recommendation:**
Use superpowers:executing-plans skill to execute this plan in batches with review checkpoints between phases.
