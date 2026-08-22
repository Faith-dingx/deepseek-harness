/**
 * dsh-memory-manager: 记忆与上下文管理器 (计划 v18, T1-T16).
 *
 * Plugin entry + orchestration. Two event surfaces, one pipeline:
 *
 * - `session/event` `turn/end`: per-turn history triage → archive →
 *   summarize → audit (先压缩后审核, 计划 v18 §4.2.1). Auto-memory already
 *   wrote its logs at turn-stopping, so the compressor runs on a settled
 *   turn and the audit pass follows.
 * - mtime poll (watcher): the six-step audit pipeline over the short-term
 *   memory files (步骤①发现 → ②确认 → ③对比 → ④校验规范化 → ⑤归档 → ⑥审计).
 *
 * Every node is fail-open: any exception degrades to the safe default (keep
 * raw history, keep the original memory file, keep system prompt intact) and
 * compaction-basic remains untouched as the pressure backstop (計劃 v18
 * §4.2.7 fail-open chain).
 *
 * @module @deepseek-ai/dsh-memory-manager
 */

import os from 'node:os'
import path from 'node:path'
import { promises as nodeFs } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  kindOfFile,
  resolveConfig,
  resolveMemoryPaths,
  type MemoryPaths,
  type PluginConfig,
  type ResolvedPluginConfig,
  type WriteSource,
} from './config.ts'
import { MtimeWatcher, scanShortTermFiles } from './audit-pipeline/watcher.ts'
import { PendingWriteRegistry, confirmWriteComplete, type ConfirmFs } from './audit-pipeline/confirm.ts'
import type { ScanFs } from './audit-pipeline/watcher.ts'
import { applyNormalization } from './audit-pipeline/archive.ts'
import { resolveWriteWaitMs } from './config.ts'
import { TurnTrigger, turnCompressionRange, type CompressionRange } from './history-compressor/trigger.ts'
import { classifySegments, type ClassifiedResult, type HistoryCategory, type HistorySegment } from './history-compressor/classify.ts'
import { generateSummary } from './history-compressor/summarize.ts'
import { writeHistoryArchive, type ArchiveWriteFs, type ArchivedSegment } from './history-compressor/write-archive.ts'
import { writeSummaryFile, type SummaryWriteFs } from './history-compressor/write-summary.ts'

export const name = 'dsh-memory-manager'

/** Plugin configuration (plan defaults, per-instance overrides). */
export { Config } from './config.ts'

/** Text of a user/assistant message event (content-block aware). */
function textOfMessageEvent(data: unknown): string {
  const content: unknown = (data as { content?: unknown }).content ?? (data as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => typeof block === 'string' ? block : (block as { text?: unknown }).text)
      .filter((text): text is string => typeof text === 'string')
      .join(' ')
      .trim()
  }
  return ''
}

/**
 * Extract the history segments of turns `range.from`..`range.to` from a
 * session's event log (user + assistant messages only).
 */
export function segmentsFromEvents(events: readonly SessionEvent[], range: CompressionRange): HistorySegment[] {
  const segments: HistorySegment[] = []
  let currentTurn = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      currentTurn = event.data.turn
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (currentTurn < range.from || currentTurn > range.to) continue
    const text = textOfMessageEvent(event.data)
    if (text.length === 0) continue
    segments.push({
      // 每轮 user/assistant 各一段, turnId 唯一（u3=用户段, a3=助手段）
      turnId: `${event.type === 'user/message' ? 'u' : 'a'}${currentTurn}`,
      content: text.slice(0, 500),
      timestamp: new Date(event.time),
      isUser: event.type === 'user/message',
    })
  }
  return segments
}

/** The current-task context: the last 3 user messages (计划 v18 §4.2.2). */
export function currentTaskContextOf(events: readonly SessionEvent[]): string {
  const users: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = textOfMessageEvent(event.data)
      if (text.length > 0) users.push(text)
    }
  }
  return users.slice(-3).join('\n')
}

