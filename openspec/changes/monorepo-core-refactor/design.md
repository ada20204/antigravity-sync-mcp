# Monorepo + Core Layer Refactor - Design

## 1. Monorepo 结构

采用 npm workspaces 将项目转换为 monorepo，包含三个包：

```
antigravity-mcp/
├── package.json                    # 根 workspace 配置
├── packages/
│   ├── core/                       # @antigravity-mcp/core
│   ├── server/                     # antigravity-mcp-server (移动自根目录)
│   └── sidecar/                    # antigravity-mcp-sidecar (移动自根目录)
├── openspec/                       # 保持不变
├── docs/                           # 保持不变
└── .github/                        # CI 配置需要更新
```

### 根 package.json

```json
{
  "name": "antigravity-mcp",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm test --workspaces --if-present",
    "clean": "npm run clean --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.1.3"
  }
}
```

### 依赖关系

- Core: 无内部依赖，只依赖外部包（ws, @modelcontextprotocol/sdk）
- Server: 依赖 core (`"@antigravity-mcp/core": "workspace:*"`)
- Sidecar: 依赖 core (`"@antigravity-mcp/core": "workspace:*"`)

### TypeScript 项目引用

使用 `tsconfig.json` 的 `references` 字段确保编译顺序：
- Server 的 tsconfig 引用 core
- 构建时自动先编译 core，再编译 server

---

## 2. Core 包架构

Core 包是共享层的核心，提供类型定义和基础工具函数。

### Core 包结构

```
packages/core/
├── src/
│   ├── registry/
│   │   ├── types.ts              # RegistryEntry, RegistryQuotaSnapshot 等
│   │   ├── schema.ts             # SCHEMA_VERSION, 兼容性检查
│   │   ├── io.ts                 # readRegistry, writeRegistry
│   │   └── validation.ts         # 验证函数
│   ├── cdp/
│   │   ├── types.ts              # CDPTarget, CDPConnection 等
│   │   └── constants.ts          # CDP 相关常量
│   ├── quota/
│   │   ├── types.ts              # QuotaSnapshot, QuotaModel 等
│   │   └── utils.ts              # 配额计算工具
│   ├── control/
│   │   ├── constants.ts          # REGISTRY_CONTROL_KEY 等
│   │   └── types.ts              # 控制平面类型
│   ├── platform/
│   │   ├── types.ts              # Platform, PlatformInfo 类型
│   │   ├── detection.ts          # 检测当前平台
│   │   └── paths.ts              # 跨平台路径解析
│   └── index.ts                  # 统一导出
├── package.json
├── tsconfig.json
└── README.md
```

### 核心原则

1. **纯数据和类型** - 不包含业务逻辑（如 CDP 连接、VS Code API）
2. **零副作用** - 所有函数都是纯函数或明确标记副作用
3. **完整类型** - 所有导出都有完整的 TypeScript 类型定义
4. **文档齐全** - 每个导出都有 JSDoc 注释

### 导出示例

```typescript
// packages/core/src/index.ts
export * from './registry/types.js';
export * from './registry/schema.js';
export * from './registry/io.js';
export * from './cdp/types.js';
export * from './quota/types.js';
export * from './control/constants.js';
export * from './platform/paths.js';
export * from './platform/detection.js';
```

### 使用方式

```typescript
// Server 中使用
import { RegistryEntry, readRegistry, SCHEMA_VERSION } from '@antigravity-mcp/core';

// Sidecar 中使用 (JSDoc)
/** @typedef {import('@antigravity-mcp/core').RegistryEntry} RegistryEntry */
const { readRegistry, SCHEMA_VERSION } = require('@antigravity-mcp/core');
```

### 平台模块设计

Core 包负责跨平台路径解析，不包含进程管理：

```typescript
// packages/core/src/platform/paths.ts
export function getConfigDir(): string {
  return process.env.ANTIGRAVITY_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'antigravity-mcp');
}

export function getRegistryPath(): string {
  return path.join(getConfigDir(), 'registry.json');
}

export function getLogDir(): string {
  return path.join(getConfigDir(), 'logs');
}

export function resolveAntigravityExecutable(): string | undefined {
  const explicit = process.env.ANTIGRAVITY_EXECUTABLE?.trim();
  if (explicit) return explicit;

  const candidates = getExecutableCandidates();
  return candidates.find(fileExists);
}

function getExecutableCandidates(): string[] {
  if (process.platform === 'win32') {
    return getWindowsCandidates();
  } else if (process.platform === 'darwin') {
    return getMacCandidates();
  } else {
    return getLinuxCandidates();
  }
}

// packages/core/src/platform/detection.ts
export type Platform = 'win32' | 'darwin' | 'linux';

export function getPlatform(): Platform {
  const p = process.platform;
  if (p === 'win32' || p === 'darwin') return p;
  return 'linux';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
```

