# Antigravity MCP 心跳和超时机制分析

## 发现：已有完善的心跳和状态轮询机制！

### 当前实现

#### 1. 两阶段超时机制

```javascript
// Phase 1: 注入阶段（等待输入框就绪）
const INJECT_TIMEOUT_MS = 125000;  // 125秒（v3 优化后）
const result = await injectMessage(liveCdp, prompt, {
  maxWaitMs: 120000,  // 轮询等待 120秒
  pollIntervalMs: 500  // 每 500ms 检查一次
});

// Phase 2: 生成阶段（等待任务完成）
const MAX_TIMEOUT = 5 * 60 * 1000;  // 5分钟 = 300秒
while (true) {
  const elapsed = Date.now() - startTime;
  if (elapsed > MAX_TIMEOUT) {
    break;  // 超时退出
  }

  // 检查是否完成
  const status = await pollCompletionStatus(liveCdp);
  if (!status.isGenerating) {
    break;  // 完成退出
  }

  await sleep(POLL_INTERVAL);  // 500ms
}
```

#### 2. 心跳机制（Keepalive）

```javascript
const KEEPALIVE_INTERVAL = 25000;  // 25秒

// 每 25 秒发送进度通知
if (elapsed % KEEPALIVE_INTERVAL < POLL_INTERVAL) {
  progressCount = Math.min(progressCount + 5, 90);
  const msg = progressMessages[msgIdx % progressMessages.length];
  await sendProgressNotification(progressToken, progressCount, msg);
  msgIdx++;
}
```

**进度消息**：
- "🧠 Antigravity is analyzing your request..."
- "📊 Antigravity is processing and generating code..."
- "✨ Antigravity is writing changes..."
- "⏱️ Large task in progress (this is normal)..."
- "🔍 Still working... Antigravity takes time for quality results..."

#### 3. 状态轮询机制

```javascript
export async function pollCompletionStatus(cdp) {
  // 检查取消按钮是否可见
  const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancel && cancel.offsetParent !== null) {
    return { isGenerating: true };
  }

  // 备用：检查停止按钮
  const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
  if (stopBtn && stopBtn.offsetParent !== null) {
    return { isGenerating: true };
  }

  return { isGenerating: false };
}
```

**轮询频率**：每 500ms 检查一次

## 问题分析

### 当前配置

| 阶段 | 超时配置 | 说明 |
|------|---------|------|
| 注入阶段 | 120秒 | 等待输入框就绪 |
| 生成阶段 | 300秒 | 等待任务完成 |
| **总计** | **420秒** | **7分钟** |

### 支持的任务时长

- ✅ 简单问答：8-12 秒
- ✅ 代码分析：30-60 秒
- ✅ 标准图片生成：50-90 秒
- ✅ 复杂图片生成：90-180 秒
- ✅ 超复杂任务：180-300 秒
- ❌ **超长任务（>5分钟）**：会超时

### 用户需求

> "有没有可能任务时间还要久呢？我需要的是外部能够知道当前是工作状态就行了，没有查询机制或者心跳信号吗"

**答案**：
1. ✅ **已有心跳机制**：每 25 秒发送进度通知
2. ✅ **已有状态查询**：`pollCompletionStatus` 每 500ms 检查一次
3. ⚠️ **但有硬性超时**：5 分钟后强制退出

## 解决方案

### 方案 1：延长 MAX_TIMEOUT（简单直接）

修改生成阶段的最大超时：

```javascript
// 从 5 分钟延长到 30 分钟
const MAX_TIMEOUT = 30 * 60 * 1000;  // 1800秒
```

**优点**：
- 简单，一行修改
- 支持超长任务（最多 30 分钟）

**缺点**：
- 如果任务真的卡住，需要等很久才超时
- 浪费资源

### 方案 2：可配置超时（推荐）

允许用户根据任务类型配置超时：

```javascript
// 读取环境变量或配置
const MAX_TIMEOUT = process.env.ANTIGRAVITY_MAX_TIMEOUT
  ? parseInt(process.env.ANTIGRAVITY_MAX_TIMEOUT)
  : 5 * 60 * 1000;
```

**使用**：
```bash
# 设置 30 分钟超时
export ANTIGRAVITY_MAX_TIMEOUT=1800000

# 运行 MCP server
node ~/.config/antigravity-mcp/bin/antigravity-mcp-server
```

### 方案 3：无限超时 + 手动停止（最灵活）

完全依赖状态轮询，不设硬性超时：

```javascript
// 移除超时检查
while (true) {
  // 只检查是否完成
  const status = await pollCompletionStatus(liveCdp);
  if (!status.isGenerating) {
    break;
  }

  // 发送心跳
  if (elapsed % KEEPALIVE_INTERVAL < POLL_INTERVAL) {
    await sendProgressNotification(...);
  }

  await sleep(POLL_INTERVAL);
}
```

**优点**：
- 支持任意长度的任务
- 完全依赖实际状态，不会误判

**缺点**：
- 如果状态检测失败，可能永远不退出
- 需要用户手动停止卡住的任务

### 方案 4：智能超时（最佳实践）

根据任务类型和历史数据动态调整：

```javascript
function getMaxTimeout(prompt, history = {}) {
  const lowerPrompt = prompt.toLowerCase();

  // 超长任务：30 分钟
  if (lowerPrompt.includes('大规模') || lowerPrompt.includes('架构')) {
    return 30 * 60 * 1000;
  }

  // 复杂图片：15 分钟
  if (lowerPrompt.includes('生成') && lowerPrompt.includes('复杂')) {
    return 15 * 60 * 1000;
  }

  // 标准任务：5 分钟
  return 5 * 60 * 1000;
}
```

