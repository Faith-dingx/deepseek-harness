import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import {
  archiveOldAuditLogs,
  archiveOldSummaries,
  cleanupExpiredSuggestions,
  consolidateHistoryArchives,
  identifyStaleContent,
  isOlderThanDays,
  runMaintenance,
  type MaintenanceFs,
} from '../src/audit-pipeline/maintenance.ts'
import type { MemoryPaths } from '../src/config.ts'
import type { ResolvedPluginConfig } from '../src/config.ts'

function memoryFs(initial: Record<string, string> = {}): MaintenanceFs & { files: Map<string, string> } {
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
    async appendFile(file, data) {
      const current = files.get(file) ?? ''
      files.set(file, current + data)
    },
    async stat() {
      return { mtimeMs: 0 }
    },
    async readdir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const first = key.slice(prefix.length).split('/')[0]
        if (first !== undefined && first !== '') names.add(first)
      }
      return [...names]
    },
    async rename(from, to) {
      const v = files.get(from)
      files.delete(from)
      files.set(to, v ?? '')
    },
    async unlink(file) { files.delete(file) },
  }
}

const paths: MemoryPaths = {
  userMemoryFile: '/u/.dsh/memory/MEMORY.md',
  userProfileFile: '/u/.dsh/memory/USER.md',
  userCalendarFile: '/u/.dsh/memory/CALENDAR.md',
  summaryFile: '/ws/.dsh-memory/conversationsummary-latest.md',
  suggestionsFile: '/ws/.dsh-memory/pending-suggestions.json',
  pendingReviewFile: '/ws/.dsh-memory/pending-review.json',
  auditDir: '/ws/.dsh-memory/audit',
  reflectionsDir: '/ws/.dsh-memory/reflections',
  historyArchiveRoot: '/ws/.dsh-memory/archive/history',
  summariesArchiveDir: '/ws/.dsh-memory/archive/summaries',
}

const config: ResolvedPluginConfig = {
  summaryEndpoint: 'http://x',
  summaryModel: 'm',
  classifyModel: 'm',
  triggerThresholdTurns: 8,
  retainRecentTurns: 2,
  pollIntervalMs: 5000,
  confirmWaitMs: 2000,
  pendingWriteTtlMs: 5000,
  classifyConfidenceThreshold: 0.6,
  archiveMaxAgeDays: 90,
  summaryMaxAgeDays: 7,
  suggestionMaxAgeDays: 7,
  maxSummaryLines: 50,
  historyArchiveRoot: null,
}

const now = new Date('2026-08-22T10:00:00Z')

describe('identifyStaleContent (计划 v18 §5.3 过时内容识别, T10)', () => {
  it('finds lines carrying temporary/pending markers', () => {
    const stale = identifyStaleContent('## 2026-08-22\n- [临时] 测试用 token\n- [待定] 方案 review\n- 正常内容\n- [等待] 上游答复\n')
    expect(stale.map(s => s.line)).toEqual([2, 3, 5])
  })

  it('returns nothing for clean content', () => {
    expect(identifyStaleContent('## 2026-08-22\n- 规则：x\n')).toEqual([])
  })
})

describe('isOlderThanDays', () => {
  it('true when the date precedes now by more than the window', () => {
    expect(isOlderThanDays(new Date('2026-08-01'), 7, now)).toBe(true)
  })
  it('false when within the window', () => {
    expect(isOlderThanDays(new Date('2026-08-20'), 7, now)).toBe(false)
  })
})