/** File-system surface the compression pass needs. */
export interface CompressFs extends ArchiveWriteFs, SummaryWriteFs {
  readFile(file: string): Promise<string>
}

/** Everything the compression pass depends on (injectable for tests). */
export interface CompressionDeps {
  readonly fetchImpl?: typeof fetch
  readonly fsImpl?: CompressFs
  readonly registerPendingWrite: (file: string, source: WriteSource) => void
  readonly now?: () => Date
  readonly userMemoryTarget: string
}

/** Outcome of one turn compression, for observability. */
export interface CompressionOutcome {
  readonly range: CompressionRange | null
  readonly classified: readonly ClassifiedResult[]
  readonly archivedSegments: number
  readonly suggestionsCount: number
  readonly summaryOk: boolean
}

/* oxlint-disable typescript/require-await -- Interface-shaped fail-open
 * stubs: every method intentionally has no await because the real surface is
 * injected by tests; these defaults only exist so a missing injection cannot
 * crash the pipeline. */
const defaultCompressFs: CompressFs = {
  async readFile() { throw new Error('not-implemented') },
  async writeFile() { throw new Error('not-implemented') },
  async mkdir() { },
}
/* oxlint-enable typescript/require-await */

/**
 * 时序: 先甄别归档 → 后摘要（计划 v18 T16). Runs the four-category triage on
 * the compressed window, archives stale/useless, emits suggestion entries for
 * valuable-but-not-current, and writes the still-useful summary into
 * conversationsummary-latest.md with pendingWrite registration. Fail-open at
 * every step: any failure keeps the raw history usable.
 */
export async function runCompression(
  session: Pick<Session, 'id' | 'events'>,
  turn: number,
  paths: MemoryPaths,
  config: ResolvedPluginConfig,
  deps: CompressionDeps,
): Promise<CompressionOutcome> {
  const range = turnCompressionRange(turn, config.retainRecentTurns)
  if (range === null) {
    return { range: null, classified: [], archivedSegments: 0, suggestionsCount: 0, summaryOk: false }
  }
  const fsImpl = deps.fsImpl ?? defaultCompressFs
  // registerPendingWrite is a required field of CompressionDeps; keep the
  // direct reference (no fallback needed, oxlint no-unnecessary-condition).
  const register = deps.registerPendingWrite
  const now = (deps.now ?? (() => new Date()))()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  const segments = segmentsFromEvents(session.events, range)
  const classified = await classifySegments(segments, currentTaskContextOf(session.events), {
    endpoint: config.summaryEndpoint,
    model: config.classifyModel,
    confidenceThreshold: config.classifyConfidenceThreshold,
    // 实测根因修复: 不再硬编码 10s — 9888 网关 100KB+ payload 延迟 10.7s
    timeoutMs: config.classifyTimeoutMs,
    classifyMaxBatch: config.classifyMaxBatch,
    llmSegmentChars: config.llmSegmentChars,
  }, fetchImpl)

  const byId = new Map(segments.map(s => [s.turnId, s]))
  const pick = (category: HistoryCategory): ArchivedSegment[] => classified
    .filter(c => c.category === category)
    /* v8 ignore start -- byId is total over classified (same input segments);
     * `?? ''` guards a defensive fallback only. */
    .map(c => ({ turnId: c.segmentId, content: byId.get(c.segmentId)?.content ?? '' }))
    .filter(s => s.content.length > 0)
    /* v8 ignore stop */

  const stale = pick('stale')
  const useless = pick('useless')
  const valuable = pick('valuable-but-not-current')

  const archived = await writeHistoryArchive({
    sessionId: session.id,
    date: now,
    staleSegments: stale,
    uselessSegments: useless,
    valuableSegments: valuable,
    archiveRoot: config.historyArchiveRoot ?? paths.historyArchiveRoot,
    suggestionsPath: paths.suggestionsFile,
    userMemoryTarget: deps.userMemoryTarget,
    registerPendingWrite: register,
  }, fsImpl)

  const usefulSegments = classified
    .filter(c => c.category === 'useful')
    /* v8 ignore start -- byId is total over classified (same input segments). */
    .map(c => ({ turnId: c.segmentId, content: byId.get(c.segmentId)?.content ?? '', isUser: true }))
    .filter(s => s.content.length > 0)
    /* v8 ignore stop */

  const coverage = `第 ${range.from}-${range.to} 轮（保留最近 ${config.retainRecentTurns} 轮原文）`
  const summary = await generateSummary(usefulSegments, currentTaskContextOf(session.events), {
    endpoint: config.summaryEndpoint,
    model: config.summaryModel,
    // 实测根因修复: 不再硬编码 10s (同上, 摘要 payload 同样 100KB+)
    timeoutMs: config.summaryTimeoutMs,
    maxSummaryLines: config.maxSummaryLines,
    summarizeMaxSegments: config.summarizeMaxSegments,
    llmSegmentChars: config.llmSegmentChars,
  }, coverage, now.toISOString(), fetchImpl)
  const summaryWrite = await writeSummaryFile(paths.summaryFile, summary, register, fsImpl)

  return {
    range,
    classified,
    archivedSegments: stale.length + useless.length,
    suggestionsCount: archived.suggestionsCount,
    summaryOk: summaryWrite.ok,
  }
}

