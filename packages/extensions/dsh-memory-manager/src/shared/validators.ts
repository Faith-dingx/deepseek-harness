/**
 * Validators and the three-category content gate for dsh-memory-manager
 * (计划 v18 项目二/T2 + §5.2 步骤④). This module is pure: no file system,
 * no side effects. It decides whether lines of a memory file fit the user's
 * three content rules (关键规则 / 关键文件指针 / 工作流水账指针), validates the
 * per-kind file formats (logs, reflections, summary, suggestion entries),
 * and flag out-of-category content as `error` so the audit pipeline NEVER
 * auto-promotes it into a memory file (守门不创作).
 *
 * 用户授意入口 (计划-用户授意记忆入口写入 v2): `parseUserEntries` + `validateUserEntry`
 * 实现防线 2 (来源校验 + 用户原话引用 + target 类别映射), `resolveTargetPath` 给出
 * 三类内容 → 目标记忆文件的映射路径。纯函数, 无副作用。
 *
 * @module dsh-memory-manager/shared/validators
 */

import path from 'node:path'
import type { MemoryPaths } from '../config.ts'

/** The three user content rules plus the out-of-category fallback. */
export type ThreeCategory = 'critical-rule' | 'file-pointer' | 'work-log-pointer' | 'non-compliant'

export type IssueSeverity = 'error' | 'warning' | 'info'

/** One structured validation finding (T2: issues + severity + autoFixable). */
export interface ValidationIssue {
  readonly code: string
  readonly severity: IssueSeverity
  readonly autoFixable: boolean
  readonly message: string
  readonly line?: number
}

export interface ValidationResult {
  readonly issues: readonly ValidationIssue[]
  /** ok = no blocking (error-level) issues. */
  readonly ok: boolean
}

/** Memory file kinds the audit pipeline understands. */
export type MemoryFileKind = 'memory' | 'log' | 'reflection' | 'summary' | 'suggestions' | 'calendar' | 'user-entries'

/** Per-kind validation options (length budgets are config-driven). */
export interface MemoryFileValidateOptions {
  readonly maxSummaryLines?: number
  readonly requiredSummarySections?: readonly string[]
}

/** Required sections of the injection summary (计划 v18 §3.6 校验规则). */
export const REQUIRED_SUMMARY_SECTIONS = ['Primary Request', 'Key Concepts', 'Files', 'Errors', 'Pending Jobs'] as const

