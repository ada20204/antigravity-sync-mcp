# Launch/Restart 职责划分设计

## 背景

当前系统中存在多个 launch/restart 路径：

1. **Sidecar Extension Restart** → `restart-worker.js` (外部 worker)
2. **MCP Server Launch** → `launchAntigravityForWorkspace` (server 内部)
3. **Switch Worker** → `switch-worker.js` phase3_restart (外部 worker)

这些路径存在职责不清晰和代码重复的问题。特别是 server 的 `launchAntigravityForWorkspace` 在进程内部执行 kill + launch，存在潜在的 self-kill 风险。

## 目标

明确 launch/restart 的职责划分：
- Server 负责冷启动（Antigravity 未运行时）
- Worker 负责热重启（Antigravity 已运行时）
- 统一 launch 逻辑，避免代码重复

## 核心原则

**按场景复杂度划分职责**：
- **简单场景（冷启动）**：无需 kill，直接 launch
- **复杂场景（热重启）**：需要 kill → wait → launch 状态机

**统一实现**：
- 所有 launch 逻辑统一在 `restart-worker.js` 中实现
- Server 和 Sidecar 都通过启动 worker 来执行 launch/restart

## 职责划分

### Server 的 `launch-antigravity` 工具

**职责**：检测状态 + 启动 worker（冷启动模式）

**流程**：
1. 检测 Antigravity 是否运行（通过 `discoverCDP`）
2. 如果未运行 → 启动 `restart-worker.js --cold-start`
3. 如果已运行 → 返回错误："Antigravity is already running"

**检测方法**（跨平台）：
```javascript
async function isAntigravityRunning() {
    try {
        const result = await discoverCDP({ targetDir: undefined });
        return result.success === true;
    } catch (error) {
        return false;
    }
}
```

**优点**：
- 复用现有 CDP 发现逻辑
- 完全跨平台（无需 pgrep/tasklist）
- 同时检查 registry 和 CDP 可用性

### Restart Worker (`restart-worker.js`)

**职责**：统一处理所有 launch/restart 场景

**支持模式**：
- **冷启动模式** (`--cold-start` 参数存在)：跳过 kill/wait，直接 launch
- **热重启模式** (默认)：完整的 kill → wait → launch → verify CDP

**参数设计**：

新增参数：
- `--cold-start`：布尔标志，表示冷启动模式

现有参数（保持不变）：
- `--workspace <path>`
- `--antigravity-path <path>`
- `--port <port>`
- `--bind-address <host>`
- `--request-id <id>`
- `--config-dir <dir>`
- `--wait-for-cdp <true|false>`
- `--extra-arg <value>`（可重复）

**Phase 流程**：

冷启动模式：
1. ~~Phase 1: Kill old process~~ (跳过)
2. ~~Phase 2: Wait for exit~~ (跳过)
3. Phase 3: Launch new process
4. Phase 4: Verify CDP

热重启模式：
1. Phase 1: Kill old process
2. Phase 2: Wait for exit
3. Phase 3: Launch new process
4. Phase 4: Verify CDP

**状态文件**：
- `restart-status.json` - 实时状态
- `restart-result.json` - 最终结果
- `restart-worker.log` - 详细日志

Phase 名称在冷启动模式下：
- `starting` → `launching_new_process` → `waiting_for_cdp` → `complete`

### Sidecar Extension Restart

**职责**：用户手动重启命令

**流程**：
- 启动 `restart-worker.js`（默认热重启模式，无 `--cold-start` 参数）

**保持现状**：
- 已在前一个 commit 中实现外部化
- 无需修改

### Switch Worker (`switch-worker.js`)

**职责**：账号切换专用（数据库修改 + 重启）

**重启部分**：
- Phase 3 调用 restart primitive
- 保持现状，暂不修改

**未来优化**：
- 可以考虑让 switch-worker 也调用 restart-worker
- 但当前不是优先级

## 实现变更

### 1. 修改 `restart-worker.js`

**新增冷启动模式支持**：

```javascript
function getColdStart() {
    return parsedArgs['cold-start'] !== undefined;
}

async function main() {
    validateArgs();
    const coldStart = getColdStart();

    log('=== Antigravity Restart Worker Started ===');
    log(`Mode: ${coldStart ? 'cold-start' : 'restart'}`);
    // ...

    try {
        if (!coldStart) {
            await phase1_killOldProcess();
            await phase2_waitForExit();
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
        log('=== Operation completed successfully ===');
        process.exit(0);
    } catch (error) {
        clearTimeout(absoluteTimeout);
        exitWithError('unknown', error.message);
    }
}
```

### 2. 修改 Server `launch-antigravity` 工具

**新实现**：