**不放入 Core 的：**
- 进程启动和管理（spawn, exec）
- 进程查找命令（pgrep, tasklist）
- 端口扫描逻辑（lsof, netstat）

---

## 3. Server 包重构

Server 包将从单一的 `index.ts` 拆分为清晰的分层架构。

### 重构后的 Server 结构

```
packages/server/
├── src/
│   ├── tools/                    # MCP 工具层（接口层）
│   │   ├── ask-antigravity.ts    # ask-antigravity 工具
│   │   ├── stop.ts               # antigravity-stop 工具
│   │   ├── ping.ts               # ping 工具
│   │   ├── launch.ts             # launch-antigravity 工具
│   │   ├── quota-status.ts       # quota-status 工具
│   │   └── index.ts              # 工具注册
│   ├── services/                 # 服务层（业务逻辑）
│   │   ├── discovery.ts          # 工作区发现和路由
│   │   ├── cdp-client.ts         # CDP 连接和通信
│   │   ├── task-manager.ts       # 任务生命周期管理
│   │   ├── quota-policy.ts       # 配额策略和模型选择
│   │   └── launcher.ts           # Antigravity 启动逻辑
│   ├── utils/                    # 工具函数
│   │   ├── errors.ts             # 错误处理
│   │   ├── retry.ts              # 重试逻辑
│   │   └── ssh-hints.ts          # SSH 环境提示
│   └── index.ts                  # MCP 服务器入口
├── test/                         # 测试
├── package.json
└── tsconfig.json
```

### 分层原则

1. **工具层（Tools）** - MCP 协议接口
   - 处理 MCP 请求/响应
   - 参数验证
   - 调用服务层
   - 不包含业务逻辑

2. **服务层（Services）** - 核心业务逻辑
   - 工作区发现和匹配
   - CDP 连接管理
   - 任务调度
   - 配额策略
   - 可独立测试

3. **工具层（Utils）** - 辅助函数
   - 错误处理
   - 重试机制
   - 日志格式化

### 依赖关系

```
Tools → Services → Core
  ↓        ↓
Utils ←────┘
```

### 示例重构

```typescript
// 当前 index.ts (1114 行，混杂所有逻辑)
// 重构后：

// src/tools/ask-antigravity.ts (约 100 行)
import { DiscoveryService } from '../services/discovery.js';
import { CDPClient } from '../services/cdp-client.js';

export async function handleAskAntigravity(params: AskParams) {
  // 1. 参数验证
  // 2. 调用 DiscoveryService 查找工作区
  // 3. 调用 CDPClient 执行任务
  // 4. 返回结果
}

// src/services/discovery.ts (约 200 行)
import { readRegistry, RegistryEntry } from '@antigravity-mcp/core';

export class DiscoveryService {
  discoverWorkspace(targetDir?: string): RegistryEntry {
    // 工作区发现逻辑
  }
}

// src/services/cdp-client.ts (约 300 行)
import { CDPConnection } from '@antigravity-mcp/core';

export class CDPClient {
  async connect(endpoint: string): Promise<CDPConnection> {
    // CDP 连接逻辑
  }

  async executePrompt(prompt: string): Promise<string> {
    // 注入、等待、提取逻辑
  }
}
```

### 重构收益

- 文件大小：从 1114 行 → 最大文件约 300 行
- 可测试性：服务层可独立单元测试
- 可维护性：职责清晰，修改影响范围小

---

## 4. Sidecar 包重构

Sidecar 包将从巨大的 `extension.js` (2622 行) 拆分为模块化结构。

### 重构后的 Sidecar 结构