/** A dated heading (`## 2026-08-22` or `# 反思 2026-08-22`). */
const DATE_HEADING_RE = /^(?:#|##)\s*(?:\d{4}-\d{2}-\d{2}|反思\s+\d{4}-\d{2}-\d{2})/

/** Known doc/code/memory roots a file pointer may live under. */
const FILE_POINTER_ROOT = '(?:docs/|projects/|packages/|src/|\\.dsh-memory/|\\.temp/|~/\\.dsh/|~/\\.temp/)'

/** File-pointer hints: a path under the known doc/code/memory roots. */
const FILE_POINTER_RE = new RegExp(`(?:^|[\\s：:])(${FILE_POINTER_ROOT}[\\w.@/\\u4e00-\\u9fff-]*\\.(?:md|ts|json|ya?ml|js))\\b`)

/** Rule keywords for the critical-rule category. */
const RULE_KEYWORDS = ['规则', '决策', '约定', '禁止', '必须', '不得', '原则', '偏好'] as const

/** Work-log pointer: an action verb on a SHORT line (一句+指针, 零细节). */
const WORK_VERB_PART = '(?:完成|修复|实现|更新|新增|发布|提交|编写|重构|删除|扩展|上线|优化|调整|记录|准备|验证)'
const WORK_LOG_RE = new RegExp(`(?:${WORK_VERB_PART})(?:了|：|:|完成)?`)

/** Max length of a work-log pointer line before it is out-of-category. */
const WORK_LOG_MAX_LENGTH = 80

/**
 * Classify one non-empty memory file line against the user's three rules.
 * @param line - a single trimmed, non-empty line of a memory file.
 */
export function classifyEntryLine(line: string): ThreeCategory {
  const trimmed = line.trim()
  // ① 关键文件指针: path under a known root, ending in a source/doc extension.
  if (FILE_POINTER_RE.test(trimmed)) return 'file-pointer'
  // ① 关键规则: explicit rule/decision/convention vocabulary.
  if (RULE_KEYWORDS.some(k => trimmed.includes(k))) return 'critical-rule'
  // ③ 工作流水账指针: action verb, short line (a log pointer, not a full journal).
  if (trimmed.length <= WORK_LOG_MAX_LENGTH && WORK_LOG_RE.test(trimmed)) return 'work-log-pointer'
  // 超三类: everything else must be flagged for user review, never auto-kept.
  return 'non-compliant'
}

/** One suggestion entry (计划 v18 §4.2.3 JSON schema). */
export interface SuggestionEntry {
  readonly id: string
  readonly timestamp: string
  readonly source: string
  readonly targetFile: string
  readonly category: string
  readonly content: string
  readonly confidence: number
  readonly reasoning: string
}

const REQUIRED_SUGGESTION_FIELDS = ['id', 'timestamp', 'source', 'targetFile', 'category', 'content', 'confidence', 'reasoning'] as const

/**
 * Parse + structurally validate a pending-suggestions.json payload
 * (方案 B: 只校验结构与类别匹配, 不校验内容语义 — 计划 v18 §5.2 步骤④).
 */
export function parseSuggestionEntries(content: string): { entries: readonly SuggestionEntry[]; issues: readonly ValidationIssue[] } {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return {
      entries: [],
      issues: [{ code: 'suggestions-unreadable', severity: 'error', autoFixable: false, message: '建议条目文件不是合法 JSON' }],
    }
  }
  const raw = (data as { entries?: unknown } | null)?.entries
  if (!Array.isArray(raw)) return { entries: [], issues: [] }
  const entries: SuggestionEntry[] = []
  const issues: ValidationIssue[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      issues.push({ code: 'suggestion-missing-fields', severity: 'error', autoFixable: false, message: '建议条目不是对象' })
      continue
    }
    const record = item as Record<string, unknown>
    const missing = REQUIRED_SUGGESTION_FIELDS.filter(field => record[field] === undefined)
    if (missing.length > 0) {
      issues.push({
        code: 'suggestion-missing-fields',
        severity: 'error',
        autoFixable: false,
        message: `建议条目缺字段: ${missing.join(', ')}`,
      })
      continue
    }
    entries.push(record as unknown as SuggestionEntry)
  }
  return { entries, issues }
}

/** Allowed categories per target file of a suggestion entry (方案 B 类别匹配). */
const TARGET_CATEGORY_MAP: Readonly<Record<string, readonly ThreeCategory[]>> = {
  '~/.dsh/memory/MEMORY.md': ['critical-rule', 'file-pointer', 'work-log-pointer'],
  '~/.dsh/memory/USER.md': ['critical-rule', 'file-pointer', 'work-log-pointer'],
}

/** Daily log file pattern (工作流水账指针 files). */
const DAILY_LOG_RE = /^\.dsh-memory\/\d{4}-\d{2}-\d{2}\.md$/

/**
 * Whether a suggestion's target file accepts its category
 * (计划 v18 §5.2 步骤④ 方案 B: 目标文件类别匹配校验).
 */
export function validateSuggestionTarget(targetFile: string, category: string): boolean {
  const allowed = TARGET_CATEGORY_MAP[targetFile]
  if (allowed !== undefined) return allowed.includes(category as ThreeCategory)
  if (DAILY_LOG_RE.test(targetFile)) return category === 'work-log-pointer'
  return false
}

/**
 * Validate a memory file's content against its kind's rules. Pure: never
 * edits the content, only reports. The pipeline decides what to do with the
 * findings (auto-fix format issues, flag out-of-category ones for the user).
 */
