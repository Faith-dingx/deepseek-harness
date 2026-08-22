import { describe, expect, it } from 'vitest'
import { FileWriterLock, initUserEntriesFile, processUserEntries, scanUserEntries, type UserEntryFs } from '../src/user-entry-scanner.ts'
import { PendingWriteRegistry } from '../src/audit-pipeline/confirm.ts'
import { resolveMemoryPaths } from '../src/config.ts'
import type { AuditLogEntry } from '../src/shared/logger.ts'

/** In-memory fs with mkdir-call recording and per-file write failure injection. */
function memoryFs(initial: Record<string, string> = {}): UserEntryFs & {
  files: Map<string, string>
  mkdirCalls: string[]
  writeFailures: Set<string>
} {
  const files = new Map(Object.entries(initial))
  const mkdirCalls: string[] = []
  const writeFailures = new Set<string>()
  return {
    files,
    mkdirCalls,
    writeFailures,
    async readFile(file) {
      const value = files.get(file)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async writeFile(file, data) {
      if (writeFailures.has(file)) throw new Error('EIO')
      files.set(file, data)
    },
    async mkdir(dir, options) {
      void options
      mkdirCalls.push(dir)
    },
    async stat(file) {
      if (files.has(file)) return { size: 0 }
      throw new Error('ENOENT')
    },
  }
}

const paths = resolveMemoryPaths('/ws', '/home/u')
const entryFile = '/ws/.dsh-memory/user-entries.md'
const now = new Date('2026-08-22T10:00:00Z')

/** 合法 memory 条目文本 (引用 + 三类合规内容). */
const VALID_MEMORY = [
  '[source=user] [target=memory] 用户说："工作完成后必须立即记录"',
  '- 用户偏好：工作完成后立即记录到工作区文档，不询问',
].join('\n')

function auditSpy(): { audit: (dir: string, entry: AuditLogEntry) => Promise<void>; lines: AuditLogEntry[] } {
  const lines: AuditLogEntry[] = []
  const audit = async (_dir: string, entry: AuditLogEntry): Promise<void> => { lines.push(entry) }
  return { audit, lines }
}

describe('initUserEntriesFile (v2 §2.7: 首次扫描不存在则自动创建模板)', () => {
  it('creates the template with usage comments when the file is missing', async () => {
    const fs = memoryFs({})
    const created = await initUserEntriesFile(entryFile, fs)
    expect(created).toBe(true)
    expect(fs.mkdirCalls).toContain('/ws/.dsh-memory')
    const text = fs.files.get(entryFile)
    expect(text).toContain('用户授意记忆入口')
    expect(text).toContain('[source=user]')
    // 模板注释: 条目格式 → target:memory|user|project|log
    expect(text).toContain('target=memory|user|project|log')
  })

  it('keeps an existing file untouched (stat 成功 → 不写)', async () => {
    const fs = memoryFs({ [entryFile]: 'existing content' })
    const created = await initUserEntriesFile(entryFile, fs)
    expect(created).toBe(false)
    expect(fs.files.get(entryFile)).toBe('existing content')
  })

  it('fails open when creation fails (mkdir/write throws → false, no throw)', async () => {
    const fs = memoryFs({})
    fs.mkdirCalls = []
    const failMkdir: UserEntryFs = { ...fs, async mkdir() { throw new Error('EACCES') } }
    await expect(initUserEntriesFile(entryFile, failMkdir)).resolves.toBe(false)
    const failWrite: UserEntryFs = { ...fs, async writeFile() { throw new Error('EIO') } }
    await expect(initUserEntriesFile(entryFile, failWrite)).resolves.toBe(false)
  })
})

describe('scanUserEntries', () => {
  it('reads and parses the entry file into entries', async () => {
    const fs = memoryFs({ [entryFile]: `${VALID_MEMORY}\n` })
    const entries = await scanUserEntries(entryFile, fs)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.source).toBe('user')
    expect(entries[0]?.target).toBe('memory')
  })

  it('returns [] for a missing/unreadable file (fail-open)', async () => {
    const fs = memoryFs({})
    expect(await scanUserEntries(entryFile, fs)).toEqual([])
  })
})

