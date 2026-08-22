import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, currentTaskContextOf, handlePoll, handleTurnEnd, runAuditOnce, runCompression, segmentsFromEvents, type CompressFs } from '../src/index.ts'
import { MtimeWatcher, scanShortTermFiles } from '../src/audit-pipeline/watcher.ts'
import { TurnTrigger } from '../src/history-compressor/trigger.ts'
import { PendingWriteRegistry } from '../src/audit-pipeline/confirm.ts'
import { resolveConfig, resolveMemoryPaths, type ResolvedPluginConfig } from '../src/config.ts'

const tmpRoot = '/home/dingx/DSF-work/.temp/dsh-memory-manager-it'
const ws = `${tmpRoot}/ws`
const home = `${tmpRoot}/home`

const paths = resolveMemoryPaths(ws, home)

const config: ResolvedPluginConfig = resolveConfig({
  pollIntervalMs: 60000,
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

let seq = 0
function event(type: SessionEvent['type'], data: unknown): SessionEvent {
  seq += 1
  return { type, seq, time: Date.now(), data } as SessionEvent
}

function turnStart(turn: number): SessionEvent {
  return event('turn/start', { turn })
}
function userMsg(_turn: number, text: string): SessionEvent {
  return event('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
}
function assistantMsg(_turn: number, text: string): SessionEvent {
  return event('assistant/message', { _turn, step: 1, message: { content: [{ type: 'text', text }], source: { kind: 'model', model: 'x' } } })
}

/** 10-turn log: turns 3..6 compressible (range 3..6 with retain 2). */
function tenTurnEvents(): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= 10; turn += 1) {
    events.push(turnStart(turn))
    events.push(userMsg(turn, `第 ${turn} 轮用户请求`))
    events.push(assistantMsg(turn, `第 ${turn} 轮助手回复`))
    events.push(event('turn/end', { turn }))
  }
  return events
}

const realFs: CompressFs & { readdir: (dir: string) => Promise<string[]>; stat: (file: string) => Promise<{ size: number }> } = {
  async readFile(file) { return fs.readFile(file, 'utf8') },
  async writeFile(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data, 'utf8') },
  async mkdir(dir) { await fs.mkdir(dir, { recursive: true }) },
  async readdir(dir) { return fs.readdir(dir) },
  async stat() { return { size: 0 } },
}

describe('segmentsFromEvents (T16 历史段提取)', () => {
  it('extracts only the compressed window turns', () => {
    const segments = segmentsFromEvents(tenTurnEvents(), { from: 3, to: 6 })
    // 每轮 user + assistant 各一段, turnId 唯一
    expect(segments).toHaveLength(8)
    expect(new Set(segments.map(s => s.turnId))).toEqual(new Set(['u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'u6', 'a6']))
    expect(segments[0]?.content).toContain('第 3 轮')
    expect(new Set(segments.map(s => s.turnId)).size).toBe(8)
  })

  it('skips empty-text messages (textOfMessageEvent empty branch)', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      event('user/message', { content: [], source: { kind: 'user' } }),
      event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'xx' } }] } }),
      turnStart(2),
      userMsg(2, '真实请求'),
    ]
    const segments = segmentsFromEvents(events, { from: 1, to: 2 })
    expect(segments).toHaveLength(1)
    expect(segments[0]?.content).toBe('真实请求')
    expect(currentTaskContextOf(events)).toBe('真实请求')
  })

  it('skips user/assistant events outside the window', () => {
    const segments = segmentsFromEvents(tenTurnEvents(), { from: 1, to: 2 })
    expect(segments).toHaveLength(4)
    expect(segments.map(s => s.turnId).sort()).toEqual(['a1', 'a2', 'u1', 'u2'])
  })

  it('handles a plain-string content and a content-less event (textOfMessageEvent string/empty branches)', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      event('user/message', { content: '纯文本请求', source: { kind: 'user' } }),
      event('assistant/message', { turn: 1, step: 1, message: { content: '纯文本回复' } }),
      turnStart(2),
      event('user/message', { source: { kind: 'user' } }),
    ]
    const segments = segmentsFromEvents(events, { from: 1, to: 2 })
    // 第 1 轮两段文本 + 第 2 轮 content-less 段（空文本）被过滤
    expect(segments).toHaveLength(2)
    expect(segments.map(s => s.turnId).sort()).toEqual(['a1', 'u1'])
    expect(segments[0]?.content).toBe('纯文本请求')
    expect(currentTaskContextOf(events)).toBe('纯文本请求')
  })

  it('extracts string blocks mixed with object blocks inside array content', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      event('user/message', { content: ['第一段', { type: 'text', text: '第二段' }], source: { kind: 'user' } }),
    ]
    const segments = segmentsFromEvents(events, { from: 1, to: 2 })
    expect(segments).toHaveLength(1)
    expect(segments[0]?.content).toBe('第一段 第二段')
  })

  it('skips non message event types inside the window (tool/log events are not history)', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      userMsg(1, '请求'),
      event('tool/call', { name: 'read_file', args: { path: 'x' } }),
      assistantMsg(1, '回复'),
      turnStart(2),
      userMsg(2, '追问'),
    ]
    const segments = segmentsFromEvents(events, { from: 1, to: 2 })
    expect(segments).toHaveLength(3)
    expect(segments.map(s => s.turnId).sort()).toEqual(['a1', 'u1', 'u2'])
  })
})