export function validateMemoryFile(kind: MemoryFileKind, content: string, options: MemoryFileValidateOptions): ValidationResult {
  switch (kind) {
    case 'memory': {
      const issues: ValidationIssue[] = []
      if (!DATE_HEADING_RE.test(content)) {
        issues.push({ code: 'missing-date-heading', severity: 'info', autoFixable: true, message: '缺少日期标题' })
      }
      content.split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('>')) return
        if (classifyEntryLine(trimmed) === 'non-compliant') {
          issues.push({
            code: 'out-of-category',
            severity: 'error',
            autoFixable: false,
            message: '疑似超三类内容（关键规则/关键文件指针/工作流水账指针）之外的内容',
            line: index + 1,
          })
        }
      })
      return { issues, ok: issues.every(i => i.severity !== 'error') }
    }
    case 'log': {
      const issues: ValidationIssue[] = []
      if (!DATE_HEADING_RE.test(content)) {
        issues.push({ code: 'missing-date-heading', severity: 'info', autoFixable: true, message: '缺少日期标题' })
      }
      content.split('\n').forEach((line, index) => {
        if (line.length > 200) {
          issues.push({ code: 'line-too-long', severity: 'warning', autoFixable: true, message: '条目超长, 建议精简为一句+指针', line: index + 1 })
        }
        if (/\[(临时|待定|等待)/.test(line)) {
          issues.push({ code: 'temporary-marker', severity: 'warning', autoFixable: false, message: '含临时/待定标记, 维护时识别过时内容', line: index + 1 })
        }
      })
      return { issues, ok: issues.every(i => i.severity !== 'error') }
    }
    case 'reflection': {
      const issues: ValidationIssue[] = []
      if (!DATE_HEADING_RE.test(content)) {
        issues.push({ code: 'missing-date-heading', severity: 'info', autoFixable: true, message: '反思文档缺少日期标题' })
      }
      return { issues, ok: true }
    }
    case 'summary': {
      const sections = options.requiredSummarySections ?? REQUIRED_SUMMARY_SECTIONS
      const maxLines = options.maxSummaryLines ?? 50
      const issues: ValidationIssue[] = []
      for (const section of sections) {
        if (!content.includes(`## ${section}`)) {
          issues.push({ code: 'summary-missing-section', severity: 'error', autoFixable: false, message: `摘要缺少 ${section} 节` })
        }
      }
      const lineCount = content.split('\n').length
      if (lineCount > maxLines) {
        issues.push({ code: 'summary-too-long', severity: 'warning', autoFixable: true, message: `摘要 ${lineCount} 行超过 ${maxLines} 行预算` })
      }
      return { issues, ok: issues.every(i => i.severity !== 'error') }
    }
    case 'suggestions': {
      const parsed = parseSuggestionEntries(content)
      return { issues: parsed.issues, ok: parsed.issues.every(i => i.severity !== 'error') }
    }
    case 'calendar':
      // Unstructured user calendar: format-free, only existence is meaningful.
      return { issues: [], ok: true }
    case 'user-entries':
      // 用户授意入口文件: 不按记忆文件校验 (L-1 专属 kind), 内容由
      // parseUserEntries/validateUserEntry 专属校验, 绝不当日志规范化。
      return { issues: [], ok: true }
  }
}

/* =========================================================================
 * 用户授意记忆入口 (计划-用户授意记忆入口写入 v2 §2.2/§2.3 防线 2)
 * ========================================================================= */

/** 用户授意条目的目标类别 (三类内容 → 记忆文件映射, §2.5 写入映射表). */
export type UserEntryTarget = 'memory' | 'user' | 'project' | 'log'

/** 用户原话引用的可接受形态 (风险表: 中文引号也接受). */
const USER_QUOTE_PATTERNS = [
  // 用户说："..." / 用户说：「...」 / 用户说：'...' (含半角/全角冒号)
  /用户说[:：]?\s*(?:"([^"]+)"|「([^」]+)」|『([^』]+)』|'([^']+)')/,
  // 裸引号 "..." / 「...」 / 『...』
  /"([^"]+)"/,
  /「([^」]+)」/,
  /『([^』]+)』/,
] as const

/** 其他主体的引用归属 (防伪造: 这类引号绝不算作用户原话). */
const NON_USER_ATTRIBUTION_RE = /(?:主\s*agent|agent|AI|模型|插件|助手|assistant|机器人)\s*(?:说|提议|建议|提示|指出|要求|认为|答复|回复)[：:]?/

/** 该项目名的安全格式 (防路径穿越: 禁斜杠/点段)。M-2 项目路径解析。 */
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * 一条已解析的用户授意条目。headerLine 为标题行 (1-based) 在入口文件中的行号;
 * content 为内容行去掉 `- ` 前缀的正文 (多行内容以 \n 连接); raw 为整块原文
 * (标题行 + 内容行), 用于 pending-review 留档。
 */
export interface ParsedUserEntry {
  readonly headerLine: number
  readonly source: string | null
  readonly target: UserEntryTarget | null
  readonly project: string | null
  /** 用户原话引用 (引号内文本); 无可识别引用时为 null (反伪造核心). */
  readonly quote: string | null
  readonly content: string
  readonly raw: string
}

