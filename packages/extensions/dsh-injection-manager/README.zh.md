# @deepseek-ai/dsh-injection-manager

[English](README.md) | 中文

DeepSeek Harness 的记忆文件与上下文注入管理器。插件监听 `system-prompt/assemble`，对**每一次**组装生效（根 agent 与子 agent 一视同仁——不做 agent 分支）：

| 变换 | 做什么 | 位置 |
|---|---|---|
| 记忆工具裁剪 | 从 `assembly.tools` 静态移除 10 个记忆写入工具（`memory_log`、`memory_note`、`memory_user`、`memory_reflect`、`memory_consolidate`、`memory_maintain`、`memory_external`、`calendar_add`、`calendar_done`、`calendar_remove`）；5 个读取工具（`memory_read`、`memory_recall`、`memory_search`、`memory_status`、`calendar_list`）常驻。全局 `ctx.tools` 注册表永不触碰。 | `src/tool-cut.ts` |
| 记忆文件分层 | 保留六个已知短期名字（`dsh:auto-memory`、`dsh:auto-memory-rules`、`memory:profile`、`memory:standing`、`memory:failures`、`memory:project`），丢弃记忆插件命名空间内未知的长期名字（`memory:*`、`dsh:*`），其余非记忆 section/context（persona、identity、tool guidance、agent instructions）原样放行。日历内容位于 `dsh:auto-memory` context 内部，无需单独处理。 | `src/memory-layer.ts` |
| 最小去重 | 每个 section/context name 首次出现者胜；无哈希、无内容合并、无优先级挑选。 | `src/dedup.ts` |
| Fail-open | 任何异常返回下游 `await next()` 的结果；下游失败返回原始 assembly。异常记日志（事件类型 + 原因）；系统提示词绝不会因为这个插件而塌掉。 | `src/index.ts` |

工具的裁剪、层规则与短期名字是硬编码固定集合（`src/config.ts`）：无分类器、无任务类型分支、无动态逻辑。

## 挂载

在 agent preset 的 `agent.cordis.yml` 中、`guard-main-agent` 之后添加：

```yaml
- id: dsh-injection-manager
  name: '@deepseek-ai/dsh-injection-manager'
```

该包已在 `apps/cli/package.json` 与 `tsconfig.host.json` 中注册。
