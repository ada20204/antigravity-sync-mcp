# Launch/Restart 职责划分实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一 launch/restart 逻辑，Server 负责冷启动检测，Worker 统一执行所有 launch/restart 操作

**Architecture:**
- Server 的 `launch-antigravity` 工具通过 `discoverCDP` 检测 Antigravity 是否运行
- 未运行时启动 `restart-worker.js --cold-start`（跳过 kill/wait）
- 已运行时返回错误
- Worker 通过 `--cold-start` 参数支持冷启动和热重启两种模式

**Tech Stack:** Node.js, MCP Server, Sidecar Extension, Child Process

---

## Task 1: 为 restart-worker 添加冷启动模式支持

**Files:**
- Modify: `packages/sidecar/scripts/restart-worker.js:40-50` (参数解析)
- Modify: `packages/sidecar/scripts/restart-worker.js:380-450` (main 函数)

**Step 1: 添加 --cold-start 参数解析**

在参数解析部分添加：

```javascript
function getColdStart() {
    return parsedArgs['cold-start'] !== undefined;
}
```

在 `__testExports` 中导出：

```javascript
module.exports = {
    __testExports: {
        parseArgs,
        buildLaunchArgs,
        validateArgs,
        getWorkspace,
        getAntigravityPath,
        getPort,
        getBindAddress,
        getExtraArgs,
        getColdStart,  // 新增
    },
};
```

**Step 2: 修改 main 函数支持冷启动模式**

在 `main()` 函数中：

```javascript
async function main() {
    validateArgs();
    const coldStart = getColdStart();

    log('=== Antigravity Restart Worker Started ===');
    log(`Request ID: ${getRequestId()}`);
    log(`Mode: ${coldStart ? 'cold-start' : 'restart'}`);
    log(`Workspace: ${getWorkspace()}`);
    log(`Antigravity: ${getAntigravityPath()}`);
    log(`Port: ${getPort()}`);
    log(`Bind Address: ${getBindAddress()}`);
    log(`Wait for CDP: ${getWaitForCdp()}`);
    log(`Extra Args: ${getExtraArgs().join(' ')}`);

    updateStatus('starting');

    const absoluteTimeout = setTimeout(() => {
        log('ABSOLUTE TIMEOUT REACHED');
        writeResult('timeout', 'unknown', 'Worker exceeded 30s absolute timeout');
        process.exit(1);
    }, ABSOLUTE_TIMEOUT_MS);

    try {
        // 冷启动模式跳过 kill 和 wait
        if (!coldStart) {
            await phase1_killOldProcess();
            await phase2_waitForExit();
        } else {
            log('Cold start mode: skipping kill and wait phases');
        }

        await phase3_launchNewProcess();
        const cdpResult = await phase4_verifyCdp();

        updateStatus('complete', 'success');
        writeResult('success', 'complete', null, {
            port: getPort(),
            workspace: getWorkspace(),
            mode: coldStart ? 'cold-start' : 'restart',
            ...cdpResult,
        });

        clearTimeout(absoluteTimeout);
        log(`=== ${coldStart ? 'Cold start' : 'Restart'} completed successfully ===`);
        process.exit(0);

    } catch (error) {
        clearTimeout(absoluteTimeout);
        exitWithError('unknown', error.message);
    }
}
```

**Step 3: 测试冷启动模式参数解析**