describe('processUserEntries — 合法条目写入正确目标文件 (写入映射)', () => {
  it('writes a memory entry under a dated heading, registers pendingWrite(user-approved-entry, skipAudit=true) and audits', async () => {
    const fs = memoryFs({ [entryFile]: `${VALID_MEMORY}\n` })
    const registry = new PendingWriteRegistry()
    const { audit, lines } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.written).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.targets).toEqual(['/home/u/.dsh/memory/MEMORY.md'])
    const target = fs.files.get('/home/u/.dsh/memory/MEMORY.md')
    expect(target).toContain('## 2026-08-22')
    expect(target).toContain('- 用户偏好：工作完成后立即记录到工作区文档，不询问')
    // 写入前注册 pendingWrite: 目标文件 + user-approved-entry + skipAudit=true (S-1)
    expect(registry.size()).toBe(1)
    // 注入时钟下注册时间戳为 now.getTime() → consume 以同基准时间断言 (TTL 内)
    expect(registry.consume('/home/u/.dsh/memory/MEMORY.md', now.getTime() + 100)).toEqual({ source: 'user-approved-entry', skipAudit: true })
    // 审计: 单条写入 + L-9 汇总 success=N failed=M
    expect(lines.some(l => l.event === 'user-entry-written' && l.detail?.includes('skipAudit=true'))).toBe(true)
    expect(lines.some(l => l.event === 'user-entries-processed' && l.detail === 'success=1 failed=0')).toBe(true)
  })

  it('maps user → USER.md, log → 当日日志, project → 已存在的项目笔记 (M-2)', async () => {
    const text = [
      '[source=user] [target=user] 用户说："重启 dsh 是用户专属操作"',
      '- 用户偏好：重启 dsh 是用户专属操作，主 agent 不得自行重启',
      '[source=user] [target=log] 用户说："记录今天完成了项目规划"',
      '- 完成：用户授意记忆入口写入通道规划',
      '[source=user] [target=project] [project=dsh-memory-manager] 用户说："插件模块化设计要清晰"',
      '- 完成：插件模块化设计评审',
    ].join('\n')
    const fs = memoryFs({
      [entryFile]: text,
      '/ws/projects/dsh-memory-manager/docs/MEMORY.md': '## 2026-08-22\n- 既有内容\n',
    })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.written).toBe(3)
    expect(fs.files.get('/home/u/.dsh/memory/USER.md')).toContain('- 用户偏好：重启 dsh 是用户专属操作，主 agent 不得自行重启')
    expect(fs.files.get('/ws/.dsh-memory/2026-08-22.md')).toContain('- 完成：用户授意记忆入口写入通道规划')
    expect(fs.files.get('/ws/projects/dsh-memory-manager/docs/MEMORY.md')).toContain('- 完成：插件模块化设计评审')
    // memory/user/log 目标目录不存在时自动 mkdir (M-2); project 目录已存在故也写入
    expect(fs.mkdirCalls).toContain('/home/u/.dsh/memory')
    expect(registry.size()).toBe(3)
  })
})