describe('cleanupExpiredSuggestions (T10 建议条目过期清理)', () => {
  it('removes entries older than the window and reports the count', async () => {
    const fresh = {
      id: 's1', timestamp: '2026-08-20T00:00:00Z', source: 'x', targetFile: '~/.dsh/memory/MEMORY.md',
      category: 'critical-rule', content: 'c', confidence: 0.8, reasoning: 'r',
    }
    const stale = { ...fresh, id: 's2', timestamp: '2026-08-01T00:00:00Z' }
    const fs = memoryFs({ '/ws/q.json': JSON.stringify({ entries: [fresh, stale] }) })
    const report = await cleanupExpiredSuggestions('/ws/q.json', 7, now, fs)
    expect(report.removed).toBe(1)
    expect(report.remainingIds).toEqual(['s1'])
    const written = JSON.parse(fs.files.get('/ws/q.json') ?? '{}') as { entries: { id: string }[] }
    expect(written.entries.map(e => e.id)).toEqual(['s1'])
  })

  it('keeps everything when nothing is stale and tolerates a missing file', async () => {
    const fresh = {
      id: 's1', timestamp: '2026-08-20T00:00:00Z', source: 'x', targetFile: '~/.dsh/memory/MEMORY.md',
      category: 'critical-rule', content: 'c', confidence: 0.8, reasoning: 'r',
    }
    const fs = memoryFs({ '/ws/q.json': JSON.stringify({ entries: [fresh] }) })
    expect((await cleanupExpiredSuggestions('/ws/q.json', 7, now, fs)).removed).toBe(0)
    expect((await cleanupExpiredSuggestions('/missing.json', 7, now, fs)).removed).toBe(0)
  })

  it('fails open when the suggestions file is unreadable/corrupt (suggestions-unreadable)', async () => {
    const fs = memoryFs({ '/ws/q.json': '{not-json!!' })
    const report = await cleanupExpiredSuggestions('/ws/q.json', 7, now, fs)
    expect(report.removed).toBe(0)
    expect(report.remainingIds).toEqual([])
  })
})

describe('archiveOldSummaries (T10 过期摘要清理)', () => {
  it('moves a stale summary into archive/summaries under its day name', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/conversationsummary-latest.md': '# 对话历史摘要\nbody\n' })
    const archived = await archiveOldSummaries('/ws/.dsh-memory/conversationsummary-latest.md', '/ws/.dsh-memory/archive/summaries', 7, now, fs, () => ({ mtimeMs: Date.parse('2026-08-01T00:00:00Z') }))
    expect(archived).toContain('/ws/.dsh-memory/archive/summaries/2026-08-01.md')
    expect(fs.files.get('/ws/.dsh-memory/archive/summaries/2026-08-01.md')).toContain('对话历史摘要')
    // 原文件已被移动（删除）
    expect(fs.files.has('/ws/.dsh-memory/conversationsummary-latest.md')).toBe(false)
  })

  it('keeps a fresh summary in place', async () => {
    const fs = memoryFs({ '/ws/x.md': 'body' })
    const archived = await archiveOldSummaries('/ws/x.md', '/ws/archive', 7, now, fs, () => ({ mtimeMs: now.getTime() }))
    expect(archived).toEqual([])
    expect(fs.files.has('/ws/x.md')).toBe(true)
  })

  it('tolerates a missing summary file', async () => {
    const fs = memoryFs()
    expect(await archiveOldSummaries('/ws/gone.md', '/ws/archive', 7, now, fs, () => ({ mtimeMs: 0 }))).toEqual([])
  })

  it('supports the real stat path when statOverride is omitted (fsImpl.stat branch)', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/conversationsummary-latest.md': '# 对话历史摘要\nbody\n' })
    const archived = await archiveOldSummaries('/ws/.dsh-memory/conversationsummary-latest.md', '/ws/.dsh-memory/archive/summaries', 7, now, fs)
    // memoryFs.stat 返回 mtimeMs: 0 → 必然超龄 → 归档
    expect(archived).toHaveLength(1)
    expect(fs.files.has('/ws/.dsh-memory/conversationsummary-latest.md')).toBe(false)
  })
})