```
packages/sidecar/
├── src/
│   ├── commands/                 # VS Code 命令层（接口层）
│   │   ├── toggle.js             # 切换自动接受
│   │   ├── show-quota.js         # 显示配额
│   │   ├── show-quota-table.js   # 显示配额表
│   │   ├── refresh-quota.js      # 刷新配额
│   │   ├── restart-antigravity.js # 重启 (Host only, with confirm)
│   │   ├── request-host-restart.js # 请求重启 (Remote only)
│   │   ├── install-bundled-server.js # 安装 MCP 服务器
│   │   ├── show-ai-config-prompt.js # 显示配置提示
│   │   └── index.js              # 命令注册
│   ├── services/                 # 服务层（业务逻辑）
│   │   ├── cdp-probe.js          # CDP 端点探测
│   │   ├── registry-writer.js    # 注册表写入
│   │   ├── quota-collector.js    # 配额收集
│   │   ├── bridge-host.js        # Host 桥接服务
│   │   ├── bridge-remote.js      # Remote 桥接客户端
│   │   └── launcher.js           # Antigravity 启动
│   ├── core/                     # 核心状态管理
│   │   ├── state-machine.js      # 状态机（app_down → ready）
│   │   ├── role-detection.js     # Host/Remote 角色检测
│   │   └── lifecycle.js          # 扩展生命周期
│   ├── ui/                       # UI 组件
│   │   ├── status-bar.js         # 状态栏
│   │   ├── notifications.js      # 通知和提示
│   │   └── modals.js             # 确认对话框
│   ├── utils/                    # 工具函数
│   │   ├── errors.js             # 错误处理
│   │   ├── logging.js            # 日志封装
│   │   └── config.js             # 配置读取
│   ├── auto-accept.js            # 自动接受（保持独立）
│   ├── bridge-auth.js            # 桥接认证（保持独立）
│   ├── structured-log.js         # 结构化日志（保持独立）
│   └── extension.js              # 入口（约 200 行）
├── server-runtime/               # Bundled MCP server
├── scripts/
│   └── sync-server-runtime.mjs   # 同步依赖脚本（需更新包含 core）
├── package.json
└── tsconfig.json                 # 新增（用于 JSDoc 类型检查）
```

### 分层原则

1. **命令层（Commands）** - VS Code 命令接口
   - 处理 VS Code 命令调用
   - UI 交互
   - 调用服务层
   - 每个命令一个文件（约 50-100 行）

2. **服务层（Services）** - 核心业务逻辑
   - CDP 探测和连接
   - 注册表管理
   - 桥接服务
   - 配额收集
   - 可独立测试（通过 mock VS Code API）

3. **核心层（Core）** - 状态管理
   - 状态机
   - 角色检测
   - 生命周期管理

4. **UI 层（UI）** - 用户界面
   - 状态栏更新
   - 通知显示
   - 模态对话框

### TypeScript 支持（通过 JSDoc）

```javascript
// src/services/registry-writer.js
/** @typedef {import('@antigravity-mcp/core').RegistryEntry} RegistryEntry */

const { getRegistryPath, SCHEMA_VERSION } = require('@antigravity-mcp/core');

/**
 * @param {string} workspaceId
 * @param {Partial<RegistryEntry>} entry
 */
function writeRegistryEntry(workspaceId, entry) {
  // 类型检查生效！
}
```

### 重构后的 extension.js

```javascript
// src/extension.js (约 200 行)
const vscode = require('vscode');
const { registerCommands } = require('./commands');
const { LifecycleManager } = require('./core/lifecycle');
const { createStatusBar } = require('./ui/status-bar');

let lifecycleManager;
let statusBar;

async function activate(context) {
  // 1. 初始化日志
  // 2. 检测角色（host/remote）
  // 3. 创建生命周期管理器
  lifecycleManager = new LifecycleManager(context);
  await lifecycleManager.start();

  // 4. 注册命令
  registerCommands(context, lifecycleManager);

  // 5. 创建状态栏
  statusBar = createStatusBar(context);
  lifecycleManager.on('stateChange', (state) => {
    statusBar.update(state);
  });
}

function deactivate() {
  lifecycleManager?.stop();
  statusBar?.dispose();
}

module.exports = { activate, deactivate };
```

### 命令职责调整

删除 `launchAntigravity` 命令（功能重复，场景不合理）：
- Server 已有 `launch-antigravity` MCP 工具
- Sidecar 运行在 Antigravity 内部，无法启动自己
- 如需启动新窗口，应由外部 MCP 客户端调用 Server 工具

