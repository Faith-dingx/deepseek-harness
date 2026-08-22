import { describe, expect, it } from 'vitest'
import { MtimeWatcher, scanShortTermFiles, type ScanFs, type WatchFs } from '../src/audit-pipeline/watcher.ts'
import type { MemoryPaths } from '../src/config.ts'

function memoryFs(): WatchFs & { files: Map<string, { mtimeMs: number }> } {
  const files = new Map<string, { mtimeMs: number }>()
  return {
    files,
    async stat(file) {
      const entry = files.get(file)
      if (entry === undefined) throw new Error('ENOENT')
      return { mtimeMs: entry.mtimeMs, size: 0 }
    },
  }
}

describe('MtimeWatcher (计划 v18 §5.2 步骤①, T3)', () => {
  it('ignores the first scan as baseline (established state, 变化检测误报率 < 1%)', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 1000 })
    const watcher = new MtimeWatcher(fs)
    expect(await watcher.detectWrites(['/a.md'])).toEqual([])
    // 再次扫描, mtime 未变 → 仍无变化
    expect(await watcher.detectWrites(['/a.md'])).toEqual([])
  })

  it('reports a file whose mtime advanced past the seen baseline', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 1000 })
    const watcher = new MtimeWatcher(fs)
    await watcher.detectWrites(['/a.md'])
    fs.files.set('/a.md', { mtimeMs: 1005 })
    expect(await watcher.detectWrites(['/a.md'])).toEqual(['/a.md'])
    // 消费后回到基线, 不再重复报告
    expect(await watcher.detectWrites(['/a.md'])).toEqual([])
  })

  it('reports each changed file among many, updating only the changed ones', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 1 })
    fs.files.set('/b.md', { mtimeMs: 1 })
    const watcher = new MtimeWatcher(fs)
    await watcher.detectWrites(['/a.md', '/b.md'])
    fs.files.set('/b.md', { mtimeMs: 9 })
    expect(await watcher.detectWrites(['/a.md', '/b.md'])).toEqual(['/b.md'])
  })

  it('tolerates missing files (ENOENT) and files that disappear between scans', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 1 })
    const watcher = new MtimeWatcher(fs)
    await watcher.detectWrites(['/missing.md', '/a.md'])
    fs.files.delete('/a.md')
    expect(await watcher.detectWrites(['/a.md'])).toEqual([])
  })

  it('supports explicit baseline seeding and an in-memory cache lookup', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 42 })
    const watcher = new MtimeWatcher(fs)
    watcher.markSeen('/a.md', 42)
    await watcher.detectWrites(['/a.md'])
    fs.files.set('/a.md', { mtimeMs: 43 })
    expect(await watcher.detectWrites(['/a.md'])).toEqual(['/a.md'])
    expect(watcher.seenMtime('/a.md')).toBe(43)
  })

  it('fail-open: a stat failure never throws out of detectWrites', async () => {
    const failing: WatchFs = {
      async stat() { throw new Error('EIO') },
    }
    const watcher = new MtimeWatcher(failing)
    await expect(watcher.detectWrites(['/x.md'])).resolves.toEqual([])
  })

  it('markSeen stamps a baseline after a consumed change so it is not re-reported', async () => {
    const fs = memoryFs()
    fs.files.set('/a.md', { mtimeMs: 5 })
    const watcher = new MtimeWatcher(fs)
    await watcher.detectWrites(['/a.md'])
    fs.files.set('/a.md', { mtimeMs: 7 })
    expect(await watcher.detectWrites(['/a.md'])).toEqual(['/a.md'])
    // 管线消费后主动确认新基线（与 detectWrites 内部更新等价的显式路径）
    fs.files.set('/a.md', { mtimeMs: 7 })
    watcher.markSeen('/a.md', 7)
    expect(await watcher.detectWrites(['/a.md'])).toEqual([])
  })

  it('detects a same-mtime size change (coarse-clock safety) and tracks size', async () => {
    const fs2: WatchFs = { async stat() { return { mtimeMs: 3, size: 12 } } }
    const watcher = new MtimeWatcher(fs2)
    watcher.markSeen('/a.md', 3, 10)
    expect(await watcher.detectWrites(['/a.md'])).toEqual(['/a.md'])
    expect(watcher.seenMtime('/a.md')).toBe(3)
  })

  it('reports nothing for an empty target list', async () => {
    const watcher = new MtimeWatcher(memoryFs())
    expect(await watcher.detectWrites([])).toEqual([])
  })
})

describe('scanShortTermFiles (计划 v18 §5.2 步骤① 扫描, T3/T16)', () => {
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

  it('lists the fixed targets plus scanned logs and reflections, excluding summary itself', async () => {
    const scan: ScanFs = {
      async readdir(dir) {
        if (dir === '/ws/.dsh-memory') return ['2026-08-22.md', 'conversationsummary-latest.md', 'pending-suggestions.json', 'notes.txt']
        if (dir === '/ws/.dsh-memory/reflections') return ['2026-08-22.md', 'readme.txt']
        return []
      },
    }
    const targets = await scanShortTermFiles(paths, scan)
    expect(targets).toContain('/u/.dsh/memory/MEMORY.md')
    expect(targets).toContain('/ws/.dsh-memory/2026-08-22.md')
    expect(targets).toContain('/ws/.dsh-memory/reflections/2026-08-22.md')
    // 摘要文件自身不重复出现在日志扫描中; 非 md 被过滤
    expect(targets.filter(t => t === paths.summaryFile)).toHaveLength(1)
    expect(targets.some(t => t.endsWith('notes.txt'))).toBe(false)
    expect(targets.some(t => t.endsWith('readme.txt'))).toBe(false)
  })

  it('uses the default node fs scan over a real directory (defaultScanFs)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const dir = mkdtempSync('/home/dingx/DSF-work/.temp/dshmm-watch-')
    try {
      const ws = `${dir}/.dsh-memory`
      mkdirSync(ws, { recursive: true })
      writeFileSync(`${ws}/2026-08-22.md`, 'x')
      const p = { ...paths, summaryFile: `${ws}/conversationsummary-latest.md` }
      const targets = await scanShortTermFiles(p)
      expect(targets).toContain(`${ws}/2026-08-22.md`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles a memory dir path without a slash root (defaults to dot)', async () => {
    const scan: ScanFs = { async readdir() { return ['a.md'] } }
    const p: MemoryPaths = { ...paths, summaryFile: 'latest.md' }
    const targets = await scanShortTermFiles(p, scan)
    // summaryFile 无目录 → dirOf('.') → 扫描 '.'
    expect(targets).toContain('./a.md')
  })

  it('tolerates missing .dsh-memory and reflections directories (fail-open)', async () => {
    const failing: ScanFs = {
      async readdir() { throw new Error('ENOENT') },
    }
    const targets = await scanShortTermFiles(paths, failing)
    expect(targets).toEqual([
      '/u/.dsh/memory/MEMORY.md',
      '/u/.dsh/memory/USER.md',
      '/u/.dsh/memory/CALENDAR.md',
      '/ws/.dsh-memory/conversationsummary-latest.md',
      '/ws/.dsh-memory/pending-suggestions.json',
    ])
  })
})
