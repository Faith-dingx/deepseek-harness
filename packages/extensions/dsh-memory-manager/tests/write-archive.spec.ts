import { describe, expect, it } from 'vitest'
import {
  appendSuggestionEntries,
  buildSuggestionEntry,
  historyArchivePath,
  writeHistoryArchive,
  type ArchiveWriteFs,
  type ArchivedSegment,
} from '../src/history-compressor/write-archive.ts'
import type { WriteSource } from '../src/config.ts'
import { parseSuggestionEntries } from '../src/shared/validators.ts'

function memoryFs(initial: Record<string, string> = {}): ArchiveWriteFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async readFile(file) {
      const v = files.get(file)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeFile(file, data) { files.set(file, data) },
    async mkdir() {},
  }
}

const now = new Date('2026-08-22T10:30:00Z')

describe('historyArchivePath (计划 v18 §3.7 归档路径规范)', () => {
  it('builds <root>/<session-id>/<YYYY-MM-DD>.md', () => {
    expect(historyArchivePath('/ws/.dsh-memory/archive/history', 'abc123', now)).toBe(
      '/ws/.dsh-memory/archive/history/abc123/2026-08-22.md',
    )
  })
})

describe('buildSuggestionEntry (计划 v18 §4.2.3 建议条目格式)', () => {
  it('maps rule-like content to the user memory file with critical-rule category', () => {
    const entry = buildSuggestionEntry({ turnId: 't3', content: '用户偏好：工作完成后立即记录' }, now, '~/.dsh/memory/MEMORY.md')
    expect(entry.id).toMatch(/^sugg-\d{8}-/)
    expect(entry.targetFile).toBe('~/.dsh/memory/MEMORY.md')
    expect(entry.category).toBe('critical-rule')
    expect(entry.source).toBe('history-compressor/classify')
    expect(entry.confidence).toBeGreaterThan(0)
  })
})

describe('buildSuggestionEntry category mapping (三类 → 建议条目类别)', () => {
  it('maps a file-pointer line to the file-pointer category', () => {
    const entry = buildSuggestionEntry({ turnId: 't1', content: '项目指针：docs/CHANGELOG.md' }, now, '~/.dsh/memory/MEMORY.md')
    expect(entry.category).toBe('file-pointer')
  })
  it('maps a work-log line to the work-log-pointer category', () => {
    const entry = buildSuggestionEntry({ turnId: 't1', content: '完成：guard 上线' }, now, '~/.dsh/memory/MEMORY.md')
    expect(entry.category).toBe('work-log-pointer')
  })
})

describe('appendSuggestionEntries (T14 建议条目写入 + pendingWrite 注册)', () => {
  it('registers pendingWrite before writing and appends entries', async () => {
    const fs = memoryFs()
    const registered: string[] = []
    const entry = buildSuggestionEntry({ turnId: 't1', content: '规则：x' }, now, '~/.dsh/memory/MEMORY.md')
    await appendSuggestionEntries('/ws/q.json', [entry], (file, source) => { registered.push(`${file}:${source}`) }, fs)
    expect(registered).toEqual(['/ws/q.json:history-compressor'])
    const parsed = parseSuggestionEntries(fs.files.get('/ws/q.json') ?? '')
    expect(parsed.entries).toHaveLength(1)
  })

  it('keeps existing entries when appending (单文件追加)', async () => {
    const existing = buildSuggestionEntry({ turnId: 't0', content: '旧建议' }, new Date('2026-08-20'), '~/.dsh/memory/MEMORY.md')
    const fs = memoryFs({ '/ws/q.json': JSON.stringify({ entries: [existing] }) })
    const added = buildSuggestionEntry({ turnId: 't1', content: '新建议' }, now, '~/.dsh/memory/MEMORY.md')
    await appendSuggestionEntries('/ws/q.json', [added], () => {}, fs)
    const parsed = parseSuggestionEntries(fs.files.get('/ws/q.json') ?? '')
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.issues).toEqual([])
  })

  it('falls back to an empty list when the existing suggestions file is corrupted JSON', async () => {
    const fs = memoryFs({ '/ws/q.json': '{ nope' })
    const entry = buildSuggestionEntry({ turnId: 't1', content: '规则：x' }, now, '~/.dsh/memory/MEMORY.md')
    await appendSuggestionEntries('/ws/q.json', [entry], () => {}, fs)
    const parsed = parseSuggestionEntries(fs.files.get('/ws/q.json') ?? '')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.issues).toEqual([])
  })

  it('fails open: a write failure resolves without throwing', async () => {
    const broken: ArchiveWriteFs = {
      async readFile() { throw new Error('EACCES') },
      async writeFile() { throw new Error('EACCES') },
      async mkdir() {},
    }
    const entry = buildSuggestionEntry({ turnId: 't1', content: 'x' }, now, '~/.dsh/memory/MEMORY.md')
    await expect(appendSuggestionEntries('/ws/q.json', [entry], () => {}, broken)).resolves.toBeUndefined()
  })
})

