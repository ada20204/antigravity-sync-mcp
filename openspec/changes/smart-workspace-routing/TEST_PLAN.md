# Smart Workspace Routing - 测试验证方案

## 测试目标

验证 MCP workspace 路由优化的三个核心改进：
1. **Workspace 自动发现回退** - targetDir 从必需精确匹配变为可选路由提示
2. **多工作区并发支持** - 不同 workspace 的任务可并行执行
3. **首次使用引导优化** - 空 registry 时提供清晰的人类可读提示

## 测试环境准备

### 前置条件

```bash
# 1. 构建 server
cd ~/antigravity-sync-mcp/antigravity-mcp-server
npm install
npm run build

# 2. 验证构建产物
ls -la build/dist/

# 3. 准备测试用 registry 目录
mkdir -p ~/.config/antigravity-mcp-test
```

### 环境变量配置

```bash
# 测试时使用独立的 registry 文件
export ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry.json
```

## 测试层级

### Level 1: 单元测试（已有）

**目标**: 验证核心逻辑的正确性，无需真实 Antigravity 实例

**执行方式**:
```bash
cd ~/antigravity-sync-mcp/antigravity-mcp-server
node --test test/*.mjs
```

**覆盖范围**:
- ✅ `cdp-discovery.test.mjs` - CDP 发现逻辑
  - 空 registry 返回 `no_workspace_ever_opened`
  - 精确匹配设置 `matchMode: "exact"`
  - 回退匹配设置 `matchMode: "auto_fallback"`
  - 无 targetDir 时自动选择最佳 ready 条目

- ✅ `index-workspace-routing.test.mjs` - 工作区路由逻辑
  - 不同 workspaceKey 的任务可并发
  - 多任务时 stop 需要 targetDir
  - targetDir 不匹配时 stop 不停止任何任务
  - `list-workspaces` 不建立 CDP 连接
  - `no_workspace_ever_opened` 不触发自动启动

**验证点**:
```bash
# 预期输出：所有测试通过
✔ discoverCDPDetailed returns no_workspace_ever_opened when registry file does not exist
✔ discoverCDPDetailed falls back to best ready entry when targetDir mismatches
✔ two concurrent workspace claims on different workspaceKeys both proceed
✔ antigravity-stop with multiple active tasks and no targetDir returns workspace ambiguity error
✔ list-workspaces returns registry entries without attempting CDP connection
```

### Level 2: 集成测试（Mock Registry）

**目标**: 验证 MCP 工具调用流程，使用模拟的 registry 数据

#### Test 2.1: 单工作区场景

**场景**: 用户只打开一个 Antigravity 窗口

**准备 registry**:
```bash
cat > ~/.config/antigravity-mcp-test/registry.json << 'EOF'
{
  "/Users/elliot/project-a": {
    "schema_version": 2,
    "workspace_id": "abc123def456",
    "workspace_paths": {
      "raw": "/Users/elliot/project-a",
      "normalized": "/Users/elliot/project-a"
    },
    "role": "host",
    "state": "ready",
    "verified_at": 1234567890000,
    "ttl_ms": 30000,
    "local_endpoint": {
      "host": "127.0.0.1",
      "port": 9222,
      "mode": "direct"
    },
    "quota": {
      "timestamp": 1234567890000,
      "promptCredits": {
        "remainingPercentage": 85
      },
      "models": [
        {"modelId": "gemini-3-flash-preview", "label": "Gemini 3 Flash"}
      ]
    }
  }
}
EOF
```

**测试用例**:

```bash
# TC 2.1.1: ping 工具 - 验证发现逻辑
echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出包含:
# - "matchMode": "auto_fallback" (因为没有提供 targetDir)
# - "workspaceKey": "abc123def456"
# - "state": "ready"

# TC 2.1.2: list-workspaces 工具
echo '{"method":"tools/call","params":{"name":"list-workspaces","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - workspaces 数组包含 1 个条目
# - workspacePath: "/Users/elliot/project-a"
# - state: "ready"
# - quotaSummary: "models=1, prompt=85%"
```

#### Test 2.2: 多工作区场景

**场景**: 用户同时打开两个 Antigravity 窗口

