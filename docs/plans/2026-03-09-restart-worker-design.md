# Restart Antigravity 外部化为 restart-worker 设计

## 背景
当前 `Sidecar: Restart Antigravity` 路径由 sidecar 当前宿主直接执行 kill + relaunch：

- `packages/sidecar/src/commands/register-commands.js` 调用 `executeManualLaunch('restart')`
- `packages/sidecar/src/extension.js` 里直接调用 `restartAntigravity(...)`
- `packages/sidecar/src/services/launcher.js` 中的 `createRestartPrimitive()` 负责先 `pkill` 再 `launchDetached`

这种模型隐含一个脆弱前提：执行 `pkill` 的 sidecar 宿主在 kill 之后仍然存活，足以继续执行 launch。实际调试中已经出现“新窗口打开又关闭、CDP 仍 unavailable”的现象，说明当前 restart 流程存在 self-kill / kill-self-then-relaunch 竞态风险。

相比之下，现有 `switch-worker.js` 的思路更接近外部控制者模型：由 detached worker 独立完成等待、状态记录和后续动作。`Restart Antigravity` 应迁移到同类模式。

## 目标
将 `Sidecar: Restart Antigravity` 改为：

1. sidecar 命令层只负责确认、收集参数、提交 restart 请求
2. 新增 detached `packages/sidecar/scripts/restart-worker.js`
3. 由 worker 独立完成：
   - kill old Antigravity
   - wait for exit
   - launch new Antigravity
   - optional CDP readiness check
   - 状态与日志输出

这样可以：

- 避免 sidecar 当前宿主自杀式重启的不稳定性
- 让 restart 成为独立可测试单元
- 为 `Add Another Account` / `Switch Account` 后续统一到同一 restart 模型打基础

## 非目标
本次设计不包含：

- 把 `switch-worker.js` 改成多模式万能 worker
- 立即统一所有账号相关命令到 restart-worker
- 大规模重构 launcher / registry / status 体系

第一阶段仅迁移 `Restart Antigravity` 本身，后续再让账号类流程逐步复用。

## 推荐方案
采用独立 `restart-worker.js`，而不是把现有 `switch-worker.js` 扩展成多模式脚本。

原因：

- `switch-worker.js` 已绑定账号切换语义（target-email、backup-dir、modify_db 等）
- 普通 restart 不需要这些概念
- 强行塞多模式会让脚本职责混杂、测试边界变差

因此推荐：

- 新增 `restart-worker.js` 处理纯重启
- `switch-worker.js` 暂时保持账号切换专用
- 后续如有必要，再把 kill/wait/launch 的共享部分抽成 helper

## 架构设计

### 1. 命令层职责
`Restart Antigravity` 继续保留当前命令入口，但职责缩减为：

- 确认用户操作
- 校验 `workspacePath`
- 校验 `antigravityExecutablePath`
- 分配一个可用 CDP port
- 收集 bind address 和 extra args
- 启动 detached `restart-worker.js`
- 在 output channel 中写入 request accepted / worker started 信息

命令层不再直接执行：

- `pkill`
- `launchDetached`
- 本地 kill-then-launch 流程

### 2. Worker 层职责
新增：

- `packages/sidecar/scripts/restart-worker.js`

职责：

1. 参数解析与校验
2. 写入 worker 日志和状态
3. kill old Antigravity
4. 等待旧进程退出
5. 以 workspace + CDP args 启动新 Antigravity
6. 可选等待 `/json/version` 返回成功
7. 写 result/status 文件后退出

worker 应以 detached 独立进程方式启动，使其不依赖当前 sidecar 宿主在 restart 过程中的存活。

### 3. 启动参数
建议 `restart-worker.js` 接收以下参数：

- `--workspace <path>`
- `--antigravity-path <path>`
- `--port <port>`
- `--bind-address <host>`
- `--request-id <id>`
- `--config-dir <dir>`
- `--wait-for-cdp <true|false>`
- `--extra-arg <value>`（可重复）

最终由 worker 自己组装 launch args：

```bash
<antigravityExecutablePath> \
  <workspacePath> \
  --new-window \
  --remote-debugging-port=<port> \
  --remote-debugging-address=<bindAddress> \
  ...extraArgs
```

### 4. 状态与日志
建议新增 restart 专用文件：

- `restart-status.json`
- `restart-result.json`
- `restart-worker.log`

推荐 phase：

1. `starting`
2. `killing_old_process`
3. `waiting_for_exit`
4. `launching_new_process`
5. `waiting_for_cdp`
6. `complete`
7. `failed`

这样未来看到失败时，可以直接定位卡在哪一步，而不是只看到最终的 `CDP unavailable`。

## 与现有路径的关系

### 当前不稳定路径
`Restart Antigravity`：

- sidecar 当前宿主执行 kill
- sidecar 当前宿主执行 launch
- sidecar 当前宿主随后探测 CDP

风险在于：kill 与 launch 都依赖当前宿主本身活着。

### 新路径
`Restart Antigravity`：

- sidecar 当前宿主只负责启动 detached `restart-worker.js`
- `restart-worker.js` 执行 kill
- `restart-worker.js` 执行 launch
- sidecar 在后续阶段只负责重新探测 / 展示状态

这使得重启控制者从“正在被重启的宿主”转移为“外部 worker”。

## 测试策略
restart-worker 的独立化使测试边界明显改善。

### 单元测试
建议至少覆盖：

- 参数解析
- launch args 组装
- phase 流转
- kill → wait → launch 调用顺序
- timeout / launch failure / validation error 分支

### 集成测试
建议覆盖：

- `executeManualLaunch('restart')` 不再直接调用本地 `restartAntigravity(...)`
- sidecar 改为启动 `restart-worker.js`
- worker 作为独立脚本执行时，可以产出正确的 status/result/log 文件

### 手动验证
- 当前打开 Antigravity 时执行 `Sidecar: Restart Antigravity`
- 旧窗口退出
- 新窗口启动
- CDP ready
- output channel 不再出现原有的 self-kill 导致的不稳定行为

## 后续演进
第一阶段只落地 `Restart Antigravity`。

第二阶段可以让：

- `Sidecar: Add Another Account`
- `Sidecar: Switch Account`

也逐步统一复用 restart-worker 或共享 restart helper，从而使所有需要重启 Antigravity 的能力都采用外部控制者模型。

## 结论
采用新增独立 `restart-worker.js` 的方案，将 `Restart Antigravity` 从当前 sidecar 宿主直接 kill+launch 迁移到 detached worker 执行。

这是一个小范围但结构正确的修正：

- 解决当前 restart 流程的架构性不稳定点
- 提升可测试性
- 为后续账号流程统一 restart 模型创造条件
