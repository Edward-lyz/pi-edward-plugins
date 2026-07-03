# pi-fff

FFF-powered fuzzy file resolution, content search, and editor autocomplete for pi.

Forked from [ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff) (MIT).

## What it does

- **Fuzzy path resolution for `read`** — agent 输入近似路径（如 `src/idx` 或 `readme`），fff 在 `tool_call` 阶段解析为精确路径后传给内置 read
- **Fuzzy scope resolution for `grep`** — agent 给 grep 的 `path` 参数可以是模糊目录/文件名，fff 解析后传给内置 grep
- **`find_files` 工具** — 模糊文件查找，排名候选列表，支持分页
- **`fff_multi_grep` 工具** — 同时搜索多个 literal pattern
- **`@` 编辑器自动补全** — 在 TUI 输入框用 `@` 触发文件模糊补全
- **`/fff-features`** — 交互式开关各功能
- **`/fff-status`** — 查看索引状态
- **`/reindex-fff`** — 强制重建索引

## 与 claude-style-tools 的兼容

本插件不覆盖 `read`/`grep` 工具注册。它通过 `tool_call` 事件拦截改写 input，
claude-style-tools 的 Claude 风格渲染完全保留。

加载顺序：claude-style-tools 先注册工具 → fff 后注册事件监听器 → 工具调用时 fff 先改写 path → claude-style-tools 的 execute 用精确路径执行。

## Feature flags

通过 `/fff-features` 命令可独立开关：

| Flag | Default | Effect |
|------|---------|--------|
| autocomplete | on | `@` 编辑器补全 |
| builtInReadEnhancement | on | read 路径模糊解析 |
| builtInGrepEnhancement | on | grep scope 模糊解析 |
| agentTools | on | find_files / fff_multi_grep |
| statusUI | on | 启动时显示索引状态通知 |

State 存储在 `~/.pi/agent/extensions/pi-fff.json`。

## Dependencies

- `@ff-labs/fff-node` — 底层索引和搜索引擎（原生模块）
- `better-result` — Result type utilities