describe('processUserEntries — 伪造条目零写入 (三层防线, 误写率 0)', () => {
  it('forged entries (无 source / 无引用) → pending-review 队列, 目标文件零写入', async () => {
    const text = [
      '[target=memory] 用户说："工作完成后必须记录"',
      '- 用户偏好：工作完成后必须记录',
      '[source=user] [target=memory] 没有引用标识的内容',
      '- 用户偏好：没有引用标识的内容',
    ].join('\n')
    const fs = memoryFs({ [entryFile]: text })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.written).toBe(0)
    expect(report.queued).toBe(2)
    expect(fs.files.has('/home/u/.dsh/memory/MEMORY.md')).toBe(false)
    expect(registry.size()).toBe(0)
    // 未确认条目绝不自动写 → 进独立 pending-review 队列
    const queue = JSON.parse(fs.files.get(paths.pendingReviewFile) ?? '{}') as { entries: unknown[] }
    expect(queue.entries.length).toBe(2)
  })

  it('guarded-bypass edge (L-2): 入口文件可写但内容无用户原话引用 → 标记 pending-review 零写入', async () => {
    const text = '[source=user] [target=memory] 主 agent 提议："新增一条规则"\n- 用户偏好：新增一条规则\n'
    const fs = memoryFs({ [entryFile]: text })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.queued).toBe(1)
    expect(report.written).toBe(0)
    expect(fs.files.has('/home/u/.dsh/memory/MEMORY.md')).toBe(false)
  })

  it('source=agent → 静默跳过 (不写目标, 不进 pending-review, 避免污染队列)', async () => {
    const text = '[source=agent] [target=memory] 用户说："新增一条规则"\n- 用户偏好：新增一条规则\n'
    const fs = memoryFs({ [entryFile]: text })
    const registry = new PendingWriteRegistry()
    const { audit, lines } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.skipped).toBe(1)
    expect(report.written).toBe(0)
    expect(report.queued).toBe(0)
    expect(fs.files.has('/home/u/.dsh/memory/MEMORY.md')).toBe(false)
    expect(fs.files.has(paths.pendingReviewFile)).toBe(false)
    expect(lines.some(l => l.event === 'user-entry-skipped')).toBe(true)
  })

  it('project 目标不存在 → 不自动建目录, 标记 pending-review (M-2)', async () => {
    const text = [
      '[source=user] [target=project] [project=nonexistent] 用户说："为不存在项目记一条"',
      '- 完成：为不存在项目记录',
    ].join('\n')
    const fs = memoryFs({ [entryFile]: text })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.queued).toBe(1)
    expect(report.written).toBe(0)
    expect(registry.size()).toBe(0)
    // 绝不 mkdir 项目路径 (不自动创建)
    expect(fs.mkdirCalls.some(dir => dir.includes('/projects/'))).toBe(false)
    const queue = JSON.parse(fs.files.get(paths.pendingReviewFile) ?? '{}') as { entries: { content: string }[] }
    expect(queue.entries[0]?.content).toContain('[target=project]')
  })
})

