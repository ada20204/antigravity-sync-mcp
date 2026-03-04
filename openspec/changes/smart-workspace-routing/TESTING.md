# Smart Workspace Routing - 自动化测试

## 概述

本目录包含 Smart Workspace Routing 功能的自动化测试脚本和文档。

## 测试层级

### Level 1: 单元测试（Node.js Test Runner）

**位置**: `antigravity-mcp-server/test/*.test.mjs`

**运行方式**:
```bash
cd ~/antigravity-sync-mcp/antigravity-mcp-server
node --test test/*.mjs
```

**覆盖范围**:
- `cdp-discovery.test.mjs` - CDP 发现逻辑（8 个测试）
  - 空 registry 返回 `no_workspace_ever_opened`
  - 精确匹配设置 `matchMode: "exact"`
  - 回退匹配设置 `matchMode: "auto_fallback"`
  - 无 targetDir 时自动选择最佳 ready 条目
  - schema 版本不匹配
  - entry_not_ready / entry_stale 状态处理
  - original_workspace_id 匹配（远程镜像场景）

- `index-workspace-routing.test.mjs` - 工作区路由逻辑（5 个测试）
  - 不同 workspaceKey 的任务可并发
  - 多任务时 stop 需要 targetDir
  - targetDir 不匹配时 stop 不停止任何任务
  - `list-workspaces` 不建立 CDP 连接
  - `no_workspace_ever_opened` 不触发自动启动

- `integration-workspace-routing.test.mjs` - 集成测试（25 个测试）
  - CDP 发现的完整流程测试
  - 工作区路由的端到端验证
  - 多工作区优先级选择
  - 状态处理和错误码验证

**当前状态**: ✅ 所有 52 个单元测试通过

### Level 2: 集成测试（Mock Registry）

**脚本**: `integration-workspace-routing.test.mjs`

**特点**:
- 直接导入和测试 `cdp.js` 和 `index.js` 的导出函数
- 使用模拟的 registry 文件和 fetch 函数
- 无需真实 Antigravity 实例
- 快速验证核心逻辑

**运行方式**:
```bash
cd ~/antigravity-sync-mcp/antigravity-mcp-server
node test/integration-workspace-routing.test.mjs
```

**测试场景**:

#### 2.1 空 Registry 场景
- ✅ 空 registry 返回 `no_workspace_ever_opened`
- ✅ 只有 `__control__` 键的 registry
- ✅ 引导消息不包含 auto-launch

#### 2.2 单工作区场景
- ✅ 无 targetDir 时自动选择（auto_fallback）
- ✅ 精确匹配时使用 exact 模式
- ✅ targetDir 不匹配时回退到 ready 条目

#### 2.3 多工作区场景
- ✅ 选择高优先级 workspace
- ✅ 并发任务声明
- ✅ 同一 workspace 不能重复声明

#### 2.4 状态处理
- ✅ entry_not_ready 状态
- ✅ entry_stale 状态
- ✅ list-workspaces 不建立 CDP 连接

### Level 3: 端到端测试（真实 Antigravity）

**前置条件**:
- Antigravity 已安装
- antigravity-mcp-sidecar 已安装
- 至少一个测试项目目录

**手动测试步骤**:

#### 3.1 单窗口完整流程

1. **启动 Antigravity 并打开 workspace**
   ```bash
   open -a Antigravity ~/test-project-a
   ```

2. **验证 registry 已更新**
   ```bash
   cat ~/.config/antigravity-mcp/registry.json | jq 'keys'
   ```

3. **测试 ping 工具**
   ```bash
   cd ~/antigravity-sync-mcp/antigravity-mcp-server
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node build/dist/index.js
   ```

4. **测试 list-workspaces**
   - 应返回当前打开的 workspace 信息

5. **测试 ask-antigravity**（需要 CDP 可用）
   - 在 Antigravity 中看到消息注入
   - 返回 AI 响应

#### 3.2 多窗口并发流程

1. **启动两个 Antigravity 窗口**
   ```bash
   open -a Antigravity ~/test-project-a
   open -a Antigravity ~/test-project-b
   ```

2. **验证 registry 包含两个条目**
   ```bash
   cat ~/.config/antigravity-mcp/registry.json | jq 'keys | length'
   # 预期: >= 2
   ```

3. **测试精确路由**
   - 使用 targetDir 参数路由到特定窗口
   - 验证 matchMode 为 "exact"

4. **测试并发 ask-antigravity**
   - 向两个窗口同时发送消息
   - 验证无阻塞，都能成功

#### 3.3 首次使用流程

1. **清空 registry 模拟首次使用**
   ```bash
   cp ~/.config/antigravity-mcp/registry.json ~/.config/antigravity-mcp/registry.json.bak
   echo '{}' > ~/.config/antigravity-mcp/registry.json
   ```