/** Everything the audit pass depends on (injectable for tests). */
export interface AuditDeps {
  readonly watcher: MtimeWatcher
  readonly registry: PendingWriteRegistry
  readonly fsImpl?: AuditFs
  readonly now?: () => Date
  readonly paths: MemoryPaths
}

/** The unified file surface of one audit pass (scan + confirm + archive). */
export type AuditFs = ScanFs & ConfirmFs & ArchiveWriteFs & {
  readFile(file: string): Promise<string>
}

/** Outcome of one audit pass, for observability. */
export interface AuditOutcome {
  readonly scanned: readonly string[]
  readonly changed: readonly string[]
  readonly fixed: readonly string[]
  readonly flagged: readonly string[]
  readonly failed: readonly string[]
}

/** Default audit fs: no-op readdir may still resolve fixed targets only. */
/* v8 ignore start -- in-memory fallback surface: every method is a stub that
   only runs when no real fs is injected; the pipeline defaults are exercised
   through unit tests with injected fakes instead. */
function defaultAuditFs(): AuditFs {
  /* oxlint-disable typescript/require-await -- same interface-stub rationale
   * as defaultCompressFs: injected real fs in tests, no-op defaults only. */
  return {
    async readFile() { return '' },
    async writeFile() {},
    async mkdir() {},
    async stat() { return { size: 0, mtimeMs: 0 } },
    async readdir() { return [] },
  }
  /* oxlint-enable typescript/require-await */
}
/* v8 ignore stop */

/**
 * Production fs surface: node:fs/promises wired into BOTH pipelines so the
 * compression writes and the audit normalization actually persist. The
 * default stubs above keep a missing injection from crashing the pipeline,
 * but apply() must inject this real surface — otherwise every write
 * fail-opens silently and the memory files never change.
 */
export function createRealFs(): CompressFs & AuditFs {
  return {
    async readFile(file) { return nodeFs.readFile(file, 'utf8') },
    async writeFile(file, data) {
      await nodeFs.mkdir(path.dirname(file), { recursive: true })
      await nodeFs.writeFile(file, data, 'utf8')
    },
    async mkdir(dir, options) { await nodeFs.mkdir(dir, options) },
    async stat(file) { const s = await nodeFs.stat(file); return { size: s.size, mtimeMs: s.mtimeMs } },
    async readdir(dir) { return nodeFs.readdir(dir) },
  }
}