创建测试文件 `packages/sidecar/test/restart-worker-cold-start.test.mjs`：

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('restart-worker cold-start mode', () => {
    it('should parse --cold-start flag', () => {
        const originalArgv = process.argv;
        process.argv = [
            'node',
            'restart-worker.js',
            '--workspace', '/workspace',
            '--antigravity-path', '/antigravity',
            '--port', '9001',
            '--config-dir', '/config',
            '--cold-start',
        ];

        const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
        delete require.cache[require.resolve(workerPath)];
        const worker = require(workerPath);

        const { getColdStart } = worker.__testExports;
        assert.strictEqual(getColdStart(), true);

        process.argv = originalArgv;
    });

    it('should default to restart mode without --cold-start', () => {
        const originalArgv = process.argv;
        process.argv = [
            'node',
            'restart-worker.js',
            '--workspace', '/workspace',
            '--antigravity-path', '/antigravity',
            '--port', '9001',
            '--config-dir', '/config',
        ];

        const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
        delete require.cache[require.resolve(workerPath)];
        const worker = require(workerPath);

        const { getColdStart } = worker.__testExports;
        assert.strictEqual(getColdStart(), false);

        process.argv = originalArgv;
    });
});
```

**Step 4: 运行测试验证**

```bash
npm test -- test/restart-worker-cold-start.test.mjs
```

Expected: PASS (2 tests)

**Step 5: 提交**

```bash
git add packages/sidecar/scripts/restart-worker.js packages/sidecar/test/restart-worker-cold-start.test.mjs
git commit -m "feat(restart-worker): add cold-start mode support

- Add --cold-start parameter to skip kill/wait phases
- Update main flow to conditionally execute phases
- Add tests for cold-start parameter parsing"
```

---

## Task 2: 在 Server 中添加 isAntigravityRunning 检测函数

**Files:**
- Modify: `packages/sidecar/server-runtime/dist/index.js:800-850` (添加检测函数)

**Step 1: 添加 isAntigravityRunning 函数**

在 `handleLaunchAntigravity` 函数之前添加：

```javascript
/**
 * Check if Antigravity is currently running by attempting CDP discovery.
 * Uses discoverCDP to check for any ready workspace entry.
 *
 * @returns {Promise<boolean>} true if Antigravity is running with CDP available
 */
async function isAntigravityRunning() {
    try {
        // Try to discover any ready CDP endpoint
        // targetDir: undefined means check for any ready entry
        const result = await discoverCDP({
            targetDir: undefined,
            timeoutMs: 3000  // Quick check
        });

        // If discovery succeeds, Antigravity is running
        return result.success === true;
    } catch (error) {
        // If discovery fails (no_workspace_ever_opened, registry_missing, etc.)
        // Antigravity is not running or never ran
        log(`isAntigravityRunning check: ${error.message}`);
        return false;
    }
}
```

**Step 2: 验证函数逻辑**

手动测试逻辑（无需自动化测试，因为依赖真实 Antigravity 进程）：

1. 确保 Antigravity 未运行
2. 调用 `isAntigravityRunning()` 应返回 `false`
3. 启动 Antigravity
4. 调用 `isAntigravityRunning()` 应返回 `true`

**Step 3: 提交**

```bash
git add packages/sidecar/server-runtime/dist/index.js
git commit -m "feat(server): add isAntigravityRunning detection