2. **测试 ping 返回引导消息**
   - 应返回 `no_workspace_ever_opened`
   - 清晰的引导消息
   - 不尝试自动启动

3. **按引导打开 Antigravity**
   ```bash
   open -a Antigravity ~/test-project-a
   sleep 5
   ```

4. **再次测试 ping - 应该成功**

5. **恢复 registry**
   ```bash
   mv ~/.config/antigravity-mcp/registry.json.bak ~/.config/antigravity-mcp/registry.json
   ```

### Level 4: MCP 客户端集成测试

**目标**: 在真实 MCP 客户端（Claude Desktop）中验证

**配置文件**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "antigravity-test": {
      "command": "node",
      "args": [
        "/Users/elliot/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js"
      ]
    }
  }
}
```

**测试步骤**:

1. **重启 Claude Desktop**

2. **检查 MCP 工具是否加载**
   - 输入: "What MCP tools are available?"
   - 预期: 看到 `ask-antigravity`, `ping`, `list-workspaces`, `antigravity-stop`, `launch-antigravity`, `quota-status`

3. **测试 list-workspaces**
   - 输入: "List all Antigravity workspaces"
   - 预期: 返回当前打开的 workspace 列表

4. **测试 ask-antigravity**
   - 输入: "Use Antigravity to explain what is a closure in JavaScript"
   - 预期: Claude 调用工具并返回 Antigravity 的响应

5. **测试多窗口路由**
   - 打开两个 Antigravity 窗口
   - 输入: "List workspaces and then ask the first one to explain async/await"
   - 预期: 正确路由到指定窗口

## 快速运行所有测试

```bash
#!/bin/bash
# run-all-tests.sh

echo "=== Running Level 1: Unit Tests ==="
cd ~/antigravity-sync-mcp/antigravity-mcp-server
node --test test/*.mjs

echo ""
echo "=== Running Level 2: Integration Tests ==="
node test/integration-workspace-routing.test.mjs

echo ""
echo "=== All automated tests completed ==="
echo "For Level 3 and Level 4 tests, follow the manual steps in TEST_PLAN.md"
```

## 测试覆盖率

| 功能 | 单元测试 | 集成测试 | E2E 测试 |
|------|---------|---------|---------|
| 空 registry 处理 | ✅ | ✅ | ✅ |
| 精确匹配 (exact) | ✅ | ✅ | ✅ |
| 自动回退 (auto_fallback) | ✅ | ✅ | ✅ |
| 多工作区优先级 | ✅ | ✅ | ✅ |
| 并发任务隔离 | ✅ | ✅ | ⏳ |
| list-workspaces | ✅ | ✅ | ✅ |
| antigravity-stop | ✅ | ✅ | ⏳ |
| 状态处理 (not_ready/stale) | ✅ | ✅ | ✅ |
| 首次使用引导 | ✅ | ✅ | ✅ |

## 持续集成

如果项目使用 GitHub Actions，可以添加：

```yaml
# .github/workflows/test-workspace-routing.yml
name: Test Smart Workspace Routing

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: |
          cd antigravity-mcp-server
          npm install

      - name: Build
        run: |
          cd antigravity-mcp-server
          npm run build

      - name: Run unit tests
        run: |
          cd antigravity-mcp-server
          node --test test/*.mjs

      - name: Run integration tests
        run: |
          cd antigravity-mcp-server
          node test/integration-workspace-routing.test.mjs
```

## 测试结果示例

```
========================================
Smart Workspace Routing - Direct Test
========================================

========================================
Test Suite: CDP Discovery
========================================

[INFO] Test 1: Empty registry returns no_workspace_ever_opened
[PASS] Empty registry error code
[INFO] Test 2: Registry with only __control__ key
[PASS] Control-only registry error code
[INFO] Test 3: Single ready workspace without targetDir
[PASS] Discovery succeeded
[PASS] Match mode is auto_fallback
[PASS] Workspace key matches
...

========================================
Test Report
========================================

Total Tests: 25
Passed: 25
Failed: 0

[PASS] All tests passed! ✨
```

## 故障排查

### 测试失败常见原因

1. **构建产物不存在**
   ```bash
   cd ~/antigravity-sync-mcp/antigravity-mcp-server
   npm run build
   ```

2. **Node.js 版本过低**
   - 需要 Node.js >= 18.0.0
   ```bash
   node --version
   ```

3. **测试目录权限问题**
   ```bash
   chmod -R 755 ~/.config/antigravity-mcp-test
   ```

4. **Registry 文件被锁定**
   ```bash
   rm -rf ~/.config/antigravity-mcp-test
   ```

## 下一步

- [ ] 添加性能基准测试
- [ ] 添加压力测试（大量并发请求）
- [ ] 添加网络故障模拟测试
- [ ] 集成到 CI/CD 流程
- [ ] 添加测试覆盖率报告
