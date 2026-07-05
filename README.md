# antigravity-sync

> ⚠️ **免责声明**：此项目完全是 vibe coding 产物，代码由 AI 生成，未经严格审查。使用风险自己承担。

一个面向 Antigravity 的 MCP 集成项目，目标是让外部 AI 客户端（Claude/Cursor/其他 MCP 客户端）稳定调用 Antigravity 的对话能力。

Antigravity 现已拆分为三个产品形态，本项目对应两条独立可用的接入路径：

| Antigravity 产品                         | 本项目接入方式                                                 |
| ---------------------------------------- | -------------------------------------------------------------- |
| **Antigravity IDE**（VSCode fork） | `packages/server`（CDP）+ `packages/sidecar`（IDE 内扩展） |
| **Antigravity CLI**（`agy`）     | `packages/cli-server`（子进程驱动，无需 IDE）                |
| **Antigravity**（独立聊天 App）         | 不接入（CDP 路径会主动排除它的调试端口）                       |

## 项目目标

- 提供可用的 CDP MCP Server（`packages/server`，对接 Antigravity IDE）
- 提供独立的 CLI MCP Server（`packages/cli-server`，对接 `agy`，与 IDE 路径零依赖）
- 提供 VS Code/Antigravity 侧 Sidecar（`packages/sidecar`）
- 通过统一 registry（`~/.config/antigravity-mcp/registry.json`）解耦运行环境
- 支持配额采集、模型选择、自动接受、安全控制、启动诊断

## 仓库结构

- `packages/core/`：共享类型、schema 与平台工具
- `packages/server/`：CDP MCP Server（TypeScript）
- `packages/cli-server/`：CLI MCP Server（TypeScript，驱动 `agy`）
- `packages/sidecar/`：Sidecar 扩展（JavaScript）
- `references/`：参考实现（以 submodule 为主）
- `docs/plans/`：设计与实现计划
- `openspec/`：规格与变更管理
- `build/`：本地打包产物（如 VSIX）

## 核心架构

1. Sidecar 负责发现/验证 CDP，并写入 registry。
2. Server 默认只读取本地 registry；当 CDP 不可用时会写入 `__control__.cdp_prompt_requests` 触发 Sidecar 端提示弹窗。
3. Server 通过 `ask-antigravity / ping / launch-antigravity / antigravity-stop / quota-status / list-antigravity-models / list-workspaces` 工具提供能力。
4. 配额策略基于 Sidecar 快照 + Server 侧策略选择。
5. CLI Server 独立于上述链路：直接子进程驱动 `agy -p`，提供同步 ask、异步任务（start/poll/cancel/list）与动态模型列表。

## 快速开始

### 1) 构建 Server

```bash
npm install
npm --workspace packages/server run build
```

### 2) 安装 Sidecar（推荐 VSIX）

- 安装 `packages/sidecar` VSIX
- 在 Antigravity 命令面板执行 `Install Bundled MCP Server Launcher`

### 3) CLI Server（可选，独立使用）

```bash
npm --workspace packages/cli-server run build
# 全局安装（生成 ~/.config/antigravity-mcp/bin/antigravity-mcp-cli）
npm --workspace packages/cli-server run install:global
```

### 4) 基础验证

```bash
node --test packages/core/test/*.mjs
node --test packages/server/test/*.mjs
node --test packages/cli-server/test/*.mjs
node --test packages/sidecar/test/*.mjs
```

## 文档入口

- Core 包说明：`packages/core/README.md`
- Server 使用说明：`packages/server/README.md`
- CLI Server 使用说明：`packages/cli-server/README.md`
- Sidecar 使用说明：`packages/sidecar/README.md`
- 设计与计划：`docs/plans/`
- 项目上下文：`openspec/project.md`

## References（来源说明）

本项目在设计和实现过程中参考了多个开源项目，详见：

- `references/README.md`

这些参考项目用于调研、对比、借鉴，不代表原仓库与本项目存在从属关系。

## 许可证

当前仓库内各组件请以各自目录下的许可证声明为准。
引用的第三方项目许可证以其原仓库为准。