**准备 registry**:
```bash
cat > ~/.config/antigravity-mcp-test/registry-multi.json << 'EOF'
{
  "/Users/elliot/project-a": {
    "schema_version": 2,
    "workspace_id": "workspace-a-id",
    "workspace_paths": {"raw": "/Users/elliot/project-a"},
    "role": "host",
    "state": "ready",
    "verified_at": 1234567890000,
    "ttl_ms": 30000,
    "priority": 10,
    "local_endpoint": {"host": "127.0.0.1", "port": 9222, "mode": "direct"}
  },
  "/Users/elliot/project-b": {
    "schema_version": 2,
    "workspace_id": "workspace-b-id",
    "workspace_paths": {"raw": "/Users/elliot/project-b"},
    "role": "host",
    "state": "ready",
    "verified_at": 1234567890000,
    "ttl_ms": 30000,
    "priority": 5,
    "local_endpoint": {"host": "127.0.0.1", "port": 9223, "mode": "direct"}
  }
}
EOF
```

**测试用例**:

```bash
# TC 2.2.1: list-workspaces 显示多个工作区
echo '{"method":"tools/call","params":{"name":"list-workspaces","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-multi.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - workspaces 数组包含 2 个条目
# - 按 priority 排序（project-a 在前）

# TC 2.2.2: ping 不指定 targetDir - 自动选择最高优先级
echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-multi.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - "matchMode": "auto_fallback"
# - "workspaceKey": "workspace-a-id" (priority=10 更高)

# TC 2.2.3: ping 指定 targetDir - 精确匹配
echo '{"method":"tools/call","params":{"name":"ping","arguments":{"targetDir":"/Users/elliot/project-b"}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-multi.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - "matchMode": "exact"
# - "workspaceKey": "workspace-b-id"
```

#### Test 2.3: 空 Registry 场景

**场景**: 用户从未打开过 Antigravity workspace

**准备 registry**:
```bash
# 方式 1: 空文件
echo '{}' > ~/.config/antigravity-mcp-test/registry-empty.json

# 方式 2: 只有 control 键
cat > ~/.config/antigravity-mcp-test/registry-control-only.json << 'EOF'
{
  "__control__": {
    "ping": true
  }
}
EOF

# 方式 3: 文件不存在
rm -f ~/.config/antigravity-mcp-test/registry-missing.json
```

**测试用例**:

```bash
# TC 2.3.1: 空 registry - ping 返回引导消息
echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-empty.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - error.code: "no_workspace_ever_opened"
# - message 包含: "Open Antigravity"
# - message 包含: "authorization"
# - message 不包含: "auto-launch" 或 "launch antigravity"

# TC 2.3.2: registry 文件不存在
echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-missing.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出: 同 TC 2.3.1

# TC 2.3.3: list-workspaces 返回空列表
echo '{"method":"tools/call","params":{"name":"list-workspaces","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-empty.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - workspaces: []
# - message: "No workspace entries found in registry"
```

#### Test 2.4: Fallback 场景

**场景**: targetDir 不匹配，回退到最佳 ready 条目

**准备 registry**:
```bash
cat > ~/.config/antigravity-mcp-test/registry-fallback.json << 'EOF'
{
  "/Users/elliot/actual-workspace": {
    "schema_version": 2,
    "workspace_id": "actual-ws-id",
    "workspace_paths": {"raw": "/Users/elliot/actual-workspace"},
    "role": "host",
    "state": "ready",
    "verified_at": 1234567890000,
    "ttl_ms": 30000,
    "local_endpoint": {"host": "127.0.0.1", "port": 9222, "mode": "direct"}
  }
}
EOF
```

**测试用例**:

```bash
# TC 2.4.1: targetDir 不匹配 - 回退到 ready 条目
echo '{"method":"tools/call","params":{"name":"ping","arguments":{"targetDir":"/Users/elliot/wrong-path"}}}' | \
  ANTIGRAVITY_REGISTRY_FILE=~/.config/antigravity-mcp-test/registry-fallback.json \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

# 预期输出:
# - "matchMode": "auto_fallback"
# - "workspaceKey": "actual-ws-id"
# - 日志包含: "targetDir mismatch, falling back to best ready entry"
```

### Level 3: 端到端测试（真实 Antigravity）

**目标**: 在真实 Antigravity 环境中验证完整流程

**前置条件**:
- Antigravity 已安装并可启动
- antigravity-mcp-sidecar 已安装
- 至少有一个测试项目目录

#### Test 3.1: 单窗口完整流程

**步骤**:

1. **启动 Antigravity 并打开 workspace**
   ```bash
   # 打开测试项目
   open -a Antigravity ~/test-project-a
   ```

2. **等待 sidecar 写入 registry**
   ```bash
   # 检查 registry 是否已更新
   cat ~/.config/antigravity-mcp/registry.json | jq 'keys'

   # 预期: 包含 /Users/elliot/test-project-a 或类似路径
   ```