/** 用户条目的处理去向 (防线 2 判定结果). */
export type UserEntryDisposition = 'write' | 'skip' | 'pending-review'

export interface UserEntryValidation {
  readonly disposition: UserEntryDisposition
  readonly issues: readonly ValidationIssue[]
}

/** 入口文件的标题行: 至少含一个 [key=value] 标签。 */
const USER_ENTRY_HEADER_RE = /^\[(?:source|target|project)=[^\]]+\]/

/**
 * 解析入口文件为条目列表。标题行 = 以 `[source=…]`/`[target=…]`/`[project=…]`
 * 开头 (或行首含标签) 的行; 其后紧邻的 `- ` 内容行归属该条目 (多条以 \n 连接)。
 * 注释行 (`#` / `<!-- -->`) 与空行跳过; 内容行之前的孤立 `- ` 行忽略。
 */
export function parseUserEntries(content: string): ParsedUserEntry[] {
  const entries: ParsedUserEntry[] = []
  let open: ParsedUserEntry | null = null
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    /* v8 ignore next -- array index is in-bounds by the loop bound; the
     * undefined guard is a noUncheckedIndexedAccess defensive habit. */
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (USER_ENTRY_HEADER_RE.test(trimmed)) {
      const entry: ParsedUserEntry = {
        ...parseUserEntryHeader(trimmed),
        headerLine: index + 1,
        content: '',
        raw: trimmed,
      }
      open = entry
      entries.push(entry)
      continue
    }
    if (open !== null && (trimmed.startsWith('- ') || trimmed === '-')) {
      const bullet = trimmed === '-' ? '' : trimmed.slice(2)
      // readonly 接口不可变 → 重建条目对象并替换数组尾元素
      const rebuilt: ParsedUserEntry = {
        source: open.source,
        target: open.target,
        project: open.project,
        quote: open.quote,
        headerLine: open.headerLine,
        content: open.content.length === 0 ? bullet : `${open.content}\n${bullet}`,
        raw: `${open.raw}\n${trimmed}`,
      }
      open = rebuilt
      entries[entries.length - 1] = rebuilt
    }
  }
  return entries
}

/** 解析标题行的 source/target/project 标签与用户原话引用。 */
function parseUserEntryHeader(header: string): Pick<ParsedUserEntry, 'source' | 'target' | 'project' | 'quote'> {
  const sourceMatch = /\[source=([^\]]+)\]/.exec(header)
  const targetMatch = /\[target=([^\]]+)\]/.exec(header)
  const projectMatch = /\[project=([^\]]+)\]/.exec(header)
  const source = sourceMatch?.[1]?.trim() ?? null
  const targetValue = targetMatch?.[1]?.trim() ?? null
  const target: UserEntryTarget | null = targetValue === 'memory' || targetValue === 'user' || targetValue === 'project' || targetValue === 'log'
    ? targetValue
    : null
  return {
    source,
    target,
    project: projectMatch?.[1]?.trim() ?? null,
    quote: extractUserQuote(header),
  }
}

/** 提取用户原话引用: 优先 `用户说："…"` 归属形态; 其次裸引号 (仅当行内无其他
 * 主体的引用归属, 防伪造: 主 agent 提议/模型建议的引号绝不算作用户原话)。 */
function extractUserQuote(text: string): string | null {
  const attributed = USER_QUOTE_PATTERNS[0].exec(text)
  const group = attributed === null ? undefined : firstNonEmptyQuoteGroup(attributed)
  if (group !== undefined) return group
  // 行内含其他主体 (主 agent/AI/模型/助手) 的引用归属 → 无可信用户引用
  if (NON_USER_ATTRIBUTION_RE.test(text)) return null
  for (const pattern of USER_QUOTE_PATTERNS.slice(1)) {
    const match = pattern.exec(text)
    const bare = match === null ? undefined : firstNonEmptyQuoteGroup(match)
    if (bare !== undefined) return bare
  }
  return null
}

/** 取匹配组中第一个非空引用文本 (`match[0]` 为整段匹配, 从 1 开始). */
function firstNonEmptyQuoteGroup(match: RegExpExecArray): string | undefined {
  for (let index = 1; index < match.length; index += 1) {
    const group = match[index]
    // 正则分支未参与的分组在运行期为 undefined (TS 将 RegExpExecArray 宽松类型化为 string[])
    if (group !== undefined && group.trim().length > 0) return group.trim()
  }
  return undefined
}