## 推荐实施方案

### 短期方案（立即可用）

**方案 1 + 方案 2 组合**：延长默认超时 + 支持环境变量配置

```bash
# 修改 optimize-timeouts-v4-unlimited.sh
sed -i '' \
  's/const MAX_TIMEOUT = 5 \* 60 \* 1000;/const MAX_TIMEOUT = process.env.ANTIGRAVITY_MAX_TIMEOUT ? parseInt(process.env.ANTIGRAVITY_MAX_TIMEOUT) : 30 * 60 * 1000;/' \
  "$DIST_DIR/index.js"
```

**配置建议**：
- 默认：30 分钟（适合大多数场景）
- 超长任务：60 分钟（通过环境变量）
- 无限超时：999999999（实际上依赖状态轮询）

### 长期方案（最佳实践）

**方案 4**：实施智能超时 + 任务类型检测

需要修改 MCP server 源码：
1. 添加 `getMaxTimeout` 函数
2. 根据 prompt 内容动态选择超时
3. 记录任务历史，优化超时预测

## 心跳和状态查询 API

### 当前可用的状态查询

MCP server 已经实现了完整的状态查询机制：

```javascript
// 1. 检查是否正在生成
const status = await pollCompletionStatus(cdp);
console.log(status.isGenerating);  // true/false

// 2. 获取进度通知（通过 LSP 协议）
// 客户端会收到 $/progress 通知
{
  token: "ask-antigravity-xxx",
  value: {
    kind: "report",
    percentage: 45,
    message: "🧠 Antigravity is analyzing your request..."
  }
}
```

### 外部查询机制

如果需要从外部查询任务状态，可以：

1. **通过 MCP 协议**：
   - 客户端订阅 `$/progress` 通知
   - 实时接收心跳和进度更新

2. **通过状态文件**（需要实现）：
   ```javascript
   // 在轮询循环中写入状态文件
   fs.writeFileSync('/tmp/antigravity-status.json', JSON.stringify({
     taskId: task.id,
     status: 'running',
     elapsed: elapsed,
     isGenerating: status.isGenerating,
     lastUpdate: Date.now()
   }));
   ```

3. **通过 HTTP 端点**（需要实现）：
   ```javascript
   // 添加 HTTP 服务器
   app.get('/status/:taskId', (req, res) => {
     const task = activeAskTasks.get(req.params.taskId);
     res.json({
       status: task?.status || 'not_found',
       elapsed: Date.now() - task?.startTime
     });
   });
   ```

## 实施步骤

### 立即实施（延长超时）

1. 创建 `optimize-timeouts-v4-unlimited.sh`：
```bash
#!/usr/bin/env bash
# 延长 MAX_TIMEOUT 到 30 分钟，支持环境变量配置

sed -i '' \
  's/const MAX_TIMEOUT = 5 \* 60 \* 1000;/const MAX_TIMEOUT = (process.env.ANTIGRAVITY_MAX_TIMEOUT ? parseInt(process.env.ANTIGRAVITY_MAX_TIMEOUT) : 30 * 60 * 1000);/' \
  "$DIST_DIR/index.js"
```

2. 应用优化：
```bash
bash .agents/skills/antigravity-mcp/scripts/optimize-timeouts-v4-unlimited.sh
```

3. 配置超时（可选）：
```bash
# 60 分钟超时
export ANTIGRAVITY_MAX_TIMEOUT=3600000

# 无限超时（实际上是 27 小时）
export ANTIGRAVITY_MAX_TIMEOUT=99999999
```

### 验证心跳机制

运行一个长任务，观察进度通知：

```bash
# 启动任务
python3 scripts/antigravity_cli.py ask "生成一个超级复杂的架构设计" &

# 观察日志（应该每 25 秒看到进度更新）
tail -f ~/.antigravity/logs/mcp-server.log
```

**预期输出**：
```
[task-xxx] Entering polling loop...
[task-xxx] Progress: 20% - 🧠 Antigravity is analyzing your request...
[task-xxx] Progress: 25% - 📊 Antigravity is processing and generating code...
[task-xxx] Progress: 30% - ✨ Antigravity is writing changes...
...
```

## 总结

### 当前状态

✅ **已有完善的心跳和状态轮询机制**：
- 心跳间隔：25 秒
- 状态检查：500ms
- 进度通知：通过 LSP `$/progress` 协议

✅ **已有两阶段超时**：
- 注入阶段：120 秒（轮询等待输入框）
- 生成阶段：300 秒（轮询等待完成）

⚠️ **限制**：
- 最大任务时长：7 分钟（420 秒）
- 不支持超长任务（>5 分钟生成时间）

### 推荐配置

**标准场景**（大多数用户）：
- 使用 v3 优化（120s 注入 + 300s 生成）
- 总计支持 7 分钟任务

**超长任务场景**：
- 使用 v4 优化（120s 注入 + 1800s 生成）
- 总计支持 32 分钟任务
- 或通过环境变量自定义

**无限任务场景**：
- 设置 `ANTIGRAVITY_MAX_TIMEOUT=99999999`
- 完全依赖状态轮询
- 需要手动停止卡住的任务

### 下一步

1. ✅ 创建 v4 优化脚本（延长 MAX_TIMEOUT）
2. ✅ 更新 README 说明心跳机制
3. ⏳ 测试超长任务（10+ 分钟）
4. ⏳ 考虑添加外部状态查询 API