/** One audit pass over the short-term memory files (六步管线一次运行). */
export async function runAuditOnce(deps: AuditDeps, config: ResolvedPluginConfig): Promise<AuditOutcome> {
  const paths = deps.paths
  const fsImpl = deps.fsImpl ?? defaultAuditFs()
  const targets = await scanShortTermFiles(paths, fsImpl)
  const changed = await deps.watcher.detectWrites(targets)
  const fixed: string[] = []
  const flagged: string[] = []
  const failed: string[] = []

  for (const file of changed) {
    const source = deps.registry.consume(file) ?? 'unknown'
    /* v8 ignore start -- confirmWriteComplete is fail-open by contract and
     * never rejects; this catch is defensive belt-and-braces only. */
    try {
      await confirmWriteComplete(file, fsImpl, {
        waitMs: resolveWriteWaitMs(source),
        extraWaitMs: config.confirmWaitMs,
        detectSource: () => source,
      })
    } catch {
      failed.push(file)
      continue
    }
    /* v8 ignore stop */
    let content: string
    try {
      content = await fsImpl.readFile(file)
    } catch {
      failed.push(file)
      continue
    }
    const result = await applyNormalization(file, kindOfFile(file, paths), content, {
      now: (deps.now ?? (() => new Date()))(),
      pendingReviewPath: paths.pendingReviewFile,
      auditDir: paths.auditDir,
    }, fsImpl)
    if (result.fixed) fixed.push(file)
    if (result.flagged) flagged.push(file)
  }
  return { scanned: targets, changed, fixed, flagged, failed }
}

/** Everything the poll pass needs (extracted for testability). */
export interface PollDeps {
  readonly watcher: MtimeWatcher
  readonly registry: PendingWriteRegistry
  readonly resolved: ResolvedPluginConfig
  readonly home: string
  /**
   * Real fs surface for the audit stage. Absent → the no-op default audit fs
   * (tests / defensive wiring); apply() always injects {@link createRealFs}.
   */
  readonly fsImpl?: CompressFs & AuditFs
}

/** The session header surface poll targeting needs (cwd only). */
export interface PollSessionSource {
  readonly header: { readonly cwd?: string }
}

/**
 * Distinct non-empty working directories of live sessions — the actual audit
 * poll targets (修复B: 不再用 process.cwd()).
 */
export function sessionWorkspaces(sessions: readonly PollSessionSource[]): string[] {
  const cwds = new Set<string>()
  for (const session of sessions) {
    if (session.header.cwd !== undefined && session.header.cwd !== '') cwds.add(session.header.cwd)
  }
  return [...cwds]
}

/**
 * One poll tick: run the audit pass for every distinct live-session workspace.
 * Returns the cwds that were audited (empty → nothing to audit).
 */
export async function pollSessions(deps: PollDeps, sessions: readonly PollSessionSource[]): Promise<string[]> {
  const cwds = sessionWorkspaces(sessions)
  for (const cwd of cwds) {
    await handlePoll(deps, cwd)
  }
  return cwds
}

/**
 * One poll tick: run the audit pass against the current working directory's
 * memory paths. Extracted from `apply` so the timer body is unit-testable.
 */
export async function handlePoll(deps: PollDeps, cwd: string): Promise<void> {
  const paths = resolveMemoryPaths(cwd, deps.home)
  const auditDeps: AuditDeps = {
    watcher: deps.watcher,
    registry: deps.registry,
    paths,
    ...(deps.fsImpl === undefined ? {} : { fsImpl: deps.fsImpl }),
  }
  const outcome = await runAuditOnce(auditDeps, deps.resolved)
  if (outcome.changed.length === 0) return
  console.info(`[dsh-memory-manager] poll audit: ${outcome.changed.length} changed, ${outcome.fixed.length} fixed, ${outcome.flagged.length} flagged`)
}

/** Everything the turn/end entry needs (extracted for testability). */
export interface TurnEndDeps extends PollDeps {
  readonly trigger: TurnTrigger
}

