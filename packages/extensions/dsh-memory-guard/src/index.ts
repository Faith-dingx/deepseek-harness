/**
 * dsh-memory-guard: host-level guard against literal `{{` / `}}` in memory tool payloads.
 *
 * 故障二 (2026-08-24) 根因: code-agent 子代理 efaf060d 调 memory_log 写今日日志时,
 * 把裸字面量 `{{commit}}` 写进记忆文件 → auto-memory 注入时模板插值器把
 * `{{commit}}` 当模板变量引用, 报 `UNKNOWN variable "{{commit}}"` 错误。
 *
 * 本插件注册 `tools/pre-execute` 监听 (与 guard-main-agent 同一事件机制),
 * 在 host 层运行, 覆盖主 agent 与所有子代理。任何 memory 类写入工具的
 * payload (tool arguments) 若包含裸 `{{` 或 `}}` 字面量, 一律 deny,
 * 不让它进入记忆文件, 从源头杜绝同一故障复发。
 *
 * @module @deepseek-ai/dsh-memory-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-memory-guard'
export const inject = ['agents', 'tools']

/**
 * Memory WRITE tools: payload lands in memory/calendar files, must be guarded.
 * 来源: dsh-injection-manager WRITE_TOOLS_TO_CUT + persona memory 工具。
 */
export const MEMORY_WRITE_TOOLS = [
  'memory_log',
  'memory_note',
  'memory_user',
  'memory_reflect',
  'memory_consolidate',
  'memory_maintain',
  'memory_external',
  'memory',
  'calendar_add',
  'calendar_done',
  'calendar_remove',
] as const

/**
 * Memory READ-ONLY tools: queries do not persist anything, guarded only when
 * `includeReadOnlyTools` is enabled (retrieval of "{{xxx}}" history stays legal).
 */
export const MEMORY_READ_TOOLS = [
  'memory_read',
  'memory_recall',
  'memory_search',
  'memory_status',
  'calendar_list',
] as const

/**
 * Regex source matching a literal `{{...}}` template literal (the fault shape),
 * plus a lone `{{` (one-sided opening brace, potential injection entry).
 * Backtick-wrapped occurrences (`{{x}}`) are the sanctioned escape form and
 * are excluded before scanning (see {@link scanSegments}).
 * NOTE: a lone `}}` is intentionally NOT matched — the template interpolator
 * only reacts to `{{`, so a bare `}}` (common in real code like `foo({a:{b:1}})`)
 * can never poison a context and must not trigger a false-positive denial.
 */
export const DEFAULT_PATTERN = '\\{\\{[^}]*\\}\\}|\\{\\{'

/** Plugin configuration, validated by the schemastery schema. */
export interface Config {
  /** Also guard the read-only memory queries (default: false). */
  includeReadOnlyTools?: boolean
  /** Custom detection regex source (default: {@link DEFAULT_PATTERN}). */
  pattern?: string
}

export const Config: z<Config> = z.object({
  includeReadOnlyTools: z.boolean().default(false),
  pattern: z.string().default(DEFAULT_PATTERN),
})

export function apply(ctx: Context, config: Config = {}): void {
  const includeReadOnly = config.includeReadOnlyTools ?? false
  const regex = new RegExp(config.pattern ?? DEFAULT_PATTERN, 'g')
  const guardedSet = new Set<string>(MEMORY_WRITE_TOOLS)
  if (includeReadOnly) {
    for (const readTool of MEMORY_READ_TOOLS) guardedSet.add(readTool)
  }
  ctx.logger.info(
    `[dsh-memory-guard] arming tools=${JSON.stringify([...guardedSet])} `
      + `includeReadOnly=${includeReadOnly} pattern=${config.pattern ?? '(default)'}`,
  )

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const toolName = exec.name
    if (!guardedSet.has(toolName)) {
      // 非记忆工具不打扰。
      return next()
    }
    // 管理工具 `memory` 的只读 action (read/缺省) 不落盘, 放行。
    if (toolName === 'memory' && !isMemoryWriteAction(exec.arguments)) {
      return next()
    }
    const scan = scanBraceLiterals(exec.arguments, regex)
    if (scan.matches.length === 0) {
      return next()
    }
    const reason = buildDenialReason(toolName, scan.matches, scan.paths)
    ctx.logger.warn(`[dsh-memory-guard] deny tool=${toolName} matches=${JSON.stringify(scan.matches)} paths=${JSON.stringify(scan.paths)}`)
    return { kind: 'deny', reason }
  })
}