```javascript
async function handleLaunchAntigravity(args) {
    const { targetDir, waitForCdp = true } = args;

    // 1. 检测 Antigravity 是否运行
    const isRunning = await isAntigravityRunning();

    if (isRunning) {
        throw new Error(
            'Antigravity is already running. ' +
            'Close it first or use a restart mechanism if available.'
        );
    }

    // 2. 准备参数
    const executable = resolveAntigravityExecutable();
    if (!executable) {
        throw new Error('Antigravity executable not found. Set ANTIGRAVITY_EXECUTABLE.');
    }

    const bindAddress = resolveCdpBindAddress();
    const preferredPort = resolveLaunchPort();
    const port = await allocateAvailablePort(bindAddress, preferredPort);

    if (port == null) {
        throw new Error(`All CDP ports ${CDP_PORT_RANGE_MIN}-${CDP_PORT_RANGE_MAX} are occupied.`);
    }

    // 3. 启动 restart-worker (冷启动模式)
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

    // Add extra args from env
    const extraArgs = process.env.ANTIGRAVITY_LAUNCH_EXTRA_ARGS?.trim();
    if (extraArgs) {
        for (const arg of extraArgs.split(/\s+/).filter(Boolean)) {
            workerArgs.push('--extra-arg', arg);
        }
    }

    const workerProcess = spawn('node', [workerPath, ...workerArgs], {
        detached: true,
        stdio: 'ignore',
    });
    workerProcess.unref();

    log(`Cold start worker launched: port=${port} workspace=${targetDir}`);

    // 4. 返回结果
    return JSON.stringify({
        started: true,
        executable,
        port,
        mode: 'cold-start',
        message: `Antigravity cold start initiated on port ${port}. Worker PID: ${workerProcess.pid}`,
    }, null, 2);
}

async function isAntigravityRunning() {
    try {
        const result = await discoverCDP({ targetDir: undefined });
        return result.success === true;
    } catch (error) {
        return false;
    }
}
```

### 3. 移除 Server 内部的 launch 逻辑

**当前的 `launchAntigravityForWorkspace` 函数**：
- 保留函数签名（向后兼容）
- 内部改为调用新的 `handleLaunchAntigravity`
- 或者直接废弃，只保留新的实现

## 测试策略

### 单元测试

**restart-worker.js**：
- 测试 `--cold-start` 参数解析
- 测试冷启动模式跳过 kill/wait phase
- 测试热重启模式执行完整 phase

**server launch-antigravity**：
- Mock `isAntigravityRunning` 返回 false，验证启动 worker
- Mock `isAntigravityRunning` 返回 true，验证返回错误

### 集成测试

**冷启动场景**：
1. 确保 Antigravity 未运行
2. 调用 `launch-antigravity` 工具
3. 验证 worker 启动
4. 验证 Antigravity 启动成功
5. 验证 CDP 可用

**热重启场景**：
1. 启动 Antigravity
2. 调用 `launch-antigravity` 工具
3. 验证返回错误（已运行）

**Sidecar restart**：
1. 启动 Antigravity
2. 执行 `Sidecar: Restart Antigravity`
3. 验证旧窗口关闭
4. 验证新窗口启动
5. 验证 CDP 可用

### 手动验证

**Server 冷启动**：
```bash
# 确保 Antigravity 未运行
# 通过 MCP 调用 launch-antigravity
# 验证 Antigravity 启动并且 CDP 可用
```

**Server 热启动拒绝**：
```bash
# 启动 Antigravity
# 通过 MCP 调用 launch-antigravity
# 验证返回错误："Antigravity is already running"
```

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Launch/Restart 架构                      │
└─────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐
│  MCP Server      │         │  Sidecar Ext     │
│  launch-antigrav │         │  Restart Command │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │ 1. Check running           │ (always restart)
         │    (discoverCDP)           │
         │                            │
         ├─ Not running ──────────────┼─ Running ─────┐
         │                            │               │
         │ 2. Launch worker           │ 2. Launch     │
         │    --cold-start            │    worker     │
         │                            │               │
         └────────┬───────────────────┴───────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │  restart-worker.js │
         └────────────────────┘
                  │
         ┌────────┴────────┐
         │                 │
    --cold-start      (default)
         │                 │
         │                 ▼
         │        ┌─────────────────┐
         │        │ Phase 1: Kill   │
         │        └────────┬────────┘
         │                 │
         │                 ▼
         │        ┌─────────────────┐
         │        │ Phase 2: Wait   │
         │        └────────┬────────┘
         │                 │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ Phase 3: Launch │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ Phase 4: Verify │
         │      CDP        │
         └─────────────────┘
```

## 优点

1. **职责清晰**：Server 负责检测，Worker 负责执行
2. **代码复用**：所有 launch 逻辑统一在 worker 中
3. **跨平台**：使用 discoverCDP 检测，无需平台特定代码
4. **可测试**：Worker 可独立测试，Server 逻辑简单
5. **一致性**：Sidecar 和 Server 都通过 worker 执行 launch

## 缺点与权衡

1. **冷启动也走 worker**：增加一层间接性
   - 权衡：换取代码复用和架构一致性

2. **Server 不能强制重启**：已运行时返回错误
   - 权衡：避免 server 执行危险的 kill 操作
   - 用户可以手动关闭 Antigravity 后重试

3. **Worker 逻辑变复杂**：需要支持两种模式
   - 权衡：通过清晰的 phase 跳过逻辑保持可维护性

## 后续演进

### 第一阶段（本次实施）
- 修改 `restart-worker.js` 支持 `--cold-start`
- 修改 Server `launch-antigravity` 使用 worker
- 测试验证

### 第二阶段（未来优化）
- 考虑让 `switch-worker.js` 也调用 `restart-worker.js`
- 统一所有 restart 逻辑

### 第三阶段（可选）
- 如果需要 Server 支持强制重启，可以：
  - 添加 `force-restart` 工具
  - 内部启动 `restart-worker.js`（热重启模式）

## 结论

采用"Server 检测 + Worker 统一执行"的架构：
- Server 负责冷启动场景的检测和委托
- Worker 统一处理所有 launch/restart 逻辑
- 通过 `--cold-start` 参数区分冷启动和热重启

这个方案在职责清晰、代码复用、跨平台支持之间取得了良好的平衡。
