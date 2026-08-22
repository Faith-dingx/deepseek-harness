# @deepseek-ai/dsh-guard-main-agent

English | [中文](README.zh.md)

Guard plugin for the **main orchestration agent**: machine-gates its tool calls so a cheap orchestration model can never silently implement code, touch system configuration, or write outside its permitted file whitelist — it must delegate instead (五环/四道闸 workflow).

The plugin registers a `tools/pre-execute` listener (documented API, `packages/core/tools`, `'tools/pre-execute'`) that runs before every tool executes.

## How it works (interception logic)

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

## Configuration (cordis.yml plugin line)

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

## File-policy gate (whitelist + fail-close)

Data source: `docs/主agent可改写文件清单.yaml` (v2.1). Decisions are made in order:

1. **resolve symlink**: `realpath(target)`; when the target does not exist, resolve the deepest existing ancestor and re-append the suffix (covers the create case); a symlink pointing outside the whitelist is rejected (the log contains the resolvedPath).
2. **whitelist match**: prefix / exact; a rule containing `*` compiles to a regex (`*` → `[^/]+` non-slash segment).
3. **type filter**: `allowedExtensions` not in the list → rejected (e.g. `docs/` allows only `.md` and `.temp/` forbids executable scripts).
4. **temporaryOverrides**: temporary exceptions the user appends to the YAML by hand; `expiresAt > now` takes effect, expiry is automatic (filtered at load + re-checked at decision time).
5. **default deny**: no rule hit → reject (fail-close); there is no blacklist concept.

The manifest hot-reloads: every write decision re-reads the YAML (the file is tiny), so a manual edit takes effect on the next write operation.

## Degradation strategy

| Case | Behavior |
|---|---|
| Classifier transient timeout (AbortError) | **Retries `retryCount` times (default 1)** and only degrades after those also fail; log `errorType=timeout` |
| Classifier real failure (HTTP 4xx/5xx/network/unparseable output/caller abort) | **No retry**; code-class tools (bash/terminal/tool-cordis) → **forced close**; diagnostic/readonly tools → `diagnosticFallback` (default open) → allow; remaining tools → `fallback` (default close); log `errorType=fatal` |
| File-manifest load failure | **deny-all** (fail-close), warning logged |
| Child-agent delegation failure (call_code_agent unavailable) | warning logged, deny still stands (never allows on failure) |
| No write path extractable from the arguments | warning logged, allow-through so the tool itself reports the error |

## Logging and traceability

Every decision prints a structured log (verdict + reason + delegateTo + source + duration ms); a block injects an explanation into the conversation (`agent.inject` with the intercepted tool, the reason and the delegation outcome; the classifier's `reviewPrompt` is injected as well, and the main agent decides whether to call `call_plan_reviewer`).

## Relationship with skill-router

- `skill-router` (agent/pre-step): controls **which skills the model can see** (capability-visibility gate).
- `guard-main-agent` (tools/pre-execute): controls **whether the model can execute out-of-bounds tool calls** (behavior gate).

The two complement each other and can be enabled independently; they share the 9888 classifier convention (endpoint/model/timeout/caching ideas), but their cache keys, event points and decision targets are independent.

## Testing

```bash
pnpm vitest run packages/extensions/guard-main-agent/
# 单元：classifier / policy / delegate / cache / file-policy / messages
# 集成：guard-main-agent.spec.ts（场景1-4 + 文件权限场景5-12）
```

## Verified interfaces (POC conclusions, see the DSF-work project POC report)

- `tools/pre-execute`: `packages/core/tools/src/index.ts` L152 (payload carries name/arguments/agent/signal).
- deny: return `{kind:'deny', reason}`; allow: call `next()`.
- programmatic delegation: `ToolRuntime.execute` (L1342); message injection: `Agent.inject` (dsh-agent runtime-types.ts L143).