/**
 * Split text on backticks and return ONLY the segments that are OUTSIDE any
 * (complete, paired) backtick pair. A backtick pair spans parts[i] (inside)
 * between parts[i-1] and parts[i+1]. The even-index segments are outside.
 *
 * Fail-safe rule: a backtick is only an escape opener when it has a CLOSING
 * partner later in the string. If the string ends with an odd number of
 * backticks (an unclosed opener), the trailing segment is ordinary text and
 * MUST still be scanned — otherwise a bare `{{commit}}` after a lone stray
 * backtick would slip through (fail-open). More matches, never fewer.
 */
function scanSegments(text: string): string[] {
  const parts = text.split('`')
  const outside: string[] = []
  for (let i = 0; i < parts.length; i++) {
    // parts[i] is "inside backticks" only when i is odd AND a closing backtick
    // exists (i + 1 < parts.length). The final odd segment is an unclosed
    // opener → treat as ordinary text.
    const isInsideBacktick = i % 2 === 1 && i + 1 < parts.length
    if (!isInsideBacktick) outside.push(parts[i] ?? '')
  }
  return outside
}

/**
 * Traverse the parsed argument tree and scan every STRING field value for
 * bare brace literals. Strings are scanned individually — never the
 * serialized JSON blob — so structural `}}` (nested-object JSON endings)
 * can never produce a false positive.
 */
function scanBraceLiterals(args: unknown, regex: RegExp): { matches: string[]; paths: string[] } {
  const matches: string[] = []
  const paths: string[] = []
  const re = new RegExp(regex.source, 'g')
  const walk = (value: unknown, path: string): void => {
    if (matches.length >= 3) return
    if (typeof value === 'string') {
      const hits: string[] = []
      for (const segment of scanSegments(value)) {
        re.lastIndex = 0
        const found = segment.match(re)
        if (found) hits.push(...found)
      }
      if (hits.length > 0) {
        matches.push(...hits.slice(0, 3 - matches.length))
        paths.push(path || '(root)')
      }
      return
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path === '' ? key : `${path}.${key}`)
      }
    }
  }
  walk(args, '')
  return { matches: matches.slice(0, 3), paths: paths.slice(0, 5) }
}

/** The management tool `memory` writes only under these actions. */
function isMemoryWriteAction(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false
  const action = (args as { action?: unknown }).action
  // 缺省 action 是只读查询 (read), 不落盘。
  return typeof action === 'string' && ['add', 'update', 'rewrite', 'delete'].includes(action)
}

/** Build the clear, actionable denial reason. */
function buildDenialReason(toolName: string, matches: string[], paths: string[]): string {
  const samples = matches.map(m => JSON.stringify(m)).join(', ')
  const locations = paths.length > 0 ? `参数路径: ${paths.join('; ')}` : ''
  const reason = `记忆禁止写 {{xxx}} 字面量 (工具 ${toolName} 检测到: ${samples}; ${locations})。请去掉花括号，或需要描述占位符时将 {{commit}} 用反引号包住再写入。`
  // reason 会传给 LLM 并落盘会话文件：把所有裸 {{...}} 统一包上反引号，
  // 防止守卫拦得住写记忆、reason 本身却成为二次污染源（2026-08-24 已实证）。
  return reason.replace(/\{\{[^{}]*\}\}/g, m => `\`${m}\``)
}