- Use discoverCDP to check if Antigravity is running
- Cross-platform detection without platform-specific commands
- Returns false if no ready CDP endpoint found"
```

---

## Task 3: 重构 Server 的 handleLaunchAntigravity 使用 Worker

**Files:**
- Modify: `packages/sidecar/server-runtime/dist/index.js:850-950` (handleLaunchAntigravity)
- Modify: `packages/sidecar/server-runtime/dist/launch-antigravity.js:188-315` (标记为 deprecated)

**Step 1: 重写 handleLaunchAntigravity 函数**

替换现有的 `handleLaunchAntigravity` 实现：

```javascript
async function handleLaunchAntigravity(args) {
    const { targetDir, waitForCdp = true } = args;

    if (!targetDir) {
        throw new Error('targetDir is required for launch-antigravity');
    }

    // 1. Check if Antigravity is already running
    log('Checking if Antigravity is already running...');
    const isRunning = await isAntigravityRunning();

    if (isRunning) {
        throw new Error(
            'Antigravity is already running. ' +
            'Close it first or use a restart mechanism if available.'
        );
    }

    log('Antigravity is not running, proceeding with cold start...');

    // 2. Resolve executable and port
    const executable = resolveAntigravityExecutable();
    if (!executable) {
        throw new Error('Antigravity executable not found. Set ANTIGRAVITY_EXECUTABLE environment variable.');
    }

    const bindAddress = resolveCdpBindAddress();
    const preferredPort = resolveLaunchPort();
    const port = await allocateAvailablePort(bindAddress, preferredPort);

    if (port == null) {
        throw new Error(`All CDP ports ${CDP_PORT_RANGE_MIN}-${CDP_PORT_RANGE_MAX} are occupied on ${bindAddress}.`);
    }

    log(`Allocated CDP port: ${port}`);

    // 3. Prepare worker arguments
    const workerPath = path.join(__dirname, '../scripts/restart-worker.js');
    const configDir = path.join(os.homedir(), '.config', 'antigravity-mcp');

    const workerArgs = [
        '--workspace', targetDir,
        '--antigravity-path', executable,
        '--port', String(port),
        '--bind-address', bindAddress,
        '--config-dir', configDir,
        '--request-id', `cold-start-${Date.now()}`,
        '--cold-start',
        '--wait-for-cdp', String(waitForCdp),
    ];

    // Add extra args from environment
    const extraArgs = process.env.ANTIGRAVITY_LAUNCH_EXTRA_ARGS?.trim();
    if (extraArgs) {
        for (const arg of extraArgs.split(/\s+/).filter(Boolean)) {
            workerArgs.push('--extra-arg', arg);
        }
    }

    // 4. Launch worker
    log(`Launching restart-worker in cold-start mode...`);
    log(`Worker path: ${workerPath}`);
    log(`Worker args: ${workerArgs.join(' ')}`);

    const { spawn } = await import('child_process');
    const workerProcess = spawn('node', [workerPath, ...workerArgs], {
        detached: true,
        stdio: 'ignore',
    });
    workerProcess.unref();

    log(`Cold start worker launched: PID=${workerProcess.pid} port=${port} workspace=${targetDir}`);

    // 5. Return result
    return JSON.stringify({
        started: true,
        executable,
        port,
        bindAddress,
        mode: 'cold-start',
        workerPid: workerProcess.pid,
        message: `Antigravity cold start initiated on port ${port}. Check ~/.config/antigravity-mcp/restart-worker.log for details.`,
    }, null, 2);
}
```

**Step 2: 添加必要的 import**

在文件顶部确保有这些 import：

```javascript
import path from "path";
import os from "os";
import { resolveAntigravityExecutable } from "@antigravity-mcp/core";
```

如果 `resolveCdpBindAddress`, `resolveLaunchPort`, `allocateAvailablePort` 不在当前文件，需要从 `launch-antigravity.js` 导入：

```javascript
import {
    resolveCdpBindAddress,
    resolveLaunchPort,
    allocateAvailablePort
} from "./launch-antigravity.js";
```

**Step 3: 在 launch-antigravity.js 中标记旧函数为 deprecated**

在 `launchAntigravityForWorkspace` 函数顶部添加注释：

```javascript
/**
 * @deprecated This function is deprecated. Use restart-worker.js via handleLaunchAntigravity instead.
 *
 * This function previously handled launch in-process, which had self-kill risks.
 * New architecture delegates to external restart-worker for all launch operations.
 */
export async function launchAntigravityForWorkspace(params) {
    // ... existing implementation ...
}
```

**Step 4: 提交**

```bash
git add packages/sidecar/server-runtime/dist/index.js packages/sidecar/server-runtime/dist/launch-antigravity.js
git commit -m "refactor(server): delegate launch to restart-worker