3. **测试 ping 工具**
   ```bash
   echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期:
   # - matchMode: "auto_fallback" (无 targetDir)
   # - state: "ready"
   # - 包含 CDP 端口信息
   ```

4. **测试 list-workspaces**
   ```bash
   echo '{"method":"tools/call","params":{"name":"list-workspaces","arguments":{}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期: 返回当前打开的 workspace 信息
   ```

5. **测试 ask-antigravity（需要 CDP 可用）**
   ```bash
   echo '{"method":"tools/call","params":{"name":"ask-antigravity","arguments":{"prompt":"Hello, test message"}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期:
   # - 在 Antigravity 中看到消息注入
   # - 返回 AI 响应
   # - 无错误
   ```

#### Test 3.2: 多窗口并发流程

**步骤**:

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

3. **测试 list-workspaces 显示多个**
   ```bash
   echo '{"method":"tools/call","params":{"name":"list-workspaces","arguments":{}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js | \
     jq '.workspaces | length'

   # 预期: 2
   ```

4. **测试精确路由到特定窗口**
   ```bash
   # 路由到 project-a
   echo '{"method":"tools/call","params":{"name":"ping","arguments":{"targetDir":"~/test-project-a"}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期: matchMode: "exact", workspaceKey 对应 project-a

   # 路由到 project-b
   echo '{"method":"tools/call","params":{"name":"ping","arguments":{"targetDir":"~/test-project-b"}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期: matchMode: "exact", workspaceKey 对应 project-b
   ```

5. **测试并发 ask-antigravity（需要脚本）**
   ```bash
   # 创建测试脚本
   cat > /tmp/test-concurrent.sh << 'EOF'
   #!/bin/bash

   # 向 project-a 发送消息（后台）
   echo '{"method":"tools/call","params":{"name":"ask-antigravity","arguments":{"prompt":"Test A","targetDir":"~/test-project-a"}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js &
   PID_A=$!

   # 向 project-b 发送消息（后台）
   echo '{"method":"tools/call","params":{"name":"ask-antigravity","arguments":{"prompt":"Test B","targetDir":"~/test-project-b"}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js &
   PID_B=$!

   # 等待两个任务完成
   wait $PID_A
   wait $PID_B

   echo "Both tasks completed"
   EOF

   chmod +x /tmp/test-concurrent.sh
   /tmp/test-concurrent.sh

   # 预期: 两个任务都成功完成，无阻塞
   ```

#### Test 3.3: 首次使用流程

**步骤**:

1. **清空 registry 模拟首次使用**
   ```bash
   # 备份现有 registry
   cp ~/.config/antigravity-mcp/registry.json ~/.config/antigravity-mcp/registry.json.bak

   # 清空 registry
   echo '{}' > ~/.config/antigravity-mcp/registry.json
   ```

2. **测试 ping 返回引导消息**
   ```bash
   echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期:
   # - error.code: "no_workspace_ever_opened"
   # - 清晰的引导消息
   # - 不尝试自动启动
   ```

3. **按引导打开 Antigravity**
   ```bash
   open -a Antigravity ~/test-project-a
   # 等待 sidecar 更新 registry
   sleep 5
   ```

4. **再次测试 ping - 应该成功**
   ```bash
   echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
     node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js

   # 预期: 成功返回 workspace 信息
   ```

5. **恢复 registry**
   ```bash
   mv ~/.config/antigravity-mcp/registry.json.bak ~/.config/antigravity-mcp/registry.json
   ```

### Level 4: MCP 客户端集成测试

**目标**: 在真实 MCP 客户端（Claude Desktop）中验证

#### Test 4.1: Claude Desktop 配置