/**
 * Handle one `session/event`: on `turn/end`, trigger the compression + audit
 * chain for that session's workspace (时序: 先压缩后审核, 计划 v18 §4.2.1).
 */
/* oxlint-disable typescript/require-await -- handleTurnEnd only wires the
 * turn/end trigger handler; the actual awaits live inside the async callback
 * it registers, so the function itself has nothing to await. */
export async function handleTurnEnd(deps: TurnEndDeps, session: Session, event: SessionEvent): Promise<void> {
  /* oxlint-enable typescript/require-await */
  if (event.type !== 'turn/end') return
  const paths = resolveMemoryPaths(session.header.cwd ?? process.cwd(), deps.home)
  const register = (file: string, source: WriteSource): void => { deps.registry.register(file, source) }
  const userMemoryTarget = `${deps.home}/.dsh/memory/MEMORY.md`
  deps.trigger.onTurnEnd(session.id, event.data.turn, async (_sessionId, turn): Promise<void> => {
    try {
      const compressionDeps: CompressionDeps = {
        registerPendingWrite: register,
        userMemoryTarget,
        ...(deps.fsImpl === undefined ? {} : { fsImpl: deps.fsImpl }),
      }
      const outcome = await runCompression(session, turn, paths, deps.resolved, compressionDeps)
      // 可观测日志 #1: 压缩成功路径（全链路日志）
      console.info(`[dsh-memory-manager] turn/end #${turn} compressed, summary ${outcome.summaryOk ? 'written' : 'failed-open'}`)
      const auditDeps: AuditDeps = {
        watcher: deps.watcher,
        registry: deps.registry,
        paths,
        ...(deps.fsImpl === undefined ? {} : { fsImpl: deps.fsImpl }),
      }
      await runAuditOnce(auditDeps, deps.resolved)
    } catch (error) {
      // fail-open: every downstream step already contains its own failure
      // containment; this catch is defensive belt-and-braces.
      /* v8 ignore next -- unreachable by contract: every step is fail-open. */
      console.warn(`[dsh-memory-manager] turn/end pipeline failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** Plugin entry: wire the turn/end compressor and the mtime audit poll. */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const resolved = resolveConfig(config)
  const registry = new PendingWriteRegistry(resolved.pendingWriteTtlMs)
  const watcher = new MtimeWatcher()
  const trigger = new TurnTrigger({ thresholdTurns: resolved.triggerThresholdTurns })
  const home = os.homedir()
  // 生产必须注入真实 fs（不注入 → 压缩/审核全部静默 no-op，见 createRealFs 注释）
  const fsImpl = createRealFs()
  console.info(`[dsh-memory-manager] mounted: turn/end compressor + audit poll wired (poll every ${resolved.pollIntervalMs}ms)`)

  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    /* v8 ignore next -- one-line delegation; handleTurnEnd is fully unit-tested. */
    void handleTurnEnd({ watcher, registry, trigger, resolved, home, fsImpl }, session, event)
  })

  const pollTimer = setInterval(() => {
    // 修复B: poll 靶标 = 活动会话的 cwd（不再裸用 process.cwd()）
    const sessions = ctx.get('sessions')?.list() ?? []
    void pollSessions({ watcher, registry, resolved, home, fsImpl }, sessions).catch(
      /* v8 ignore start -- every stage is fail-open by contract; this catch
       * is defensive belt-and-braces only. */
      (error: unknown) => {
        ctx.logger.warn(`[dsh-memory-manager] poll audit failed: ${error instanceof Error ? error.message : String(error)}`)
      },
      /* v8 ignore stop */
    )
  }, resolved.pollIntervalMs)

  // 随插件 fiber 一起清理轮询定时器
  ctx.effect(function* sched(this: Context) {
    yield () => { clearInterval(pollTimer) }
  }.bind(ctx), 'dsh-memory-manager.poll()')
}