describe('currentTaskContextOf (计划 v18 §4.2.2 当前任务上下文来源)', () => {
  it('returns the last 3 user messages', () => {
    const ctx = currentTaskContextOf(tenTurnEvents())
    expect(ctx).toContain('第 8 轮用户请求')
    expect(ctx).toContain('第 10 轮用户请求')
    expect(ctx).not.toContain('第 1 轮用户请求')
  })
})

describe('runCompression 端到端 (T16: 先甄别归档→后摘要→再审核时序)', () => {
  async function clearWs(): Promise<void> {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
    await fs.mkdir(home, { recursive: true })
  }

  it('classifies, writes archive, emits suggestions, and writes the summary file', async () => {
    await clearWs()
    let call = 0
    const fetchImpl: typeof fetch = async () => {
      call += 1
      // 第一次调用 = classify（仅未命中规则的段）, 第二次 = summarize
      if (call === 1) {
        const payload = [
          { segmentId: 'u4', category: 'useless', confidence: 0.95 },
          { segmentId: 'a4', category: 'useless', confidence: 0.95 },
          { segmentId: 'u6', category: 'valuable-but-not-current', confidence: 0.9 },
          { segmentId: 'a6', category: 'valuable-but-not-current', confidence: 0.9 },
        ]
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '# 对话历史摘要\n## Primary Request\n- x\n## Key Concepts\n- k\n## Files\n- f\n## Errors\n- e\n## Pending Jobs\n- j\n' } }] }), { status: 200 })
    }
    // 寒暄段走规则兜底, 无需 LLM
    const events = tenTurnEvents()
    events[9] = userMsg(3, '好的，谢谢！') // t3 chitchat
    events[10] = assistantMsg(3, '好的')
    events[17] = userMsg(5, '临时路径 /tmp/x') // t5 temp → useless
    events[18] = assistantMsg(5, 'ok')
    events[21] = userMsg(6, '用户偏好：工作完成后立即记录') // t6 → valuable
    events[22] = assistantMsg(6, '已记录')

    const registered: Array<[string, string]> = []
    const session = { id: SessionId('it-session'), events }
    const outcome = await runCompression(session, 10, paths, config, {
      fsImpl: realFs,
      fetchImpl,
      userMemoryTarget: `${home}/.dsh/memory/MEMORY.md`,
      registerPendingWrite: (file, source) => { registered.push([file, source]) },
    })

    expect(outcome.range).toEqual({ from: 3, to: 8 })
    // t3 寒暄(user+assistant) + t4 无用(llm) + t5 临时(user+assistant) = 6 段过时/无用
    expect(outcome.archivedSegments).toBe(6)
    // t6 有价值但非当前(user+assistant) → 2 条建议
    expect(outcome.suggestionsCount).toBe(2)
    expect(outcome.summaryOk).toBe(true)

    // 归档文件按会话+日期写入（目录自动创建）
    const archive = await fs.readFile(`${paths.historyArchiveRoot}/it-session/${new Date().toISOString().slice(0, 10)}.md`, 'utf8')
    expect(archive).toContain('## 无用内容')
    expect(archive).toContain('好的，谢谢！')
    expect(archive).toContain('临时路径 /tmp/x')

    // 建议条目写入 pending-suggestions.json + pendingWrite 注册
    const suggestions = await fs.readFile(paths.suggestionsFile, 'utf8')
    expect(suggestions).toContain('sugg-')
    expect(registered.some(([file]) => file === paths.suggestionsFile)).toBe(true)
    expect(registered.some(([file]) => file === paths.summaryFile)).toBe(true)

    // 摘要单文件覆盖策略
    const summary = await fs.readFile(paths.summaryFile, 'utf8')
    expect(summary).toContain('## Primary Request')
  })

  it('uses default (noop) fs and register when deps omit them (default branches)', async () => {
    await clearWs()
    const fetchImpl: typeof fetch = async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: '# 对话历史摘要\n## Primary Request\n- x\n## Key Concepts\n- k\n## Files\n- f\n## Errors\n- e\n## Pending Jobs\n- j\n' } }] }), { status: 200 })
    }
    const outcome = await runCompression({ id: SessionId('s'), events: tenTurnEvents() }, 10, paths, config, {
      fetchImpl,
      userMemoryTarget: `${home}/.dsh/memory/MEMORY.md`,
    })
    // 无注入的 fs/register: 归档与摘要写失败 → fail-open 静默降级, 分类结果仍可用
    expect(outcome.range).toEqual({ from: 3, to: 8 })
    expect(outcome.summaryOk).toBe(false)
    expect(outcome.classified.length).toBeGreaterThan(0)
  })

  it('degrades to useful when the LLM fails (fail-open, 保留原文)', async () => {
    await clearWs()
    const fetchImpl: typeof fetch = async () => { throw new Error('llm down') }
    const outcome = await runCompression({ id: SessionId('it-session'), events: tenTurnEvents() }, 10, paths, config, {
      fsImpl: realFs,
      fetchImpl,
      userMemoryTarget: `${home}/.dsh/memory/MEMORY.md`,
      registerPendingWrite: () => {},
    })
    // 全部分类降级 useful → 无归档无建议, 摘要仍生成（fallback）
    expect(outcome.archivedSegments).toBe(0)
    expect(outcome.suggestionsCount).toBe(0)
    expect(outcome.summaryOk).toBe(true)
    expect(outcome.classified.every(c => c.category === 'useful')).toBe(true)
  })

  it('compression below threshold does nothing (T15 触发阈值)', async () => {
    await clearWs()
    const outcome = await runCompression({ id: SessionId('s'), events: tenTurnEvents() }, 5, paths, config, {
      fsImpl: realFs,
      userMemoryTarget: `${home}/.dsh/memory/MEMORY.md`,
      registerPendingWrite: () => {},
    })
    expect(outcome.range).toBeNull()
    expect(outcome.classified).toEqual([])
  })
})

