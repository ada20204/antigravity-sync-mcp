# References

本目录收录了本项目的参考实现，主要通过 git submodule 引入。

## 参考清单

| Path | Upstream |
|---|---|
| `references/OmniAntigravityRemoteChat` | https://github.com/diegosouzapw/OmniAntigravityRemoteChat |
| `references/antigravity-agent` | https://github.com/MonchiLin/antigravity-agent |
| `references/gemini-mcp-tool` | https://github.com/jamubc/gemini-mcp-tool |
| `references/auto-accept-agent` | https://github.com/Munkhin/auto-accept-agent |
| `references/AntiGravity-AutoAccept` | https://github.com/yazanbaker94/AntiGravity-AutoAccept |
| `references/antigravity-auto-run-pro` | https://github.com/MarcoDeliaBot/antigravity-auto-run-pro |
| `references/AntigravityQuota` | https://github.com/Henrik-3/AntigravityQuota |
| `references/zero-gravity` | https://github.com/zhe-gu/zero-gravity |
| `references/Claude-Code-Antigravity-CLI-MCP-Server` | https://github.com/SinanTufekci/Claude-Code-Antigravity-CLI-MCP-Server |
| `references/antigravity-cli-mcp` | https://github.com/bill-kopp-ai-dev/antigravity-cli-mcp |
| `references/agy-mcp-server` | https://github.com/toonPt0473/agy-mcp-server |

### Antigravity CLI（agy）→ MCP wrapper 同类实现

下列三个项目与本仓库 server 的 CLI 路径（直驱 agy 二进制）属同类，是该路径设计的直接对标来源：

- `Claude-Code-Antigravity-CLI-MCP-Server`（Python）：读 transcript.jsonl 取结果 + threading.Lock 串行。
- `antigravity-cli-mcp`（Python）：async start/poll/cancel 任务模型 + 进程组 kill + 路径白名单。
- `agy-mcp-server`（TypeScript）：close-stdin + 直读 stdout，与本仓库 PTY 方案同语言对照。

## 使用说明

- 这些项目用于调研与方案对比，不建议直接混合拷贝到生产代码。
- 更新引用版本请使用 submodule 流程维护，并记录变更原因。
- 若某个参考项目未初始化，可执行：

```bash
git submodule update --init --recursive
```

## 许可证说明

每个参考项目的许可证以其上游仓库声明为准。