保留的命令：
- `restartAntigravity` - Host 端重启（需确认对话框）
- `requestHostRestart` - Remote 端请求 Host 重启

### 重构收益

- 文件大小：从 2622 行 → 最大文件约 300 行
- 可测试性：服务层可独立测试
- 类型安全：通过 JSDoc 引用 core 的 TypeScript 类型
- 可维护性：每个功能独立文件，易于定位和修改

---

## 5. SSH 远程架构

在 SSH 远程场景下，组件关系如下：

### 架构图

```
Host Machine (本地)
├── Antigravity
│   ├── Host Sidecar (role: host)
│   │   ├── CDP Probe (127.0.0.1:9000)
│   │   ├── Registry Writer
│   │   ├── Bridge Server (127.0.0.1:18900)
│   │   └── Auto-Accept
│   └── CDP Debug Port (127.0.0.1:9000)
└── Host Registry (~/.config/antigravity-mcp/registry.json)

SSH Tunnel (端口转发)
├── 18900 → 127.0.0.1:18900
└── 9000 → 127.0.0.1:9000

Remote Machine (SSH 远程)
├── code-server
│   └── Remote Sidecar (role: remote)
│       ├── Bridge Client (轮询 127.0.0.1:18900)
│       ├── Registry Mirror Writer
│       ├── NO CDP Probe
│       └── NO Auto-Accept
├── Remote Registry (镜像)
└── MCP Server
    ├── 读取 Remote Registry
    └── 连接 127.0.0.1:9000 (转发到 Host)
```

### 职责分离

| 组件 | Host 端 | Remote 端 |
|------|---------|-----------|
| **Sidecar** | ✅ CDP 探测<br>✅ 注册表写入<br>✅ Bridge Server<br>✅ Auto-Accept | ✅ Bridge Client<br>✅ 注册表镜像<br>❌ 无 CDP 探测<br>❌ 无 Auto-Accept |
| **Server** | ❌ 通常不运行 | ✅ 读取 Remote Registry<br>✅ 连接转发的 CDP |

### 数据平面 vs 控制平面

**数据平面（CDP）：**
- MCP Server → CDP (WebSocket)
- 单向：Server 发起连接
- 通过 SSH 端口转发

**控制平面（Bridge）：**
- Remote Sidecar → Host Bridge (HTTP)
- 双向：Remote 轮询 + 请求/响应
- 通过 SSH 端口转发
- HMAC 签名认证

---

## 6. 实施阶段

重构将分为 4 个阶段，每个阶段都可以独立验证和回滚。

### Phase 0: Monorepo 转换（1-2 天）

**目标：** 建立 monorepo 结构，不改变代码逻辑。

**步骤：**
1. 创建根 `package.json` 和 workspace 配置
2. 移动现有包到 `packages/` 目录
3. 更新 CI/CD 配置
4. 验证构建和测试仍然通过

**验证：**
```bash
npm install
npm run build --workspaces
npm test --workspaces
```

**回滚：** 如果失败，恢复目录结构（git revert）

---

### Phase 1: 提取 Core 包（1 周）

**目标：** 创建 `@antigravity-mcp/core` 包，迁移共享代码。

**步骤：**
1. 创建 `packages/core/` 目录结构
2. 迁移注册表类型和 schema
3. 迁移 CDP 类型
4. 迁移配额类型
5. 迁移平台工具（路径解析）
6. 编写 core 单元测试（100% 覆盖）
7. 发布 core 到本地（workspace）

**迁移清单：**
```typescript
// 从 server/src/cdp.ts 迁移到 core/src/registry/types.ts
- RegistryEntry
- RegistryQuotaSnapshot
- RegistryQuotaModel
- RegistryLsEndpoint

// 从 sidecar/src/extension.js 迁移到 core/src/registry/schema.ts
- REGISTRY_SCHEMA_VERSION
- REGISTRY_COMPAT_SCHEMA_VERSIONS
- REGISTRY_CONTROL_KEY

// 从 server/src/registry-io.ts 迁移到 core/src/registry/io.ts
- readRegistryObject()
- getRegistryFilePath()

// 新增到 core/src/platform/paths.ts
- getConfigDir()
- getRegistryPath()
- resolveAntigravityExecutable()
```

**验证：**
```bash
cd packages/core
npm test  # 所有测试通过
npm run build  # 构建成功
```