- Check if Antigravity is running before launch
- Launch restart-worker with --cold-start for cold start
- Return error if already running
- Mark old launchAntigravityForWorkspace as deprecated"
```

---

## Task 4: 更新 Server 的 TypeScript 类型定义

**Files:**
- Modify: `packages/sidecar/server-runtime/src/index.ts` (如果存在)
- Modify: `packages/sidecar/server-runtime/src/launch-antigravity.ts` (如果存在)

**Note:** 如果项目使用 TypeScript 源码编译到 dist，需要更新 .ts 文件而不是 .js 文件。

**Step 1: 检查是否有 TypeScript 源码**

```bash
ls packages/sidecar/server-runtime/src/
```

**Step 2: 如果有 TypeScript 源码**

重复 Task 2 和 Task 3 的修改，但在 `.ts` 文件中进行，并添加类型注解：

```typescript
async function isAntigravityRunning(): Promise<boolean> {
    try {
        const result = await discoverCDP({
            targetDir: undefined,
            timeoutMs: 3000
        });
        return result.success === true;
    } catch (error) {
        log(`isAntigravityRunning check: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
```

**Step 3: 重新编译**

```bash
cd packages/sidecar/server-runtime
npm run build
```

**Step 4: 提交**

```bash
git add packages/sidecar/server-runtime/src/ packages/sidecar/server-runtime/dist/
git commit -m "refactor(server): update TypeScript sources for worker delegation"
```

**Note:** 如果没有 TypeScript 源码，跳过此 Task。

---

## Task 5: 测试 Server 冷启动流程

**Files:**
- Create: `packages/sidecar/test/server-cold-start.test.mjs`

**Step 1: 创建集成测试**

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

describe('Server cold-start integration', () => {
    let serverProcess;

    before(async () => {
        // Note: This test requires manual setup:
        // 1. Ensure Antigravity is NOT running
        // 2. Set ANTIGRAVITY_EXECUTABLE environment variable
        console.log('Integration test requires manual setup - see test file comments');
    });

    after(async () => {
        if (serverProcess) {
            serverProcess.kill();
        }
    });

    it('should reject launch when Antigravity is already running', async () => {
        // This test is manual - requires Antigravity to be running
        // Expected behavior: launch-antigravity tool returns error
        console.log('Manual test: Start Antigravity, then call launch-antigravity tool');
        console.log('Expected: Error "Antigravity is already running"');
    });

    it('should launch via worker when Antigravity is not running', async () => {
        // This test is manual - requires Antigravity to be stopped
        // Expected behavior: launch-antigravity tool starts worker, Antigravity launches
        console.log('Manual test: Stop Antigravity, then call launch-antigravity tool');
        console.log('Expected: Worker starts, Antigravity launches with CDP');
    });
});
```

**Step 2: 添加手动测试说明**

创建 `packages/sidecar/docs/testing-cold-start.md`：

```markdown
# Testing Server Cold Start

## Prerequisites

1. Set environment variable:
   ```bash
   export ANTIGRAVITY_EXECUTABLE=/path/to/Antigravity.app/Contents/MacOS/Antigravity
   ```

2. Ensure MCP server is running

## Test Case 1: Cold Start (Antigravity Not Running)

1. Ensure Antigravity is NOT running:
   ```bash
   pkill -f Antigravity
   ```

2. Call launch-antigravity tool via MCP client:
   ```json
   {
     "tool": "launch-antigravity",
     "arguments": {
       "targetDir": "/path/to/workspace",
       "waitForCdp": true
     }
   }
   ```

3. Expected result:
   - Worker starts (check `~/.config/antigravity-mcp/restart-worker.log`)
   - Antigravity launches
   - CDP becomes available
   - Tool returns success with port number

## Test Case 2: Already Running (Should Reject)

1. Ensure Antigravity IS running

2. Call launch-antigravity tool via MCP client

3. Expected result:
   - Tool returns error: "Antigravity is already running"
   - No worker is started
   - Existing Antigravity instance is not affected

## Verification

Check worker log:
```bash
tail -f ~/.config/antigravity-mcp/restart-worker.log
```

Check worker status:
```bash
cat ~/.config/antigravity-mcp/restart-status.json
```

Check worker result:
```bash
cat ~/.config/antigravity-mcp/restart-result.json
```
```

**Step 3: 提交**

```bash
git add packages/sidecar/test/server-cold-start.test.mjs packages/sidecar/docs/testing-cold-start.md
git commit -m "test(server): add cold-start integration test and manual test guide"
```

---

## Task 6: 更新文档和 README

**Files:**
- Modify: `packages/sidecar/server-runtime/README.md`
- Modify: `packages/sidecar/README.md`

**Step 1: 更新 server-runtime README**

在 `packages/sidecar/server-runtime/README.md` 中添加 launch-antigravity 工具说明：

```markdown
## Tools

### launch-antigravity

Launches Antigravity in cold-start mode (when not already running).

**Parameters:**
- `targetDir` (string, required): Workspace directory to open
- `waitForCdp` (boolean, optional, default: true): Wait for CDP to be ready
- `killExisting` (boolean, deprecated): No longer used, kept for compatibility

**Behavior:**
1. Checks if Antigravity is already running via CDP discovery
2. If running: Returns error "Antigravity is already running"
3. If not running: Launches restart-worker in cold-start mode
4. Worker handles: port allocation → launch → CDP verification

**Returns:**
```json
{
  "started": true,
  "executable": "/path/to/Antigravity",
  "port": 9001,
  "bindAddress": "127.0.0.1",
  "mode": "cold-start",
  "workerPid": 12345,
  "message": "Antigravity cold start initiated on port 9001..."
}
```

**Error Cases:**
- Antigravity already running
- Executable not found (set ANTIGRAVITY_EXECUTABLE)
- All CDP ports occupied

**Architecture:**
- Server detects state, delegates execution to restart-worker
- Worker writes logs to `~/.config/antigravity-mcp/restart-worker.log`
- Worker writes status to `~/.config/antigravity-mcp/restart-status.json`
```

**Step 2: 更新 sidecar README**

在 `packages/sidecar/README.md` 中更新 restart-worker 说明：

```markdown
## Scripts

### restart-worker.js

Handles all Antigravity launch and restart operations.

**Modes:**

1. **Cold Start** (`--cold-start` flag):
   - Skips kill and wait phases
   - Directly launches Antigravity with CDP
   - Used by MCP server for initial launch

2. **Hot Restart** (default):
   - Kills existing Antigravity process
   - Waits for process to exit
   - Launches new Antigravity with CDP
   - Used by Sidecar restart command

**Parameters:**
- `--workspace <path>`: Workspace directory
- `--antigravity-path <path>`: Antigravity executable path
- `--port <port>`: CDP port to use
- `--bind-address <host>`: CDP bind address (default: 127.0.0.1)
- `--config-dir <dir>`: Config directory for status files
- `--request-id <id>`: Unique request identifier
- `--cold-start`: Enable cold-start mode (skip kill/wait)
- `--wait-for-cdp <true|false>`: Wait for CDP verification
- `--extra-arg <value>`: Additional Antigravity arguments (repeatable)

**Output Files:**
- `~/.config/antigravity-mcp/restart-status.json`: Real-time status
- `~/.config/antigravity-mcp/restart-result.json`: Final result
- `~/.config/antigravity-mcp/restart-worker.log`: Detailed logs
```

**Step 3: 提交**

```bash
git add packages/sidecar/server-runtime/README.md packages/sidecar/README.md
git commit -m "docs: update README for cold-start architecture

- Document launch-antigravity tool behavior
- Document restart-worker cold-start mode
- Add architecture notes and output file locations"
```

---

## Task 7: 运行完整测试套件

**Step 1: 运行所有测试**

```bash
npm test
```

Expected: All tests pass

**Step 2: 检查语法**

```bash
cd packages/sidecar && node -c scripts/restart-worker.js
cd packages/sidecar/server-runtime && node -c dist/index.js
```

Expected: No syntax errors

**Step 3: 如果有失败，修复并重新测试**

根据测试输出修复问题，然后重新运行测试。

**Step 4: 提交（如果有修复）**

```bash
git add <fixed-files>
git commit -m "fix: resolve test failures"
```

---

## Task 8: 手动验证完整流程

**Step 1: 验证冷启动**

1. 确保 Antigravity 未运行：
   ```bash
   pkill -f Antigravity
   ```

2. 通过 MCP 调用 launch-antigravity（需要 MCP 客户端）

3. 验证：
   - Worker 日志显示 "Mode: cold-start"
   - Antigravity 启动
   - CDP 可用

**Step 2: 验证已运行拒绝**

1. 保持 Antigravity 运行

2. 再次调用 launch-antigravity

3. 验证：
   - 返回错误 "Antigravity is already running"
   - 没有新的 worker 启动
   - 现有 Antigravity 不受影响

**Step 3: 验证 Sidecar 热重启**

1. 在 Antigravity 中打开 Sidecar

2. 执行命令：`Sidecar: Restart Antigravity`

3. 验证：
   - Worker 日志显示 "Mode: restart"
   - 旧窗口关闭
   - 新窗口启动
   - CDP 可用

**Step 4: 记录验证结果**

创建 `docs/plans/2026-03-09-launch-restart-verification.md`：

```markdown
# Launch/Restart 职责划分验证结果

## 测试日期
[填写日期]

## 测试环境
- OS: [macOS/Windows/Linux]
- Antigravity 版本: [版本号]
- Node.js 版本: [版本号]

## 测试结果

### 1. Server 冷启动
- [ ] Antigravity 未运行时可以启动
- [ ] Worker 日志显示 cold-start 模式
- [ ] Antigravity 成功启动
- [ ] CDP 可用

### 2. Server 已运行拒绝
- [ ] 返回错误信息
- [ ] 没有启动新 worker
- [ ] 现有实例不受影响

### 3. Sidecar 热重启
- [ ] 旧窗口关闭
- [ ] 新窗口启动
- [ ] CDP 可用
- [ ] Worker 日志显示 restart 模式

## 问题记录
[记录遇到的任何问题]

## 结论
[通过/失败]
```

**Step 5: 提交验证文档**

```bash
git add docs/plans/2026-03-09-launch-restart-verification.md
git commit -m "docs: add launch/restart verification results"
```

---

## Task 9: 清理和最终提交

**Step 1: 检查是否有未提交的文件**

```bash
git status
```

**Step 2: 清理临时文件**

```bash
# 删除测试生成的临时文件
rm -f ~/.config/antigravity-mcp/restart-*.json
rm -f ~/.config/antigravity-mcp/restart-worker.log
```

**Step 3: 更新版本号（如果需要）**

在 `packages/sidecar/package.json` 和 `packages/server/package.json` 中更新版本号。

**Step 4: 创建最终提交**

```bash
git add -A
git commit -m "feat: implement launch/restart responsibility separation

Complete implementation of design from 2026-03-09-launch-restart-responsibility-design.md

Changes:
- restart-worker: Add --cold-start mode to skip kill/wait phases
- server: Delegate launch to restart-worker after checking if running
- server: Use discoverCDP for cross-platform detection
- docs: Update README and add testing guides
- tests: Add cold-start parameter parsing tests

This unifies all launch/restart logic in restart-worker and eliminates
code duplication between server and sidecar implementations."
```

**Step 5: 推送到远程（如果需要）**

```bash
git push origin main
```

---

## 完成检查清单

- [ ] restart-worker 支持 --cold-start 参数
- [ ] restart-worker 在冷启动模式跳过 kill/wait
- [ ] Server 添加 isAntigravityRunning 检测
- [ ] Server handleLaunchAntigravity 使用 worker
- [ ] Server 已运行时返回错误
- [ ] TypeScript 类型定义已更新（如果适用）
- [ ] 测试通过
- [ ] 文档已更新
- [ ] 手动验证通过
- [ ] 所有变更已提交

---

## 故障排查

### Worker 启动失败

检查：
- `restart-worker.js` 是否有执行权限
- Node.js 是否在 PATH 中
- 参数是否正确传递

查看日志：
```bash
tail -f ~/.config/antigravity-mcp/restart-worker.log
```

### CDP 验证失败

检查：
- 端口是否被占用
- 防火墙是否阻止连接
- Antigravity 是否真的启动了

### Server 检测错误

检查：
- Registry 文件是否存在
- discoverCDP 是否正常工作
- 超时设置是否合理

---

## 参考资料

- 设计文档: `docs/plans/2026-03-09-launch-restart-responsibility-design.md`
- Restart Worker 设计: `docs/plans/2026-03-09-restart-worker-design.md`
- 测试指南: `packages/sidecar/docs/testing-cold-start.md`