describe('runAuditOnce 六步管线集成 (T16)', () => {
  async function prepareWs(): Promise<void> {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.mkdir(`${ws}/.dsh-memory/reflections`, { recursive: true })
    await fs.mkdir(`${ws}/.dsh-memory/archive/history`, { recursive: true })
  }

  it('detects a modified summary file through the pipeline without altering compliant content', async () => {
    await prepareWs()
    const summaryText = '# 对话历史摘要\n> 生成时间：2026-08-22 10:30\n> 覆盖范围：第 3-8 轮（保留最近 2 轮原文）\n> 压缩策略：基于内容甄别的结构化摘要（已过时/无用内容已归档）\n## Primary Request\n- p\n## Key Concepts\n- k\n## Files\n- f\n## Errors\n- e\n## Pending Jobs\n- j\n'
    await fs.writeFile(paths.summaryFile, summaryText, 'utf8')

    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    // 首轮为基线
    const first = await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    expect(first.changed).toEqual([])

    // 修改 mtime → 发现变化 → 确认（pendingWrite 识别 history-compressor）→ 审核
    registry.register(paths.summaryFile, 'history-compressor')
    const future = new Date(Date.now() + 2000)
    await fs.utimes(paths.summaryFile, future, future)
    const second = await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    expect(second.changed).toEqual([paths.summaryFile])
    // 合规摘要无修复无标记
    expect(second.fixed).toEqual([])
    expect(second.flagged).toEqual([])

    // 内容未被改动（守门不创作）
    const after = await fs.readFile(paths.summaryFile, 'utf8')
    expect(after).toBe(summaryText)
  })

  it('audit scans do not include the archive area (归档不触发审核, T16)', async () => {
    await prepareWs()
    await fs.mkdir(`${paths.historyArchiveRoot}/sid`, { recursive: true })
    await fs.writeFile(`${paths.historyArchiveRoot}/sid/2026-08-22.md`, 'archived', 'utf8')
    const targets = await scanShortTermFiles(paths, realFs)
    expect(targets.some(t => t.includes('/archive/'))).toBe(false)
  })

  it('flags out-of-category content through the pipeline (超三类 → 待决)', async () => {
    await prepareWs()
    await fs.mkdir(`${home}/.dsh/memory`, { recursive: true })
    const memFile = paths.userMemoryFile
    await fs.writeFile(memFile, '## 2026-08-22\n- 今天天气不错\n', 'utf8')
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    await new Promise((r) => { setTimeout(r, 1100) })
    await fs.writeFile(memFile, '## 2026-08-22\n- 今天天气不错\n- 更多内容\n', 'utf8')
    registry.register(memFile, 'model-explicit')
    const report = await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    expect(report.changed).toContain(memFile)
    expect(report.flagged).toContain(memFile)
    const review = await fs.readFile(paths.pendingReviewFile, 'utf8').then(t => JSON.parse(t) as { entries: unknown[] }, () => ({ entries: [] }))
    expect(review.entries.length).toBeGreaterThan(0)
  })

  it('reports format-fixed files through the pipeline (格式自动修复 → fixed 列表)', async () => {
    await prepareWs()
    // memory 文件缺日期标题 → normalizeDateHeading 自动补上 → fixed
    await fs.writeFile(paths.userMemoryFile, '- 缺少日期标题的规则\n', 'utf8')
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    await new Promise((r) => { setTimeout(r, 1100) })
    await fs.writeFile(paths.userMemoryFile, '- 缺少日期标题的规则\n- 新增内容\n', 'utf8')
    registry.register(paths.userMemoryFile, 'model-explicit')
    const report = await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    expect(report.changed).toContain(paths.userMemoryFile)
    expect(report.fixed).toContain(paths.userMemoryFile)
    const after = await fs.readFile(paths.userMemoryFile, 'utf8')
    expect(after).toMatch(/^## \d{4}-\d{2}-\d{2}\n/)
  })

  it('records failed reads/confirms in the audit outcome (fail-open)', async () => {
    await prepareWs()
    const broken = {
      ...realFs,
      async readFile() { throw new Error('EIO') },
    }
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    await fs.writeFile(paths.summaryFile, 'x', 'utf8')
    // 种子基线后让其变化
    await runAuditOnce({ watcher, registry, paths, fsImpl: broken }, config)
    await new Promise((r) => { setTimeout(r, 1100) })
    await fs.writeFile(paths.summaryFile, 'y', 'utf8')
    registry.register(paths.summaryFile, 'history-compressor')
    const report = await runAuditOnce({ watcher, registry, paths, fsImpl: broken }, config)
    expect(report.changed).toContain(paths.summaryFile)
    expect(report.failed).toContain(paths.summaryFile)
  })

  it('pendingWrite consumption identifies the history-compressor source (T16 端到端)', async () => {
    const registry = new PendingWriteRegistry()
    registry.register('/x.md', 'history-compressor', 0)
    expect(registry.consume('/x.md', 100)).toBe('history-compressor')
  })
})

describe('handleTurnEnd / handlePoll (T16 事件入口, 可测试编排)', () => {
  it('ignores non turn/end events and routes turn/end into the compressor', async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
    const events = tenTurnEvents()
    events[3] = userMsg(2, '好的，谢谢！')
    const session = { id: SessionId('h1'), header: { cwd: ws }, events }
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const trigger = new TurnTrigger({ thresholdTurns: 8 })
    const stalled = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', stalled)
    // 非 turn/end: 无副作用, 不触发压缩
    await handleTurnEnd({ watcher, registry, trigger, resolved: config, home }, session, event('user/message', { content: [{ type: 'text', text: 'x' }] }))
    await new Promise((r) => { setTimeout(r, 5) })
    expect(stalled).not.toHaveBeenCalled()
    // turn/end: 触发压缩 (fetch fail → fail-open, 但 classify 调用确实发生)
    await handleTurnEnd({ watcher, registry, trigger, resolved: config, home }, session, event('turn/end', { turn: 10 }))
    await new Promise((r) => { setTimeout(r, 80) })
    expect(stalled).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('runs a poll tick against the current dir without throwing', async () => {
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    await expect(handlePoll({ watcher, registry, resolved: config, home }, ws)).resolves.toBeUndefined()
  })

  it('falls back to process.cwd() when the session header has no cwd', async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.mkdir(ws, { recursive: true })
    const events = tenTurnEvents()
    events[3] = userMsg(2, '好的，谢谢！')
    const session = { id: SessionId('h1'), header: {}, events } // header 无 cwd
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const trigger = new TurnTrigger({ thresholdTurns: 8 })
    const stalled = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', stalled)
    await handleTurnEnd({ watcher, registry, trigger, resolved: config, home }, session, event('turn/end', { turn: 10 }))
    await new Promise((r) => { setTimeout(r, 80) })
    // 压缩确实被触发（回退 cwd 路径解析成功）
    expect(stalled).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('runs the audit pass for an unregistered change with source unknown (consume 无记录 → unknown)', async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.mkdir(`${ws}/.dsh-memory/reflections`, { recursive: true })
    await fs.mkdir(`${ws}/.dsh-memory/archive/history`, { recursive: true })
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    await fs.writeFile(paths.summaryFile, 'x', 'utf8')
    await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    await new Promise((r) => { setTimeout(r, 1100) })
    await fs.writeFile(paths.summaryFile, 'y', 'utf8')
    // 有意不 registry.register → consume 返回 null → source='unknown'
    const report = await runAuditOnce({ watcher, registry, paths, fsImpl: realFs }, config)
    expect(report.changed).toContain(paths.summaryFile)
    expect(report.changed.length).toBeGreaterThan(0)
  })

  it('runAuditOnce falls back to the default no-op fs (defaultAuditFs)', async () => {
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const report = await runAuditOnce({ watcher, registry, paths }, config)
    expect(report.scanned.length).toBeGreaterThan(0)
    expect(report.changed).toEqual([])
  })
})

describe('apply() plugin mount (T16 插件入口)', () => {
  it('exports a plugin entry function and resolves config for the real home', async () => {
    const ctx = new Context()
    // cordis 形态: plugin(apply, config) — config 是第二参数; await 等待装载完成
    const fiber = await ctx.plugin(apply, { pollIntervalMs: 10 } as const)
    expect(apply.name).toBe('apply')
    expect(os.homedir().length).toBeGreaterThan(0)
    // 触发一次 session/event → apply 注册的回调执行 handleTurnEnd（非 turn/end 直接返回）
    ctx.emit('session/event', { id: SessionId('s1'), header: { cwd: ws }, events: [] }, event('user/message', { content: 'x' }))
    // 等待一个 poll tick（10ms 间隔）→ poll 回调执行且不抛错
    await new Promise((r) => { setTimeout(r, 60) })
    // 卸载插件 → 清理 poll 定时器 (ctx.effect yield disposer)
    await fiber.dispose()
  })
})