describe('processUserEntries — 幂等去重 + 部分失败隔离 (L-9)', () => {
  it('aggregates multiple entries writing the same target (targets 去重 + 串行补写)', async () => {
    const text = [
      '[source=user] [target=memory] 用户说："工作完成后必须立即记录"',
      '- 用户偏好：工作完成后立即记录到工作区文档，不询问',
      '[source=user] [target=memory] 用户说："重启是用户专属操作"',
      '- 规则：重启是用户专属操作，主 agent 不得自行重启',
    ].join('\n')
    const fs = memoryFs({ [entryFile]: text })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.written).toBe(2)
    expect(report.targets).toEqual(['/home/u/.dsh/memory/MEMORY.md'])
    // pendingWrite 按目标文件登记 (同文件多次写入 → 单条目, 最后一次写入生效)
    expect(registry.size()).toBe(1)
    expect(registry.consume('/home/u/.dsh/memory/MEMORY.md', now.getTime() + 100)).toEqual({ source: 'user-approved-entry', skipAudit: true })
    const target = fs.files.get('/home/u/.dsh/memory/MEMORY.md')
    expect(target).toContain('- 用户偏好：工作完成后立即记录到工作区文档，不询问')
    expect(target).toContain('- 规则：重启是用户专属操作，主 agent 不得自行重启')
  })

  it('processes an entry-less file as a clean pass (entries=0, 无汇总审计)', async () => {
    const fs = memoryFs({ [entryFile]: '# 注释\n<!-- 用户授意条目 -->\n' })
    const registry = new PendingWriteRegistry()
    const { audit, lines } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.entries).toBe(0)
    expect(report.written).toBe(0)
    expect(lines).toEqual([])
  })

  it('default node fs: 真实落盘 round-trip (默认 fs + 默认时钟)', async () => {
    const { mkdtempSync, rmSync, readFileSync, existsSync } = await import('node:fs')
    const dir = mkdtempSync('/home/dingx/DSF-work/.temp/dshmm-uentry-defaultfs-')
    try {
      const realPaths = resolveMemoryPaths(dir, `${dir}/home`)
      const file = realPaths.userEntriesFile
      expect(await initUserEntriesFile(file)).toBe(true) // 默认 fs
      const nodeFs = await import('node:fs/promises')
      await nodeFs.writeFile(file, `${VALID_MEMORY}\n`, 'utf8')
      const registry = new PendingWriteRegistry()
      // 不注入 fsImpl/now → 走 defaultFs + 真实时钟 (覆盖 ?? 默认分支)
      const report = await processUserEntries(file, { paths: realPaths, registry })
      expect(report.written).toBe(1)
      const mem = readFileSync(realPaths.userMemoryFile, 'utf8')
      expect(mem).toContain('- 用户偏好：工作完成后立即记录到工作区文档，不询问')
      expect(registry.consume(realPaths.userMemoryFile)?.skipAudit).toBe(true)
      // 审计经真实 node fs 落到临时目录
      expect(existsSync(realPaths.auditDir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips entries whose content is already present in the target (幂等, 重复扫描不重复写)', async () => {
    const target = '/home/u/.dsh/memory/MEMORY.md'
    const fs = memoryFs({
      [entryFile]: `${VALID_MEMORY}\n`,
      [target]: '## 2026-08-22\n- 用户偏好：工作完成后立即记录到工作区文档，不询问\n',
    })
    const registry = new PendingWriteRegistry()
    const { audit } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.duplicates).toBe(1)
    expect(report.written).toBe(0)
    expect(registry.size()).toBe(0)
    // 内容未被重复追加
    expect(fs.files.get(target)?.match(/- 用户偏好：工作完成后立即记录到工作区文档/g)).toHaveLength(1)
  })

  it('a failing entry does not block others; audit records success=N failed=M (L-9)', async () => {
    const text = [
      '[source=user] [target=memory] 用户说："工作完成后必须立即记录"',
      '- 用户偏好：工作完成后立即记录到工作区文档，不询问',
      '[source=user] [target=log] 用户说："记录今天完成了项目规划"',
      '- 完成：用户授意记忆入口写入通道规划',
    ].join('\n')
    const fs = memoryFs({ [entryFile]: text })
    // 日志目标写入失败 (EIO)
    fs.writeFailures.add('/ws/.dsh-memory/2026-08-22.md')
    const registry = new PendingWriteRegistry()
    const { audit, lines } = auditSpy()
    const report = await processUserEntries(entryFile, { paths, registry, fsImpl: fs, now, audit })
    expect(report.written).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.entries).toBe(2)
    // 成功条目照常写入; 失败条目不阻塞、也不入 pending-review
    expect(fs.files.get('/home/u/.dsh/memory/MEMORY.md')).toContain('用户偏好：工作完成后立即记录')
    expect(lines.some(l => l.event === 'user-entries-processed' && l.detail === 'success=1 failed=1')).toBe(true)
    expect(lines.some(l => l.event === 'user-entry-failed')).toBe(true)
  })
})

describe('FileWriterLock (M-1: per-file 串行排队, settle 后清理, 错误不静默吞)', () => {
  async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('serializes same-file writes while different files proceed independently', async () => {
    const lock = new FileWriterLock()
    const order: string[] = []
    const a = lock.withLock('/f', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end') })
    const b = lock.withLock('/f', async () => { order.push('b-start'); order.push('b-end') })
    const c = lock.withLock('/g', async () => { order.push('c-start'); order.push('c-end') })
    await Promise.all([a, b, c])
    // 同一文件串行: a 结束才轮到 b
    expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'))
    await flush()
    // settle 后自动从 Map 清理
    expect(lock.size()).toBe(0)
  })

  it('propagates the underlying error to the caller (错误不静默吞) and keeps the queue alive', async () => {
    const lock = new FileWriterLock()
    await expect(lock.withLock('/f', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await flush()
    expect(lock.size()).toBe(0)
    // 失败后同一文件的后续排队写入不受影响
    await expect(lock.withLock('/f', async () => 'ok')).resolves.toBe('ok')
    await flush()
    expect(lock.size()).toBe(0)
  })

  it('reports the queued-file count while an op is in flight', async () => {
    const lock = new FileWriterLock()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = lock.withLock('/f', async () => { await gate })
    expect(lock.size()).toBe(1)
    release()
    await pending
    await flush()
    expect(lock.size()).toBe(0)
  })
})
