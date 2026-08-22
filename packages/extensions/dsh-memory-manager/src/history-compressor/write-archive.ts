/**
 * 归档处理 (计划 v18 §4.2.3 / T14): write the stale/useless segments into the
 * per-session, per-day history archive (目录自动创建 on first write, same-day
 * merge), and turn valuable-but-not-current segments into suggestion entries
 * in pending-suggestions.json. The suggestion file sits INSIDE the audit
 * pipeline's watch list, so its write registers a pendingWrite entry
 * (history-compressor source) BEFORE writing — the watcher then identifies
 * the source without guessing. The archive itself is NOT in SHORT_TERM_FILES:
 * archive writes never re-trigger the audit pipeline (避免循环触发).
 * Every write is fail-open.
 *
 * @module dsh-memory-manager/history-compressor/write-archive
 */

import { classifyEntryLine } from '../shared/validators.ts'
import type { SuggestionEntry } from '../shared/validators.ts'
import type { WriteSource } from '../config.ts'

/** File-system surface for archive writes; injectable for tests. */
export interface ArchiveWriteFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
}

/** One segment to archive (kept verbatim, never 删减 — 可检索). */
export interface ArchivedSegment {
  readonly turnId: string
  readonly content: string
}

/** The full archive write command (输出按类别分发). */
export interface HistoryArchiveCommand {
  readonly sessionId: string
  readonly date: Date
  readonly staleSegments: readonly ArchivedSegment[]
  readonly uselessSegments: readonly ArchivedSegment[]
  readonly valuableSegments: readonly ArchivedSegment[]
  readonly archiveRoot: string
  readonly suggestionsPath: string
  readonly userMemoryTarget: string
  readonly registerPendingWrite?: (file: string, source: WriteSource) => void
}

/** `<root>/<session-id>/<YYYY-MM-DD>.md` (计划 v18 §3.7). */
export function historyArchivePath(root: string, sessionId: string, date: Date): string {
  return `${root}/${sessionId}/${date.toISOString().slice(0, 10)}.md`
}

/**
 * Build a suggestion entry for one valuable-but-not-current segment. Target
 * file + category follow the three content rules: rule-like lines go to the
 * user memory file as critical-rule; the classification is a hint — the
 * pipeline validates structure and category match, never content semantics
 * (方案 B).
 */
export function buildSuggestionEntry(segment: ArchivedSegment, now: Date, userMemoryTarget: string): SuggestionEntry {
  const stamp = now.getTime()
  const day = now.toISOString().slice(0, 10).replaceAll('-', '')
  const category = classifyEntryLine(segment.content)
  const categoryName = category === 'file-pointer' ? 'file-pointer' : category === 'work-log-pointer' ? 'work-log-pointer' : 'critical-rule'
  return {
    id: `sugg-${day}-${stamp}`,
    timestamp: now.toISOString(),
    source: 'history-compressor/classify',
    targetFile: userMemoryTarget,
    category: categoryName,
    content: segment.content,
    confidence: 0.8,
    reasoning: 'valuable-but-not-current, 待用户确认',
  }
}

/** Read the suggestion file text or '' when absent/corrupt (fail-open). */
async function readSuggestions(path: string, fsImpl: ArchiveWriteFs): Promise<string> {
  try {
    return await fsImpl.readFile(path)
  } catch {
    return ''
  }
}

/**
 * Append suggestion entries to pending-suggestions.json, registering the
 * pendingWrite BEFORE the write (识别写入源为 history-compressor). Fail-open.
 */
export async function appendSuggestionEntries(
  path: string,
  entries: readonly SuggestionEntry[],
  registerPendingWrite: (file: string, source: WriteSource) => void,
  fsImpl: ArchiveWriteFs,
): Promise<void> {
  try {
    registerPendingWrite(path, 'history-compressor')
    const existing = await readSuggestions(path, fsImpl)
    let parsed: SuggestionEntry[] = []
    if (existing.trim().length > 0) {
      try {
        const data: unknown = JSON.parse(existing)
        const list = (data as { entries?: unknown } | null)?.entries
        if (Array.isArray(list)) parsed = list as SuggestionEntry[]
      } catch {
        parsed = []
      }
    }
    const merged = [...parsed, ...entries]
    await fsImpl.writeFile(path, `${JSON.stringify({ entries: merged }, null, 2)}\n`)
  } catch {
    // fail-open: suggestion write failures never break compression.
  }
}

/**
 * Write the history archive for one turn window: auto-create the session
 * directory, merge into the same-day file (§3.7 format with per-category
 * sections and provenance), and persist the suggestion entries. Fail-open.
 */
export async function writeHistoryArchive(
  command: HistoryArchiveCommand,
  fsImpl: ArchiveWriteFs,
): Promise<{ archiveFile: string; suggestionsCount: number }> {
  const archiveFile = historyArchivePath(command.archiveRoot, command.sessionId, command.date)
  const day = command.date.toISOString().slice(0, 10)
  const suggestionsCount = command.valuableSegments.length

  try {
    await fsImpl.mkdir(`${command.archiveRoot}/${command.sessionId}`, { recursive: true })
    let existing = ''
    try {
      existing = await fsImpl.readFile(archiveFile)
    } catch {
      existing = ''
    }
    const isNew = existing.trim().length === 0
    const base = isNew
      ? `# 归档历史：${day}\n\n> 会话：${command.sessionId}\n> 归档时间：${command.date.toISOString()}\n> 归档原因：内容过时/对当前任务无用\n> 来源轮次：第 3-8 轮（已压缩）\n`
      : existing.replace(/\n$/, '')
    const section = (title: string, segments: readonly ArchivedSegment[]): string => {
      const lines = segments.map(s => `- (${s.turnId}) ${s.content}`)
      return lines.length > 0 ? `\n## ${title}\n${lines.join('\n')}\n` : `\n## ${title}\n-（无）\n`
    }
    const body = `${base}${isNew ? '\n' : ''}${section('过时内容', command.staleSegments)}${section('无用内容', command.uselessSegments)}`
    await fsImpl.writeFile(archiveFile, body)

    if (command.valuableSegments.length > 0) {
      const entries = command.valuableSegments.map(segment => buildSuggestionEntry(segment, command.date, command.userMemoryTarget))
      await appendSuggestionEntries(command.suggestionsPath, entries, command.registerPendingWrite ?? (() => {}), fsImpl)
    }
  } catch {
    // fail-open: an archive failure resolves; the caller still reports paths.
  }
  return { archiveFile, suggestionsCount }
}
