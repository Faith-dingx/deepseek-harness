/**
 * 步骤④ 按三类规矩校验+规范化 (计划 v18 §5.2). Pure text transforms ONLY:
 * the manager is the gatekeeper (守门不创作) — it never adds or rewrites the
 * content system, it only (a) auto-fixes format problems (date heading,
 * bullet spacing, blank-line runs), (b) flags out-of-category lines so the
 * pipeline can ask the user instead of auto-keeping them, and (c) surfaces
 * fixable vs blocking issues. Overlong content is marked, never deleted
 * (精简不删除); duplicates are detected and reported, never removed.
 *
 * @module dsh-memory-manager/audit-pipeline/normalize
 */

import {
  validateMemoryFile,
  type MemoryFileKind,
  type MemoryFileValidateOptions,
  type ValidationIssue,
} from '../shared/validators.ts'

/** Options for the normalization pass (per-kind budgets) */
export interface NormalizeOptions {
  readonly now?: Date
  readonly maxSummaryLines?: number
}

/** The out-of-category issue code surfaced by the three-category gate. */
export const OUT_OF_CATEGORY_CODE = 'out-of-category'

/** Result of a normalization pass: the corrected text + the findings. */
export interface NormalizationResult {
  readonly normalized: string
  readonly issues: readonly ValidationIssue[]
  readonly hasFixable: boolean
  readonly hasOutOfCategory: boolean
}

/** Whether a kind carries a date heading the pipeline auto-fills. */
function isDatedKind(kind: MemoryFileKind): kind is 'memory' | 'log' | 'reflection' {
  return kind === 'memory' || kind === 'log' || kind === 'reflection'
}

/**
 * Ensure a dated heading exists (自动补全日期标题, T6). Memory/log files get
 * `## YYYY-MM-DD`, reflections the `# 反思 YYYY-MM-DD` form; other kinds are
 * returned unchanged.
 */
export function normalizeDateHeading(kind: MemoryFileKind, content: string, now: Date): string {
  if (!isDatedKind(kind)) return content
  const heading = kind === 'reflection' ? `# 反思 ${dateOf(now)}` : `## ${dateOf(now)}`
  if (content.startsWith(`## ${heading.slice(3)}`) || content.startsWith(`# ${heading.slice(2)}`)) return content
  if (/^(?:#|##)\s*\d{4}-\d{2}-\d{2}/.test(content)) return content
  if (content.trim().length === 0) return `${heading}\n`
  return `${heading}\n${content}`
}

/** `YYYY-MM-DD` from a date. */
export function dateOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Normalize bullet-item spacing: `-item` / `*item` → `- item`. */
export function normalizeBulletPrefix(content: string): string {
  return content.replace(/^([-*])(?=[^\s])/gm, '$1 ')
}

/** Collapse blank-line runs (2+) to a single blank line. */
export function collapseBlankLines(content: string): string {
  return content.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
}

/** Lines (non-blank, non-heading) occurring more than once, in order. */
export function findDuplicateLines(content: string): string[] {
  const seen = new Map<string, number>()
  const order: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const count = seen.get(trimmed) ?? 0
    if (count === 0) order.push(trimmed)
    seen.set(trimmed, count + 1)
  }
  /* v8 ignore next -- order only contains first-seen lines already in seen
   * (pushed at count === 0), so get() can never return undefined here. */
  return order.filter(line => (seen.get(line) ?? 0) > 1)
}

/** Build exact-optional-safe validation options for a kind. */
function validateOptions(options: NormalizeOptions): MemoryFileValidateOptions {
  return options.maxSummaryLines === undefined ? {} : { maxSummaryLines: options.maxSummaryLines }
}

/**
 * Run the per-kind validation and apply the fixable format transforms.
 * Content semantics are never touched; out-of-category findings are
 * surfaced (not fixed) so the caller asks the user (T8 core behavior).
 */
export function normalizeMemoryContent(kind: MemoryFileKind, content: string, options: NormalizeOptions = {}): NormalizationResult {
  // fixable 判定基于原始内容: 修正前有哪些自动可修问题
  const validationOptions = validateOptions(options)
  const before = validateMemoryFile(kind, content, validationOptions)
  const hasFixable = before.issues.some(i => i.autoFixable)

  // Format transforms first (pure, conservative).
  let normalized = content
  if (isDatedKind(kind)) normalized = normalizeDateHeading(kind, content, options.now ?? new Date())
  normalized = normalizeBulletPrefix(normalized)
  normalized = collapseBlankLines(normalized)

  // Then validate the corrected text with the per-kind validator.
  const validation = validateMemoryFile(kind, normalized, validationOptions)

  const issues = [...validation.issues]
  // T7: duplicates are reported, never removed (有争议内容不删除).
  for (const dup of findDuplicateLines(normalized)) {
    issues.push({ code: 'duplicate-line', severity: 'warning', autoFixable: false, message: `重复条目: ${dup}` })
  }
  // 超三类内容判定只认 out-of-category 标记（结构性 error 如摘要缺节不算）
  const hasOutOfCategory = issues.some(i => i.code === OUT_OF_CATEGORY_CODE)
  return { normalized, issues, hasFixable, hasOutOfCategory }
}