describe('consolidateHistoryArchives (T10 归档区整理, 90天 gzip)', () => {
  it('compresses archive .md files older than the window to <date>.md.gz and removes the source', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/archive/history/sess1/2026-05-01.md': 'stale content\n' })
    const compressed = await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs, () => ({ mtimeMs: Date.parse('2026-05-01T00:00:00Z') }))
    expect(compressed).toContain('/ws/.dsh-memory/archive/history/sess1/2026-05-01.md.gz')
    const gz = fs.files.get('/ws/.dsh-memory/archive/history/sess1/2026-05-01.md.gz')
    expect(gz).toBeDefined()
    expect(gunzipSync(Buffer.from(gz!, 'base64')).toString('utf8')).toBe('stale content\n')
    expect(fs.files.has('/ws/.dsh-memory/archive/history/sess1/2026-05-01.md')).toBe(false)
  })

  it('keeps fresh archives and already-gzipped files untouched', async () => {
    const fs = memoryFs({
      '/ws/.dsh-memory/archive/history/sess1/2026-08-20.md': 'fresh\n',
      '/ws/.dsh-memory/archive/history/sess1/2026-05-01.md.gz': 'already',
    })
    const compressed = await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs, file => ({
      mtimeMs: file.includes('2026-08-20') ? now.getTime() : Date.parse('2026-05-01T00:00:00Z'),
    }))
    expect(compressed).toEqual([])
  })

  it('skips hidden session dirs, unreadable dirs, and stat failures (fail-open)', async () => {
    // 隐藏目录（.开头）被跳过
    const fs = memoryFs({ '/ws/.dsh-memory/archive/history/.hidden/2026-05-01.md': 'x\n' })
    expect(await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs)).toEqual([])
    // session 目录 readdir 失败 → per-session continue（覆盖 L151）
    const fs2 = memoryFs({ '/ws/.dsh-memory/archive/history/sess1/2026-05-01.md': 'x\n' })
    const originalReaddir = fs2.readdir.bind(fs2)
    fs2.readdir = async (dir: string) => {
      if (dir.endsWith('/sess1')) throw new Error('EACCES')
      return originalReaddir(dir)
    }
    expect(await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs2)).toEqual([])
    // statOverride undefined → 走 fsImpl.stat(2026-05-01) → 超龄 → 压缩（覆盖 L159 + B#8 else 分支）
    const fs3 = memoryFs({ '/ws/.dsh-memory/archive/history/sess1/2026-05-01.md': 'x\n' })
    const compressed = await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs3)
    expect(compressed).toContain('/ws/.dsh-memory/archive/history/sess1/2026-05-01.md.gz')
    // stat 失败 → per-file continue（覆盖 L161）
    const fs4 = memoryFs({ '/ws/.dsh-memory/archive/history/sess1/2026-05-01.md': 'x\n' })
    expect(await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, fs4, () => { throw new Error('EIO') })).toEqual([])
  })

  it('returns [] when the archive root is unreadable or absent', async () => {
    // 根目录 readdir 失败 → 直接返回 []（覆盖 L142）
    const fs = memoryFs()
    const failRoot: MaintenanceFs & { files: Map<string, string> } = {
      ...fs,
      async readdir() { throw new Error('EACCES') },
    }
    expect(await consolidateHistoryArchives('/ws/.dsh-memory/archive/history', 90, now, failRoot)).toEqual([])
    // 目录不存在（readdir 为空）→ 无变化
    expect(await consolidateHistoryArchives('/no/such/root', 90, now, memoryFs())).toEqual([])
  })
})

describe('archiveOldAuditLogs (T10 审计日志归档 30天)', () => {
  it('moves stale audit logs into the audit archive', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/audit/audit-2026-07-01.log': 'line\n' })
    const archived = await archiveOldAuditLogs('/ws/.dsh-memory/audit', '/ws/.dsh-memory/archive/audit', 30, now, fs)
    expect(archived).toEqual(['/ws/.dsh-memory/archive/audit/audit-2026-07-01.log'])
  })

  it('keeps recent audit logs', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/audit/audit-2026-08-22.log': 'line\n' })
    expect(await archiveOldAuditLogs('/ws/.dsh-memory/audit', '/ws/.dsh-memory/archive/audit', 30, now, fs)).toEqual([])
  })

  it('skips non-audit files and tolerates a missing audit dir', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/audit/README.md': 'x\n' })
    expect(await archiveOldAuditLogs('/ws/.dsh-memory/audit', '/ws/.dsh-memory/archive/audit', 30, now, fs)).toEqual([])
    expect(await archiveOldAuditLogs('/no/audit/dir', '/ws/.dsh-memory/archive/audit', 30, now, fs)).toEqual([])
  })

  it('fails open when the audit dir is unreadable', async () => {
    const fs = memoryFs({ '/ws/.dsh-memory/audit/audit-2026-05-01.log': 'x\n' })
    const originalReaddir = fs.readdir.bind(fs)
    fs.readdir = async (dir: string) => {
      if (dir.endsWith('/audit')) throw new Error('EACCES')
      return originalReaddir(dir)
    }
    expect(await archiveOldAuditLogs('/ws/.dsh-memory/audit', '/ws/.dsh-memory/archive/audit', 30, now, fs)).toEqual([])
  })
})