describe('writeHistoryArchive default register (no registerPendingWrite)', () => {
  it('writes a session archive with valuable segments and a NOOP register default', async () => {
    const fs = memoryFs()
    const result = await writeHistoryArchive({
      sessionId: 's1', date: now,
      staleSegments: [], uselessSegments: [], valuableSegments: [{ turnId: 'u1', content: '规则：跨会话' }],
      archiveRoot: '/r', suggestionsPath: '/r/s.json', userMemoryTarget: '/u/MEMORY.md',
    }, fs)
    // register 缺省走 noop, 归档照常
    expect(result.archiveFile).toBe('/r/s1/2026-08-22.md')
    expect(fs.files.get('/r/s.json')).toContain('sugg-')
  })
})

describe('writeHistoryArchive (计划 v18 §4.2.3 归档处理, T14)', () => {
  const stale: ArchivedSegment[] = [{ turnId: 't3', content: '已完成子任务 guard 修复' }]
  const useless: ArchivedSegment[] = [{ turnId: 't4', content: '闲聊：今天天气不错' }]
  const valuable: ArchivedSegment[] = [{ turnId: 't5', content: '用户偏好：工作完成后立即记录' }]

  it('auto-creates the session directory on first write (T14 目录自动创建)', async () => {
    const fs = memoryFs()
    const result = await writeHistoryArchive({
      sessionId: 'abc123',
      date: now,
      staleSegments: stale,
      uselessSegments: useless,
      valuableSegments: valuable,
      archiveRoot: '/ws/.dsh-memory/archive/history',
      suggestionsPath: '/ws/.dsh-memory/pending-suggestions.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: () => {},
    }, fs)
    expect(result.archiveFile).toBe('/ws/.dsh-memory/archive/history/abc123/2026-08-22.md')
    expect(fs.files.get(result.archiveFile)).toContain('# 归档历史：2026-08-22')
    expect(result.suggestionsCount).toBe(1)
    // 建议条目已写入
    expect(fs.files.get('/ws/.dsh-memory/pending-suggestions.json')).toContain('sugg-')
  })

  it('annotates archive entries with source turn and archive reason (§3.7)', async () => {
    const fs = memoryFs()
    await writeHistoryArchive({
      sessionId: 's1',
      date: now,
      staleSegments: stale,
      uselessSegments: useless,
      valuableSegments: [],
      archiveRoot: '/ws/.dsh-memory/archive/history',
      suggestionsPath: '/ws/q.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: () => {},
    }, fs)
    const text = fs.files.get('/ws/.dsh-memory/archive/history/s1/2026-08-22.md') ?? ''
    expect(text).toContain('## 过时内容')
    expect(text).toContain('## 无用内容')
    expect(text).toContain('- (t3) 已完成子任务 guard 修复')
    expect(text).toContain('> 会话：s1')
    expect(text).toContain('> 归档原因：内容过时/对当前任务无用')
  })

  it('merges into the same-day file of the same session instead of overwriting', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/archive/history/s1/2026-08-22.md': '# 归档历史：2026-08-22\n> 会话：s1\n' })
    await writeHistoryArchive({
      sessionId: 's1',
      date: now,
      staleSegments: [{ turnId: 't9', content: '更多过时内容' }],
      uselessSegments: [],
      valuableSegments: [],
      archiveRoot: '/ws/.dsh-memory/archive/history',
      suggestionsPath: '/ws/q.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: () => {},
    }, fs)
    const text = fs.files.get('/ws/.dsh-memory/archive/history/s1/2026-08-22.md') ?? ''
    expect(text).toContain('更多过时内容')
    // 原有内容保留（合并而非覆盖）
    expect(text.startsWith('# 归档历史：2026-08-22')).toBe(true)
  })

  it('fails open: an archive write failure resolves without throwing', async () => {
    const broken: ArchiveWriteFs = {
      async readFile() { throw new Error('EACCES') },
      async writeFile() { throw new Error('EACCES') },
      async mkdir() {},
    }
    const result = await writeHistoryArchive({
      sessionId: 's1',
      date: now,
      staleSegments: stale,
      uselessSegments: [],
      valuableSegments: [],
      archiveRoot: '/ws/root',
      suggestionsPath: '/ws/q.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: () => {},
    }, broken)
    expect(result.archiveFile).toBe('/ws/root/s1/2026-08-22.md')
  })

  it('registers the pending-write for the suggestion file (审核管线识别写入源)', async () => {
    const fs = memoryFs()
    const registered: Array<[string, WriteSource]> = []
    await writeHistoryArchive({
      sessionId: 's1',
      date: now,
      staleSegments: [],
      uselessSegments: [],
      valuableSegments: [{ turnId: 't1', content: '规则：跨会话有效' }],
      archiveRoot: '/ws/.dsh-memory/archive/history',
      suggestionsPath: '/ws/.dsh-memory/pending-suggestions.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: (file, source) => { registered.push([file, source]) },
    }, fs)
    expect(registered).toEqual([['/ws/.dsh-memory/pending-suggestions.json', 'history-compressor']])
  })

  it('a no-segments run still creates the empty annotated archive', async () => {
    const fs = memoryFs()
    const result = await writeHistoryArchive({
      sessionId: 's1',
      date: now,
      staleSegments: [],
      uselessSegments: [],
      valuableSegments: [],
      archiveRoot: '/ws/.dsh-memory/archive/history',
      suggestionsPath: '/ws/q.json',
      userMemoryTarget: '~/.dsh/memory/MEMORY.md',
      registerPendingWrite: () => {},
    }, fs)
    expect(fs.files.get(result.archiveFile)).toContain('## 过时内容')
  })
})
