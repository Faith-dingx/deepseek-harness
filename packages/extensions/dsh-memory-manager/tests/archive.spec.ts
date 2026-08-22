import { describe, expect, it } from 'vitest'
import {
  applyApprovedSuggestionEntry,
  applyNormalization,
  appendPendingReview,
  buildPendingReviewEntry,
  readPendingReview,
  resolvePendingReview,
  type ArchiveFs,
} from '../src/audit-pipeline/archive.ts'
import type { SuggestionEntry } from '../src/shared/validators.ts'
import type { AuditFs } from '../src/shared/logger.ts'

function memoryFs(initial: Record<string, string> = {}): ArchiveFs & AuditFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async readFile(file) {
      const value = files.get(file)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async writeFile(file, data) { files.set(file, data) },
    async mkdir() {},
    async appendFile(file, data) {
      const current = files.get(file) ?? ''
      files.set(file, current + data)
    },
  }
}

const now = new Date('2026-08-22T10:00:00Z')

describe('buildPendingReviewEntry (计划 v18 §5.2 步骤⑤, T8)', () => {
  it('builds a complete entry with id/type/time', () => {
    const entry = buildPendingReviewEntry('/ws/x.md', 3, '- 今天天气不错', now)
    expect(entry.id).toMatch(/^review-\d{8}-/)
    expect(entry.file).toBe('/ws/x.md')
    expect(entry.line).toBe(3)
    expect(entry.content).toBe('- 今天天气不错')
    expect(entry.time).toBe('2026-08-22T10:00:00.000Z')
    expect(entry.status).toBe('pending')
  })
})

describe('readPendingReview / appendPendingReview / resolvePendingReview (T8 待处理队列)', () => {
  it('reads an empty or missing queue as empty', async () => {
    expect(await readPendingReview('/nope.json', memoryFs())).toEqual([])
  })

  it('appends a new entry and deduplicates an identical file+line', async () => {
    const fs = memoryFs()
    const entry = buildPendingReviewEntry('/ws/x.md', 2, '- 内容', now)
    await appendPendingReview('/ws/q.json', entry, fs)
    await appendPendingReview('/ws/q.json', entry, fs)
    const entries = await readPendingReview('/ws/q.json', fs)
    expect(entries).toHaveLength(1)
    // 文件落盘为 JSON 数组
    expect(fs.files.get('/ws/q.json')).toContain('review-')
  })

  it('resolves a pending entry after the user decides (从队列移除)', async () => {
    const fs = memoryFs()
    const entry = buildPendingReviewEntry('/ws/x.md', 5, '- 内容', now)
    await appendPendingReview('/ws/q.json', entry, fs)
    const resolved = await resolvePendingReview('/ws/q.json', '/ws/x.md', 5, fs)
    expect(resolved).toBe(true)
    expect(await readPendingReview('/ws/q.json', fs)).toEqual([])
  })

  it('resolve returns false when nothing matches', async () => {
    expect(await resolvePendingReview('/nope.json', '/ws/x.md', 1, memoryFs())).toBe(false)
  })

  it('treats a non-array entries payload as empty AND handles a path without a directory', async () => {
    const fs = memoryFs({ '/ws/q.json': JSON.stringify({ entries: 42 }) })
    expect(await readPendingReview('/ws/q.json', fs)).toEqual([])
    const entry = buildPendingReviewEntry('/ws/x.md', 1, 'x', now)
    await appendPendingReview('q.json', entry, fs)
    // 无 '/' 的路径 → requireDir('.') 分支
    const entries = await readPendingReview('q.json', fs)
    expect(entries).toHaveLength(1)
  })

  it('applies normalization with the default now when options.now is omitted', async () => {
    const fs = memoryFs({ '/ws/x.md': '-x\n' })
    const result = await applyNormalization('/ws/x.md', 'memory', '-x\n', { audit: async () => {} }, fs)
    expect(result.fixed).toBe(true)
  })

  it('tolerates a corrupted queue file (fail-open: treats as empty on re-append)', async () => {
    const fs = memoryFs({ '/ws/q.json': '{ broken' })
    const read = await readPendingReview('/ws/q.json', fs)
    expect(read).toEqual([])
    const entry = buildPendingReviewEntry('/ws/x.md', 1, 'x', now)
    await appendPendingReview('/ws/q.json', entry, fs)
    expect((await readPendingReview('/ws/q.json', fs)).length).toBe(1)
  })
})

