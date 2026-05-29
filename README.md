# pi-baidu-plugins

Baidu 团队 Pi coding agent 插件集。

## 安装

```bash
# git 源（推荐）
pi install git:github.com/Edward-lyz/pi-baidu-plugins

# 或本地路径
pi install /path/to/pi-baidu-plugins
```

## 包含插件

| 包 | 说明 |
|---|---|
| `code-block-fix` | Unicode 框线代码块渲染 |
| `co-dev` | 协同开发辅助 |
| `rtk` | Tool call 超时重写 |
| `statusline` | 状态栏（token 速率、模型信息） |
| `system-context` | 自动注入系统信息和目录树到 system prompt |

## 选用单个插件

通过 settings.json 过滤，只加载需要的：

```json
{
  "packages": [
    {
      "source": "git:github.com/Edward-lyz/pi-baidu-plugins",
      "extensions": ["packages/code-block-fix/src/index.ts"]
    }
  ]
}
```