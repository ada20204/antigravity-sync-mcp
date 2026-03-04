# antigravity-sync

一个面向 Antigravity 的 MCP 集成项目，目标是让外部 AI 客户端（Claude/Cursor/其他 MCP 客户端）稳定调用 Antigravity 的对话能力。

## 项目目标

- 提供可用的 MCP Server（`antigravity-mcp-server`）
- 提供 VS Code/Antigravity 侧 Sidecar（`antigravity-mcp-sidecar`）
- 通过统一 registry（`~/.config/antigravity-mcp/registry.json`）解耦运行环境
- 支持配额采集、模型选择、自动接受、安全控制、启动诊断

## 仓库结构

- `antigravity-mcp-server/`：MCP Server（TypeScript）
- `antigravity-mcp-sidecar/`：Sidecar 扩展（JavaScript）
- `references/`：参考实现（以 submodule 为主）
- `docs/plans/`：设计与实现计划
- `openspec/`：规格与变更管理
- `build/`：本地打包产物（如 VSIX）

## 核心架构

1. Sidecar 负责发现/验证 CDP，并写入 registry。
2. Server 默认只读取本地 registry；当 CDP 不可用时会写入 `__control__.cdp_prompt_requests` 触发 Sidecar 端提示弹窗。
3. Server 通过 `ask-antigravity / ping / launch-antigravity / quota-status` 等工具提供能力。
4. 配额策略基于 Sidecar 快照 + Server 侧策略选择。

## 快速开始

### 1) 构建 Server

```bash
npm --prefix antigravity-mcp-server install
npm --prefix antigravity-mcp-server run build
```

### 2) 安装 Sidecar（推荐 VSIX）

- 安装 `antigravity-mcp-sidecar` VSIX
- 在 Antigravity 命令面板执行 `Install Bundled MCP Server Launcher`

### 3) 基础验证

```bash
node --test antigravity-mcp-server/test/*.mjs
node --test antigravity-mcp-sidecar/test/*.mjs
```

## 文档入口

- Server 使用说明：`antigravity-mcp-server/README.md`
- Sidecar 使用说明：`antigravity-mcp-sidecar/README.md`
- 设计与计划：`docs/plans/`
- 项目上下文：`openspec/project.md`

## References（来源说明）

本项目在设计和实现过程中参考了多个开源项目，详见：

- `references/README.md`

这些参考项目用于调研、对比、借鉴，不代表原仓库与本项目存在从属关系。

## 许可证

当前仓库内各组件请以各自目录下的许可证声明为准。
引用的第三方项目许可证以其原仓库为准。
