/**
 * Validators and the three-category content gate for dsh-memory-manager
 * (计划 v18 项目二/T2 + §5.2 步骤④). This module is pure: no file system,
 * no side effects. It decides whether lines of a memory file fit the user's
 * three content rules (关键规则 / 关键文件指针 / 工作流水账指针), validates the
 * per-kind file formats (logs, reflections, summary, suggestion entries),
 * and flag out-of-category content as `error` so the audit pipeline NEVER
 * auto-promotes it into a memory file (守门不创作).
 *
 * @module dsh-memory-manager/shared/validators
 */

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
export type MemoryFileKind = 'memory' | 'log' | 'reflection' | 'summary' | 'suggestions' | 'calendar'

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
  }
}