describe('applyNormalization (计划 v18 §5.2 步骤⑤ 归档修改, T6/T7/T8)', () => {
  it('writes back the auto-fixed content when fixable issues exist (格式自动修正)', async () => {
    const fs = memoryFs({ '/ws/x.md': '-x\n- 规则：y\n' })
    const result = await applyNormalization('/ws/x.md', 'memory', '-x\n- 规则：y\n', {
      now,
      audit: async () => {},
    }, fs)
    expect(result.fixed).toBe(true)
    expect(fs.files.get('/ws/x.md')).toContain('## 2026-08-22')
    expect(fs.files.get('/ws/x.md')).toContain('- x\n')
  })

  it('flags out-of-category content into pending-review without touching the file (超三类标记询问)', async () => {
    const fs = memoryFs({ '/ws/x.md': '## 2026-08-22\n- 今天天气不错\n' })
    const result = await applyNormalization('/ws/x.md', 'memory', '## 2026-08-22\n- 今天天气不错\n', {
      now,
      pendingReviewPath: '/ws/q.json',
      audit: async () => {},
    }, fs)
    expect(result.flagged).toBe(true)
    // 文件内容未被修改
    expect(fs.files.get('/ws/x.md')).toBe('## 2026-08-22\n- 今天天气不错\n')
    const pending = await readPendingReview('/ws/q.json', fs)
    expect(pending.some(e => e.file === '/ws/x.md' && e.line === 2)).toBe(true)
  })

  it('冲突语义: 超三类内容绝不自动写入记忆文件 (T8 核心验证)', async () => {
    const fs = memoryFs({ '/ws/x.md': '## 2026-08-22\n- 今天天气不错\n' })
    await applyNormalization('/ws/x.md', 'memory', '## 2026-08-22\n- 今天天气不错\n', { now, audit: async () => {} }, fs)
    // 内容里没有注入任何 [待决] 标记——待决只在 pending-review.json, 文件保持原样
    expect(fs.files.get('/ws/x.md') ?? '').not.toContain('[待决]')
  })

  it('no issues: neither fixes nor flags, leaves file alone', async () => {
    const fs = memoryFs({ '/ws/x.md': '## 2026-08-22\n- 规则：x\n' })
    const result = await applyNormalization('/ws/x.md', 'memory', '## 2026-08-22\n- 规则：x\n', { now, audit: async () => {} }, fs)
    expect(result.fixed).toBe(false)
    expect(result.flagged).toBe(false)
  })

  it('fails open: file write errors surface as fixed=false without throwing', async () => {
    const broken: ArchiveFs = {
      async readFile() { throw new Error('EACCES') },
      async writeFile() { throw new Error('EACCES') },
      async mkdir() {},
    }
    const result = await applyNormalization('/locked.md', 'memory', '- 规则：x\n', { now, audit: async () => {} }, broken)
    expect(result.fixed).toBe(false)
    expect(result.flagged).toBe(false)
  })

  it('records an audit line when the fix changed the file (步骤⑥)', async () => {
    const fs = memoryFs({ '/ws/x.md': '-x\n' })
    const auditLines: string[] = []
    const result = await applyNormalization('/ws/x.md', 'memory', '-x\n', {
      now,
      audit: async (dir, entry) => { auditLines.push(`${dir}:${entry.event}`) },
    }, fs)
    expect(result.fixed).toBe(true)
    expect(auditLines.some(l => l.includes('normalize-fixed'))).toBe(true)
  })

  it('applyNormalization default audit appends through the shared logger', async () => {
    const fs = memoryFs({ '/ws/x.md': '-x\n' })
    const auditFs = memoryFs()
    const result = await applyNormalization('/ws/x.md', 'memory', '-x\n', { now }, { ...fs, ...auditFs })
    expect(result.fixed).toBe(true)
  })

  it('defaults `now` to the current time when omitted (options.now 缺省)', async () => {
    const fs = memoryFs({ '/ws/x.md': '## 2026-08-22\n- 今天天气不错\n' })
    const result = await applyNormalization('/ws/x.md', 'memory', '## 2026-08-22\n- 今天天气不错\n', {
      pendingReviewPath: '/ws/q.json',
      audit: async () => {},
    }, fs)
    expect(result.flagged).toBe(true)
    // pending-review 用缺省 now 生成条目 → 文件确实被写入
    const pending = await readPendingReview('/ws/q.json', fs)
    expect(pending.length).toBe(1)
    expect(pending[0]?.line).toBe(2)
  })
})

describe('applyApprovedSuggestionEntry (计划 v18 §5.2 步骤⑤ 建议条目确认, T8)', () => {
  const suggestion: SuggestionEntry = {
    id: 'sugg-1',
    timestamp: '2026-08-22T10:00:00Z',
    source: 'history-compressor/classify',
    targetFile: '/home/u/.dsh/memory/MEMORY.md',
    category: 'critical-rule',
    content: '用户偏好：工作完成后立即记录',
    confidence: 0.85,
    reasoning: '跨任务有效',
  }

  it('appends the suggestion content into the target memory file under a date heading', async () => {
    const fs = memoryFs({ '/home/u/.dsh/memory/MEMORY.md': '## 2026-08-22\n- 规则：x\n' })
    await applyApprovedSuggestionEntry(suggestion, fs, now)
    const updated = fs.files.get('/home/u/.dsh/memory/MEMORY.md') ?? ''
    expect(updated).toContain('- 用户偏好：工作完成后立即记录')
    // 已有标题复用, 不重复追加
    expect(updated.match(/## 2026-08-22/g)).toHaveLength(1)
  })

  it('creates the target file plus heading when missing', async () => {
    const fs = memoryFs()
    await applyApprovedSuggestionEntry(suggestion, fs, now)
    const updated = fs.files.get('/home/u/.dsh/memory/MEMORY.md') ?? ''
    expect(updated.startsWith('## 2026-08-22\n')).toBe(true)
    expect(updated).toContain('用户偏好')
  })

  it('fails open: a write failure resolves instead of throwing', async () => {
    const broken: ArchiveFs = {
      async readFile() { return 'x' },
      async writeFile() { throw new Error('EACCES') },
      async mkdir() {},
    }
    await expect(applyApprovedSuggestionEntry(suggestion, broken, now)).resolves.toBeUndefined()
  })
})
