/**
 * 定期维护 (计划 v18 §5.3 / T10): daily巡检 + 过时内容识别 + 摘要清理 +
 * 建议条目清理 + 审计日志归档 + 归档区 gzip 整理. Every action is
 * fail-open (a failing file is skipped, never throws) and the archive area is
 * only ever READ by the maintenance scan — the audit pipeline's watch list is
 * separate and never sees archive writes (避免循环触发).
 *
 * @module dsh-memory-manager/audit-pipeline/maintenance
 */

import { gzipSync } from 'node:zlib'
import { kindOfFile, type MemoryPaths, type ResolvedPluginConfig } from '../config.ts'
import { applyNormalization, readPendingReview } from './archive.ts'
import { parseSuggestionEntries } from '../shared/validators.ts'

/** File-system surface for maintenance; injectable for tests. */
export interface MaintenanceFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
  appendFile(file: string, data: string): Promise<void>
  stat(file: string): Promise<{ mtimeMs: number }>
  readdir(dir: string): Promise<string[]>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
}

/** Maintenance timing override (tests freeze the file ages). */
export interface MaintenanceStatOverride {
  statOf?: (file: string) => Promise<{ mtimeMs: number }> | { mtimeMs: number }
  now?: Date
  /** Audit targets to scan; defaults to the five fixed short-term files. */
  targets?: readonly string[]
}

/** Structured report of one maintenance run (T10 可观测). */
export interface MaintenanceReport {
  readonly checked: readonly string[]
  readonly staleFound: number
  readonly summariesArchived: readonly string[]
  readonly suggestionsExpired: number
  readonly auditArchived: readonly string[]
  readonly archivesCompressed: readonly string[]
  readonly pendingCount: number
}