describe('runMaintenance (计划 v18 §5.3 维护流程, T10)', () => {
  it('runs the full maintenance pass and reports its actions', async () => {
    const fs = memoryFs({
      '/ws/.dsh-memory/conversationsummary-latest.md': '# 对话历史摘要\n> 生成时间：2026-08-01\n> 覆盖范围：第 3-8 轮\n> 压缩策略：x\n## Primary Request\n- p\n## Key Concepts\n- k\n## Files\n- f\n## Errors\n- e\n## Pending Jobs\n- j\n',
      '/ws/.dsh-memory/pending-suggestions.json': JSON.stringify({
        entries: [{
          id: 'old', timestamp: '2026-08-01T00:00:00Z', source: 'x', targetFile: '~/.dsh/memory/MEMORY.md',
          category: 'critical-rule', content: 'c', confidence: 0.8, reasoning: 'r',
        }],
      }),
      '/ws/.dsh-memory/2026-08-22.md': '## 2026-08-22\n- [临时] 一次性 token\n- 完成：guard 上线\n',
      '/ws/.dsh-memory/reflections/2026-08-22.md': '# 反思 2026-08-22\n\n## 成果回顾\n- ok\n',
      '/u/.dsh/memory/MEMORY.md': '## 2026-08-22\n- 规则：x\n',
      '/u/.dsh/memory/USER.md': '## 2026-08-22\n- 规则：y\n',
      '/u/.dsh/memory/CALENDAR.md': 'appointment\n',
    })
    const report = await runMaintenance(paths, config, now, fs, {
      statOf: () => ({ mtimeMs: Date.parse('2026-08-01T00:00:00Z') }),
      targets: [
        '/u/.dsh/memory/MEMORY.md',
        '/u/.dsh/memory/USER.md',
        '/u/.dsh/memory/CALENDAR.md',
        '/ws/.dsh-memory/conversationsummary-latest.md',
        '/ws/.dsh-memory/pending-suggestions.json',
        '/ws/.dsh-memory/2026-08-22.md',
        '/ws/.dsh-memory/reflections/2026-08-22.md',
      ],
    })
    expect(report.suggestionsExpired).toBe(1)
    expect(report.summariesArchived.length).toBe(1)
    expect(report.checked.length).toBe(7)
    expect(report.staleFound).toBe(1)
    expect(report.pendingCount).toBeGreaterThanOrEqual(0)
  })

  it('handles a clean workspace with no maintenance actions', async () => {
    const fs = memoryFs()
    const report = await runMaintenance(paths, config, now, fs, { statOf: () => ({ mtimeMs: now.getTime() }) })
    expect(report.suggestionsExpired).toBe(0)
    expect(report.summariesArchived).toEqual([])
    expect(report.auditArchived).toEqual([])
    expect(report.archivesCompressed).toEqual([])
    expect(report.staleFound).toBe(0)
  })

  it('uses the real fsImpl.stat when statOf is omitted (default stat path)', async () => {
    const fs = memoryFs({
      '/u/.dsh/memory/MEMORY.md': '## 2026-08-22\n- 规则：x\n',
      '/ws/.dsh-memory/pending-suggestions.json': JSON.stringify({ entries: [] }),
    })
    const report = await runMaintenance(paths, config, now, fs)
    // memoryFs.stat 返回 mtimeMs 0 → 视为不存在 → 全部跳过
    expect(report.checked).toEqual([])
    expect(report.staleFound).toBe(0)
  })

  it('skips targets that do not exist, have zero mtime, or fail stat (exists=false paths)', async () => {
    const fs = memoryFs({
      '/u/.dsh/memory/MEMORY.md': '## 2026-08-22\n- 规则：x\n',
      '/ws/.dsh-memory/conversationsummary-latest.md': '# 对话历史摘要\nbody\n',
    })
    const report = await runMaintenance(paths, config, now, fs, {
      statOf: (file) => {
        if (file.includes('USER.md')) throw new Error('ENOENT') // stat 失败 → 跳过
        if (file.includes('CALENDAR.md')) return { mtimeMs: 0 } // mtime 0 → 视为不存在
        if (file.includes('pending-suggestions')) return { mtimeMs: 0 } // 不存在
        return { mtimeMs: now.getTime() }
      },
    })
    expect(report.checked).not.toContain(paths.userProfileFile)
    expect(report.checked).not.toContain(paths.userCalendarFile)
    expect(report.checked).toContain(paths.userMemoryFile)
  })
})
