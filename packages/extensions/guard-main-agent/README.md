# @deepseek-ai/dsh-guard-main-agent

Guard plugin for the **main orchestration agent**: machine-gates its tool calls so a cheap
orchestration model can never silently implement code, touch system configuration, or write
outside its permitted file whitelist — it must delegate instead (五环/四道闸 workflow).

The plugin registers a `tools/pre-execute` listener (documented API, `packages/core/tools`,
`'tools/pre-execute'`) that runs before every tool executes.

## 工作机制（拦截逻辑）

```
工具调用提交 (tools/pre-execute)
 ├─ 派发通道工具 (call_code_agent / call_check_agent / subagent 等)  → 直接放行（合法派发通道，防递归）
 ├─ 诊断/只读工具 (read / grep / lsp / web_search / memory_read …)   → 直接放行（零闸自主）
 ├─ 写文件工具 (write / edit / str_replace / browser_upload_file)
 │    └─ 文件权限门禁（机器判定，不走分类器）：
 │        resolve symlink(realpath) → 白名单匹配 → allowedExtensions 类型过滤
 │        → temporaryOverrides 临时例外（到期自动失效）→ 未命中一律拒绝（fail-close）
 │        命中 → 放行；拒绝 → deny + 注入说明 + 派发 code-agent
 └─ 其余工具 (bash / terminal / tool-cordis …)
      └─ 辅助模型分类（9888 POST，aggressive 超时）：
          verdict block|allow + delegateTo(code-agent|check-agent|null) + reviewPrompt
          缓存 key: sessionId|messageHash|workspacePath|presetId（10 分钟 TTL，
          用户消息 hash 变化自动刷新）
          block → deny + 注入说明 + 自动派发 call_code_agent / call_check_agent
          （plan-reviewer 绝不自动派发：reviewPrompt 交给主 agent 决定）
```

## 配置（cordis.yml 插件行）

```yaml
- id: guard-main-agent
  name: '@deepseek-ai/dsh-guard-main-agent'
  config:
    classifierEndpoint: 'http://10.10.10.2:9888/v1/chat/completions'  # 9888 路由
    classifierModel: 'agnes/agnes-2.5-flash'                            # 注意厂商前缀
    fallback: 'close'           # 分类失败时的策略：close（默认，防越界优先）| open
    diagnosticFallback: 'open'  # 诊断/只读类失败时的策略（默认 open）
    timeoutMs: 10000            # 单次分类超时（默认 10000；下限经验 1000）
    retryCount: 1               # 超时重试次数（默认 1；仅瞬时超时触发，HTTP/网络错误不重试）
    cacheTtlMs: 600000          # 任务类型缓存 10 分钟
    cacheMax: 50                # LRU 上限
    presetId: 'main-agent'      # 缓存键中的 preset 字段
    filePolicyPath: 'docs/主agent可改写文件清单.yaml'   # 文件权限清单（相对工作区 cwd）
    boundaryDocPath: '…'        # 可选：权威边界文档路径，其文本拼进分类器 system prompt
```

## 文件权限门禁（D1，白名单 + fail-close）

数据源：`docs/主agent可改写文件清单.yaml`（v2.1）。判定顺序：

1. **resolve symlink**：`realpath(目标)`；不存在时解析最深存在祖先再拼回后缀（覆盖 create 场景），
   symlink 指向白名单外 → 拒绝（日志含 resolvedPath）。
2. **白名单匹配**：prefix / exact，含 `*` 的规则转正则（`*` → `[^/]+` 非斜杠段）。
3. **类型过滤**：`allowedExtensions` 不在列表 → 拒绝（如 `docs/` 仅 `.md`、`.temp/` 禁可执行脚本）。
4. **temporaryOverrides**：用户手动在 YAML 追加的临时例外，`expiresAt > now` 生效，
   过期自动失效（加载即过滤 + 判定时复检）。
5. **默认拒绝**：未命中任何规则（fail-close），无黑名单概念。

清单热重载：写操作每次判定前重读 YAML（文件极小），手动编辑后下一次写操作即生效。

## 降级策略

| 情形 | 行为 |
|---|---|
| 分类器瞬时超时（AbortError） | **重试 `retryCount` 次（默认 1）**，仍失败才按下行降级；日志 `errorType=timeout` |
| 分类器真故障（HTTP 4xx/5xx/网络/输出不可解析/caller abort） | **不重试**；代码类工具（bash/terminal/tool-cordis）→ **强制 close**；诊断/只读 → `diagnosticFallback`（默认 open）→ 放行；其余工具 → `fallback`（默认 close）；日志 `errorType=fatal` |
| 文件清单加载失败 | **deny-all**（fail-close），记录 warning |
| 子代理派发失败（call_code_agent 不可用） | 记录 warning，deny 依然生效（不因此放行） |
| 无法从实参提取写路径 | 记录 warning，放行交给工具自身报错 |

## 日志与可追溯性

每次决策打印结构化日志（verdict + reason + delegateTo + 来源 + 耗时 ms），
block 时向对话注入说明（`agent.inject`，含被拦截工具、原因、派发结果；
classifier 的 reviewPrompt 一并注入，由主 agent 决定是否调用 `call_plan_reviewer`）。

## 与 skill-router 的关系

- `skill-router`（agent/pre-step）：控制**模型能看到哪些 skill**（能力可见性门禁）。
- `guard-main-agent`（tools/pre-execute）：控制**模型能否执行越界工具调用**（行为门禁）。
- 两者互补、可独立启用；共享 9888 分类器约定（endpoint/model/超时/缓存思路），
  但缓存键、事件点、判定目标互不依赖。

## 测试

```bash
pnpm vitest run packages/extensions/guard-main-agent/
# 单元：classifier / policy / delegate / cache / file-policy / messages
# 集成：guard-main-agent.spec.ts（场景1-4 + 文件权限场景5-12）
```

## 验证过的接口（POC 结论，见 DSF-work 项目文档 POC 报告）

- `tools/pre-execute`：`packages/core/tools/src/index.ts` L152（payload 含 name/arguments/agent/signal）。
- deny：返回 `{kind:'deny', reason}`；allow：调 `next()`。
- 程序化派发：`ToolRuntime.execute`（L1342）；消息注入：`Agent.inject`（dsh-agent runtime-types.ts L143）。