/** Lines in a file carrying 临时/待定/等待 markers (过时内容线索). */
export function identifyStaleContent(content: string): readonly { line: number; text: string }[] {
  const found: { line: number; text: string }[] = []
  content.split('\n').forEach((line, index) => {
    if (/\[(临时|待定|等待)/.test(line)) found.push({ line: index + 1, text: line.trim() })
  })
  return found
}

/** Whether a date is more than `days` before `now`. */
export function isOlderThanDays(date: Date, days: number, now: Date): boolean {
  return now.getTime() - date.getTime() > days * 24 * 60 * 60 * 1000
}

interface SuggestionLike {
  readonly id: string
  readonly timestamp: string
}

/** Remove suggestion entries older than the window; report progress. */
export async function cleanupExpiredSuggestions(
  path: string,
  maxAgeDays: number,
  now: Date,
  fsImpl: MaintenanceFs,
): Promise<{ removed: number; remainingIds: readonly string[] }> {
  let text: string
  try {
    text = await fsImpl.readFile(path)
  } catch {
    return { removed: 0, remainingIds: [] }
  }
  const parsed = parseSuggestionEntries(text)
  if (parsed.issues.some(i => i.code === 'suggestions-unreadable')) return { removed: 0, remainingIds: [] }
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
  const kept: SuggestionLike[] = []
  let removed = 0
  for (const entry of parsed.entries) {
    const ts = Date.parse(entry.timestamp)
    if (Number.isFinite(ts) && ts < cutoff) {
      removed += 1
    } else {
      kept.push(entry)
    }
  }
  await fsImpl.writeFile(path, `${JSON.stringify({ entries: kept }, null, 2)}\n`)
  return { removed, remainingIds: kept.map(e => e.id) }
}

/**
 * Move a stale one-file summary into archive/summaries/<day>.md (单文件策略
 * 清理, T10). Returns the archived paths.
 */
export async function archiveOldSummaries(
  summaryFile: string,
  archiveDir: string,
  maxAgeDays: number,
  now: Date,
  fsImpl: MaintenanceFs,
  statOverride?: (file: string) => { mtimeMs: number } | Promise<{ mtimeMs: number }>,
): Promise<string[]> {
  let mtime: number
  let content: string
  try {
    const stat = statOverride !== undefined ? await statOverride(summaryFile) : await fsImpl.stat(summaryFile)
    mtime = stat.mtimeMs
    content = await fsImpl.readFile(summaryFile)
  } catch {
    return []
  }
  if (!isOlderThanDays(new Date(mtime), maxAgeDays, now)) return []
  const day = dateOfDayName(new Date(mtime))
  const target = `${archiveDir}/${day}.md`
  await fsImpl.mkdir(archiveDir, { recursive: true })
  await fsImpl.writeFile(target, content)
  await fsImpl.unlink(summaryFile)
  return [target]
}

/**
 * gzip-compress history archive .md files older than the window into
 * `<date>.md.gz` and drop the plain source (计划 v18 §5.3 归档压缩格式).
 */
export async function consolidateHistoryArchives(
  archiveRoot: string,
  maxAgeDays: number,
  now: Date,
  fsImpl: MaintenanceFs,
  statOverride?: (file: string) => { mtimeMs: number } | Promise<{ mtimeMs: number }>,
): Promise<string[]> {
  const compressed: string[] = []
  let sessions: string[]
  try {
    sessions = await fsImpl.readdir(archiveRoot)
  } catch {
    return []
  }
  for (const session of sessions) {
    if (session.startsWith('.')) continue
    const sessionDir = `${archiveRoot}/${session}`
    let files: string[]
    try {
      files = await fsImpl.readdir(sessionDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const full = `${sessionDir}/${file}`
      let mtime: number
      try {
        const stat = statOverride !== undefined ? await statOverride(full) : await fsImpl.stat(full)
        mtime = stat.mtimeMs
      } catch {
        continue
      }
      if (!isOlderThanDays(new Date(mtime), maxAgeDays, now)) continue
      try {
        const content = await fsImpl.readFile(full)
        await fsImpl.writeFile(`${full}.gz`, gzipSync(Buffer.from(content, 'utf8')).toString('base64'))
        await fsImpl.unlink(full)
        compressed.push(`${full}.gz`)
      } catch {
        // fail-open: one archive file failing does not stop the pass.
      }
    }
  }
  return compressed
}

/** Move audit logs older than the window into the audit archive. */
export async function archiveOldAuditLogs(
  auditDir: string,
  archiveDir: string,
  maxAgeDays: number,
  now: Date,
  fsImpl: MaintenanceFs,
): Promise<string[]> {
  let files: string[]
  try {
    files = await fsImpl.readdir(auditDir)
  } catch {
    return []
  }
  const moved: string[] = []
  for (const file of files) {
    const match = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(file)
    if (match === null) continue
    const day = new Date(`${match[1]}T00:00:00Z`)
    if (!isOlderThanDays(day, maxAgeDays, now)) continue
    const from = `${auditDir}/${file}`
    const to = `${archiveDir}/${file}`
    try {
      await fsImpl.mkdir(archiveDir, { recursive: true })
      await fsImpl.rename(from, to)
      moved.push(to)
    } catch {
      // fail-open.
    }
  }
  return moved
}

/** `YYYY-MM-DD` from a date. */
function dateOfDayName(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Run the complete maintenance pass (计划 v18 §5.3 维护流程). Serial,
 * fail-open, returns a structured report.
 */
export async function runMaintenance(
  paths: MemoryPaths,
  config: ResolvedPluginConfig,
  now: Date,
  fsImpl: MaintenanceFs,
  options: MaintenanceStatOverride = {},
): Promise<MaintenanceReport> {
  const statOf = options.statOf
  const targets = options.targets ?? [
    paths.userMemoryFile, paths.userProfileFile, paths.userCalendarFile,
    paths.summaryFile, paths.suggestionsFile,
  ]
  const checked: string[] = []
  let staleFound = 0
  for (const target of targets) {
    let exists = true
    try {
      const stat = statOf !== undefined ? await statOf(target) : await fsImpl.stat(target)
      /* v8 ignore start -- else-less if with an assignment body: v8 reports no
       * counter for the implicit false branch, so treat it as unmeasurable. */
      if (stat.mtimeMs === 0) exists = false
      /* v8 ignore stop */
    } catch {
      exists = false
    }
    if (!exists) continue
    checked.push(target)
    let content: string
    try {
      content = await fsImpl.readFile(target)
    } catch {
      continue
    }
    staleFound += identifyStaleContent(content).length
    try {
      await applyNormalization(target, kindOfFile(target, paths), content, {
        now,
        pendingReviewPath: paths.pendingReviewFile,
        auditDir: paths.auditDir,
      }, fsImpl)
    } catch {
      // fail-open: one file failing does not stop the pass.
    }
  }

  const summariesArchived = await archiveOldSummaries(
    paths.summaryFile, paths.summariesArchiveDir, config.summaryMaxAgeDays, now, fsImpl, statOf,
  )
  const suggestions = await cleanupExpiredSuggestions(paths.suggestionsFile, config.suggestionMaxAgeDays, now, fsImpl)
  const pending = await readPendingReview(paths.pendingReviewFile, fsImpl)
  const auditArchived = await archiveOldAuditLogs(paths.auditDir, `${paths.auditDir}/../archive/audit`, 30, now, fsImpl)
  const archivesCompressed = await consolidateHistoryArchives(paths.historyArchiveRoot, config.archiveMaxAgeDays, now, fsImpl, statOf)

  return {
    checked,
    staleFound,
    summariesArchived,
    suggestionsExpired: suggestions.removed,
    auditArchived,
    archivesCompressed,
    pendingCount: pending.length,
  }
}