**回滚：** 删除 `packages/core/`，恢复原始代码

---

### Phase 2: 重构 Server（1 周）

**目标：** Server 依赖 core，拆分为分层架构。

**步骤：**
1. 更新 `packages/server/package.json` 依赖 core
2. 替换重复代码为 core 导入
3. 拆分 `index.ts` 为工具层
4. 提取服务层（discovery, cdp-client, task-manager）
5. 提取工具函数（errors, retry, ssh-hints）
6. 更新测试
7. 删除 `launch-antigravity.ts` 中的重复路径解析代码

**重构示例：**
```typescript
// 之前：packages/server/src/index.ts
const REGISTRY_FILE = path.join(os.homedir(), ".config/antigravity-mcp/registry.json");
interface RegistryEntry { /* 100+ 行类型定义 */ }

// 之后：packages/server/src/index.ts
import { getRegistryPath, RegistryEntry } from '@antigravity-mcp/core';
const REGISTRY_FILE = getRegistryPath();
```

**验证：**
```bash
cd packages/server
npm test  # 所有测试通过
npm run build
node build/dist/index.js --help  # 功能正常
```

**回滚：** 恢复 `packages/server/src/` 到 Phase 1 结束状态

---

### Phase 3: 重构 Sidecar（1-2 周）

**目标：** Sidecar 依赖 core，拆分为模块化架构。

**步骤：**
1. 更新 `packages/sidecar/package.json` 依赖 core
2. 添加 `tsconfig.json` 用于 JSDoc 类型检查
3. 替换重复代码为 core 导入（通过 JSDoc）
4. 拆分 `extension.js` 为命令层
5. 提取服务层（cdp-probe, registry-writer, quota-collector, bridge）
6. 提取核心层（state-machine, role-detection, lifecycle）
7. 提取 UI 层（status-bar, notifications, modals）
8. 删除 `launchAntigravity` 命令
9. 更新 `sync-server-runtime.mjs` 包含 core
10. 验证 VSIX 打包

**重构示例：**
```javascript
// 之前：packages/sidecar/src/extension.js
const REGISTRY_SCHEMA_VERSION = 2;
const REGISTRY_FILE = path.join(os.homedir(), '.config', 'antigravity-mcp', 'registry.json');

// 之后：packages/sidecar/src/extension.js
/** @typedef {import('@antigravity-mcp/core').RegistryEntry} RegistryEntry */
const { SCHEMA_VERSION, getRegistryPath } = require('@antigravity-mcp/core');
const REGISTRY_FILE = getRegistryPath();
```

**验证：**
```bash
cd packages/sidecar
npm run sync-server-runtime  # 同步 core 到 server-runtime
npm run package  # 打包 VSIX
npm run verify  # 验证 VSIX 包含 core
# 手动测试：安装 VSIX，验证所有命令正常
```

**回滚：** 恢复 `packages/sidecar/src/` 到 Phase 2 结束状态

---

### Phase 4: 清理和优化（2-3 天）

**目标：** 删除重复代码，优化构建流程。

**步骤：**
1. 删除 server 和 sidecar 中的重复类型定义
2. 统一错误码和错误消息
3. 优化 TypeScript 项目引用
4. 更新文档（README, CHANGELOG）
5. 性能测试和优化
6. 最终集成测试

**验证：**
```bash
npm run build  # 全部构建
npm test  # 全部测试
# 端到端测试：
# 1. 启动 server
# 2. 安装 sidecar VSIX
# 3. 执行 ask-antigravity
# 4. 验证所有功能正常
```

---

## 7. 总时间估算

- Phase 0: 1-2 天
- Phase 1: 1 周
- Phase 2: 1 周
- Phase 3: 1-2 周
- Phase 4: 2-3 天

**总计：3-4 周**

---

## 8. 风险缓解

- 每个 Phase 独立验证
- 每个 Phase 可以独立回滚
- 保持所有测试通过
- 增量提交，便于 code review

---

## 9. 成功标准

1. **零行为变化** - 所有现有测试通过，无功能回归
2. **类型安全** - Sidecar 通过 JSDoc 引用 core TypeScript 类型
3. **单一真相源** - 注册表 schema 只在 core 定义一次
4. **改进的可测试性** - Core 层 100% 测试覆盖
5. **更好的可维护性** - 无文件超过 500 行，清晰的模块边界