**配置文件**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "antigravity-test": {
      "command": "node",
      "args": [
        "/Users/elliot/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js"
      ],
      "env": {
        "ANTIGRAVITY_REGISTRY_FILE": "/Users/elliot/.config/antigravity-mcp/registry.json"
      }
    }
  }
}
```

**测试步骤**:

1. **重启 Claude Desktop**
2. **检查 MCP 工具是否加载**
   - 在对话中输入: "What MCP tools are available?"
   - 预期看到: `ask-antigravity`, `ping`, `list-workspaces`, `antigravity-stop`, `launch-antigravity`, `quota-status`

3. **测试 list-workspaces**
   - 输入: "List all Antigravity workspaces"
   - 预期: 返回当前打开的 workspace 列表

4. **测试 ask-antigravity**
   - 输入: "Use Antigravity to explain what is a closure in JavaScript"
   - 预期:
     - Claude 调用 `ask-antigravity` 工具
     - 返回 Antigravity 的响应
     - 无错误

5. **测试多窗口路由**
   - 打开两个 Antigravity 窗口
   - 输入: "List workspaces and then ask the first one to explain async/await"
   - 预期: 正确路由到指定窗口

## 测试检查清单

### 功能验证

- [ ] **Workspace 自动发现**
  - [ ] 无 targetDir 时自动选择最佳 ready 条目
  - [ ] targetDir 不匹配时回退到最佳条目
  - [ ] targetDir 精确匹配时使用该条目
  - [ ] matchMode 正确标记（exact/auto_fallback）

- [ ] **多工作区支持**
  - [ ] 不同 workspace 的任务可并发执行
  - [ ] 同一 workspace 的任务串行执行
  - [ ] list-workspaces 显示所有条目
  - [ ] antigravity-stop 支持 targetDir 参数
  - [ ] 多任务时 stop 无 targetDir 返回错误

- [ ] **首次使用引导**
  - [ ] 空 registry 返回 no_workspace_ever_opened
  - [ ] 引导消息清晰易懂
  - [ ] 不触发自动启动
  - [ ] 打开 workspace 后正常工作

### 性能验证

- [ ] 单元测试执行时间 < 5 秒
- [ ] ping 工具响应时间 < 1 秒
- [ ] list-workspaces 响应时间 < 500ms
- [ ] 并发任务无明显延迟

### 兼容性验证

- [ ] 现有 targetDir 配置继续工作
- [ ] 旧版 registry 格式兼容
- [ ] 无 targetDir 的调用正常工作
- [ ] 单窗口场景无性能退化

## 测试报告模板

```markdown
# Smart Workspace Routing 测试报告

**测试日期**: YYYY-MM-DD
**测试人员**: [姓名]
**环境**: macOS [版本] / Node.js [版本]

## 测试结果汇总

| 测试级别 | 通过 | 失败 | 跳过 | 总计 |
|---------|------|------|------|------|
| Level 1: 单元测试 | X | X | X | X |
| Level 2: 集成测试 | X | X | X | X |
| Level 3: 端到端测试 | X | X | X | X |
| Level 4: 客户端集成 | X | X | X | X |

## 详细测试结果

### Level 1: 单元测试

```
✔ discoverCDPDetailed returns no_workspace_ever_opened when registry file does not exist
✔ discoverCDPDetailed falls back to best ready entry when targetDir mismatches
...
```

### Level 2: 集成测试

**TC 2.1.1**: ✅ PASS
- 输出: [实际输出]
- 验证: matchMode 正确

**TC 2.1.2**: ✅ PASS
...

### 发现的问题

1. **[问题标题]**
   - 严重程度: High/Medium/Low
   - 描述: [详细描述]
   - 复现步骤: [步骤]
   - 预期行为: [预期]
   - 实际行为: [实际]

## 结论

- [ ] 所有核心功能正常
- [ ] 性能符合预期
- [ ] 兼容性良好
- [ ] 建议发布

**备注**: [其他说明]
```

## 自动化测试脚本

创建一个自动化测试脚本方便快速验证：

```bash
#!/bin/bash
# test-smart-workspace-routing.sh

set -e

echo "=== Smart Workspace Routing Test Suite ==="
echo ""

# Level 1: 单元测试
echo "▶ Level 1: Running unit tests..."
cd ~/antigravity-sync-mcp/antigravity-mcp-server
npm --silent test 2>&1 | grep -E "✔|✖|tests? [0-9]+"
echo ""

# Level 2: 集成测试
echo "▶ Level 2: Running integration tests..."

# 准备测试 registry
TEST_REGISTRY_DIR=~/.config/antigravity-mcp-test
mkdir -p "$TEST_REGISTRY_DIR"

# TC 2.3.1: 空 registry
echo "  - Testing empty registry..."
echo '{}' > "$TEST_REGISTRY_DIR/registry-empty.json"
RESULT=$(echo '{"method":"tools/call","params":{"name":"ping","arguments":{}}}' | \
  ANTIGRAVITY_REGISTRY_FILE="$TEST_REGISTRY_DIR/registry-empty.json" \
  node ~/antigravity-sync-mcp/antigravity-mcp-server/build/dist/index.js 2>&1)

if echo "$RESULT" | grep -q "no_workspace_ever_opened"; then
  echo "    ✔ Empty registry returns no_workspace_ever_opened"
else
  echo "    ✖ Empty registry test failed"
  exit 1
fi

# 清理
rm -rf "$TEST_REGISTRY_DIR"

echo ""
echo "=== All tests passed! ==="
```

## 持续集成配置

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
```
