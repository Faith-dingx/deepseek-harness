/**
 * 步骤⑤ 归档修改 (计划 v18 §5.2). Two and only two paths, per the plan:
 *
 * - **格式问题 → 自动修正**: the normalized content is written back to the
 *   file (date heading, bullet spacing, blank runs — never content semantics).
 * - **超三类内容 → 标记等待用户决策**: the offending lines land in
 *   `pending-review.json`; the memory file is NEVER touched, so out-of-
 *   category content can never auto-enter memory (T8 core behavior).
 *
 * Also hosts the suggestion-entry lifecycle of the audit side: approved
 * suggestions get appended into their target memory file
 * ({@link applyApprovedSuggestionEntry}). File I/O is fail-open: any failure
 * resolves with the action not taken instead of throwing.
 *
 * @module dsh-memory-manager/audit-pipeline/archive
 */

import { appendAuditLine, type AuditLogEntry } from '../shared/logger.ts'
import { normalizeMemoryContent } from './normalize.ts'
import type { MemoryFileKind } from '../shared/validators.ts'

/** File-system surface for the archive stage; injectable for tests. */
export interface ArchiveFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
}

/** One pending-review queue entry (超三类内容, 等待用户决策). */
export interface PendingReviewEntry {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly content: string
  readonly time: string
  readonly status: 'pending' | 'resolved'
}

/** Options of the archive/normalization application. */
export interface ApplyNormalizationOptions {
  readonly now?: Date
  /** pending-review.json path; the queue is not written when omitted. */
  readonly pendingReviewPath?: string
  /** Custom audit sink; defaults to appendAuditLine(auditDir ?? '.dsh-memory/audit'). */
  readonly audit?: (dir: string, entry: AuditLogEntry) => Promise<void>
  readonly auditDir?: string
}

/** Outcome of applying the normalization pass to one file. */
export interface ApplyNormalizationResult {
  readonly fixed: boolean
  readonly flagged: boolean
}

const DEFAULT_AUDIT_DIR = '.dsh-memory/audit'

/** Build a pending-review entry for one out-of-category line (T8). */
export function buildPendingReviewEntry(file: string, line: number, content: string, now: Date): PendingReviewEntry {
  const stamp = now.getTime()
  const day = now.toISOString().slice(0, 10).replaceAll('-', '')
  return { id: `review-${day}-${stamp}`, file, line, content, time: now.toISOString(), status: 'pending' }
}

/**
 * Read the pending-review queue. A missing or corrupted file reads as empty
 * (fail-open: the queue must never break the pipeline).
 */
export async function readPendingReview(path: string, fsImpl: ArchiveFs): Promise<PendingReviewEntry[]> {
  let text: string
  try {
    text = await fsImpl.readFile(path)
  } catch {
    return []
  }
  try {
    const data: unknown = JSON.parse(text)
    const entries = (data as { entries?: unknown } | null)?.entries
    return Array.isArray(entries) ? entries as PendingReviewEntry[] : []
  } catch {
    return []
  }
}

/** Serialize the pending-review queue (exported for maintenance TTL cleanup). */
export async function writePendingReview(path: string, entries: readonly PendingReviewEntry[], fsImpl: ArchiveFs): Promise<void> {
  await fsImpl.mkdir(requireDir(path), { recursive: true })
  await fsImpl.writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`)
}

/** The parent directory of a file path (for lazy mkdir). */
function requireDir(file: string): string {
  const index = file.lastIndexOf('/')
  return index <= 0 ? '.' : file.slice(0, index)
}

/** Append a review entry, deduplicating identical file+line pairs. */
export async function appendPendingReview(path: string, entry: PendingReviewEntry, fsImpl: ArchiveFs): Promise<void> {
  const entries = await readPendingReview(path, fsImpl)
  if (entries.some(e => e.file === entry.file && e.line === entry.line)) return
  await writePendingReview(path, [...entries, entry], fsImpl)
}

/** Remove a review entry for file+line after the user decided; false when absent. */
export async function resolvePendingReview(path: string, file: string, line: number, fsImpl: ArchiveFs): Promise<boolean> {
  const entries = await readPendingReview(path, fsImpl)
  const remaining = entries.filter(e => !(e.file === file && e.line === line))
  if (remaining.length === entries.length) return false
  await writePendingReview(path, remaining, fsImpl)
  return true
}

/**
 * Apply the normalization pass to one memory file:
 * - fixable format issues → write the corrected content back (自动修正);
 * - out-of-category content → append to pending-review, leave the file alone.
 * Never throws: failures resolve with the action skipped (fail-open).
 */
export async function applyNormalization(
  file: string,
  kind: MemoryFileKind,
  content: string,
  options: ApplyNormalizationOptions = {},
  fsImpl: ArchiveFs,
): Promise<ApplyNormalizationResult> {
  const audit = options.audit ?? ((dir: string, entry: AuditLogEntry) => appendAuditLine(dir, entry))
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR
  const result = normalizeMemoryContent(kind, content, { now: options.now ?? new Date() })

  let fixed = false
  let flagged = false
  if (result.hasFixable) {
    try {
      await fsImpl.writeFile(file, result.normalized)
      fixed = true
      await audit(auditDir, { time: new Date().toISOString(), event: 'normalize-fixed', file, detail: `${result.issues.length} issues` })
    } catch {
      // fail-open: a write failure keeps the original file intact.
    }
  }
  if (result.hasOutOfCategory) {
    flagged = true
    if (options.pendingReviewPath !== undefined) {
      const outOfCategory = result.issues.filter(i => i.code === 'out-of-category')
      for (const issue of outOfCategory) {
        try {
          /* v8 ignore next 2 -- the memory validator always sets `line` on
           * out-of-category findings; ?? guards a defensive fallback only. */
          const line = issue.line ?? 0
          await appendPendingReview(
            options.pendingReviewPath,
            buildPendingReviewEntry(file, line, lineOf(content, line), options.now ?? new Date()),
            fsImpl,
          )
        } catch {
          // fail-open: queue write failures never break the pipeline.
        }
      }
    }
  }
  return { fixed, flagged }
}

/** The source line at a 1-based index (empty when out of bounds). */
function lineOf(content: string, line: number): string {
  const lines = content.split('\n')
  /* v8 ignore next -- `line` comes from the validator and is always in range. */
  return lines[line - 1] ?? ''
}

/**
 * Write an approved suggestion's content into its target memory file under a
 * dated heading (用户确认后写入目标记忆文件, T8). The heading is created or
 * reused; content appended at the end. Fail-open.
 */
export async function applyApprovedSuggestionEntry(
  entry: { targetFile: string; content: string },
  fsImpl: ArchiveFs,
  now = new Date(),
): Promise<void> {
  const heading = `## ${now.toISOString().slice(0, 10)}`
  try {
    let current = ''
    try {
      current = await fsImpl.readFile(entry.targetFile)
    } catch {
      current = ''
    }
    await fsImpl.mkdir(requireDir(entry.targetFile), { recursive: true })
    const body = current.trim().length === 0 ? `${heading}\n` : current
    const appended = `${body.replace(/\n$/, '')}\n- ${entry.content}\n`
    await fsImpl.writeFile(entry.targetFile, appended)
  } catch {
    // fail-open: an approval write failure is contained.
  }
}