/**
 * 防线 2 判定: 三层防线之一 (source=user 强制 + 用户原话引用必需 + target 合法 +
 * 三类内容校验)。返回处置去向:
 * - `write`: 可写目标文件
 * - `skip`: source ≠ user → 静默跳过 (不写目标文件, 不写 pending-review, 防污染队列)
 * - `pending-review`: 其余不合规 → 排队等待用户决策, 绝不自动写
 */
export function validateUserEntry(entry: ParsedUserEntry): UserEntryValidation {
  if (entry.source === null) {
    return {
      disposition: 'pending-review',
      issues: [{ code: 'missing-source', severity: 'error', autoFixable: false, message: '条目缺少 [source=…] 来源标签' }],
    }
  }
  if (entry.source !== 'user') {
    // 反伪造断言 1: 非 user 来源静默跳过
    return {
      disposition: 'skip',
      issues: [{ code: 'invalid-source', severity: 'error', autoFixable: false, message: `来源 ${entry.source} 不是 user, 静默跳过` }],
    }
  }
  const issues: ValidationIssue[] = []
  if (entry.quote === null || entry.quote.length === 0) {
    // 反伪造断言 2: 无用户原话引用 → 标记 pending-review, 不写目标文件
    issues.push({ code: 'missing-quote', severity: 'error', autoFixable: false, message: '缺少用户原话引用 (用户说："…" 或 "…" 格式)' })
  }
  if (entry.target === null) {
    issues.push({ code: 'invalid-target', severity: 'error', autoFixable: false, message: 'target 必须是 memory/user/project/log 之一' })
  }
  if (entry.target === 'project') {
    if (entry.project === null || entry.project.length === 0) {
      issues.push({ code: 'missing-project', severity: 'error', autoFixable: false, message: 'target=project 时必须指定 project 名称' })
    } else if (!PROJECT_NAME_RE.test(entry.project)) {
      issues.push({ code: 'invalid-project', severity: 'error', autoFixable: false, message: `项目名 ${entry.project} 含非法字符 (仅字母/数字/.-_)` })
    }
  }
  if (entry.content.trim().length === 0) {
    issues.push({ code: 'missing-content', severity: 'error', autoFixable: false, message: '条目缺少内容行 (- <内容>)' })
  }
  if (entry.content.trim().length > 0 && entry.content.trim() === entry.quote?.trim()) {
    // 反伪造启发: 内容只是原话的逐字复读 → 无规范化信息, 视为引用与内容不符
    issues.push({ code: 'quote-content-mismatch', severity: 'error', autoFixable: false, message: '内容与原话引用逐字相同, 缺少规范化加工' })
  }
  if (entry.content.trim().length > 0 && classifyEntryLine(entry.content) === 'non-compliant') {
    // 超三类内容 → 标记 pending-review (与 §2.2 反作弊断言一致)
    issues.push({ code: 'out-of-category', severity: 'error', autoFixable: false, message: '内容超出三类内容规范 (关键规则/关键文件指针/工作流水账指针)' })
  }
  return {
    disposition: issues.length === 0 ? 'write' : 'pending-review',
    issues,
  }
}

/**
 * 三类内容 → 目标记忆文件路径 (§2.5 写入映射表):
 * - memory → ~/.dsh/memory/MEMORY.md (关键规则)
 * - user   → ~/.dsh/memory/USER.md (用户偏好)
 * - project → <workspace>/projects/<name>/docs/MEMORY.md (项目笔记, 项目名安全校验)
 * - log    → <workspace>/.dsh-memory/<YYYY-MM-DD>.md (工作日志)
 * 项目名缺失/非法返回 null (调用方标记 pending-review)。
 */
export function resolveTargetPath(
  target: UserEntryTarget,
  project: string | null,
  now: Date,
  paths: MemoryPaths,
): string | null {
  switch (target) {
    case 'memory':
      return paths.userMemoryFile
    case 'user':
      return paths.userProfileFile
    case 'log':
      return path.join(paths.workspaceRoot, '.dsh-memory', `${now.toISOString().slice(0, 10)}.md`)
    case 'project': {
      if (project === null || project.length === 0) return null
      if (!PROJECT_NAME_RE.test(project)) return null
      return path.join(paths.workspaceRoot, 'projects', project, 'docs', 'MEMORY.md')
    }
  }
}
