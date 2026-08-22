import { describe, expect, it } from 'vitest'
import {
  AUDIT_DIR_RELATIVE,
  CLASSIFY_CONFIDENCE_THRESHOLD,
  CONFIRM_WAIT_MS,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  HISTORY_ARCHIVE_RELATIVE,
  MEMORY_DIR,
  PENDING_REVIEW_FILE,
  PENDING_SUGGESTIONS_FILE,
  POLL_INTERVAL_MS,
  PENDING_WRITE_TTL_MS,
  REFLECTIONS_DIR_RELATIVE,
  RETAIN_RECENT_TURNS,
  SHORT_TERM_FILES,
  SUMMARIES_ARCHIVE_RELATIVE,
  SUMMARY_FILE,
  TRIGGER_THRESHOLD_TURNS,
  WRITE_SOURCES,
  Config,
  isGlobPattern,
  resolveAllTargets,
  resolveConfig,
  resolveMemoryPaths,
  resolveWriteWaitMs,
  type PluginConfig,
} from '../src/config.ts'

describe('config constants (计划 v18 §4.2.3 / §5.2 / §8.2-T12)', () => {
  it('exposes the fixed file names of the memory system', () => {
    expect(SUMMARY_FILE).toBe('conversationsummary-latest.md')
    expect(PENDING_SUGGESTIONS_FILE).toBe('pending-suggestions.json')
    expect(PENDING_REVIEW_FILE).toBe('pending-review.json')
  })

  it('archive roots live under .dsh-memory/archive and are NOT audit targets', () => {
    expect(HISTORY_ARCHIVE_RELATIVE).toBe('.dsh-memory/archive/history')
    expect(SUMMARIES_ARCHIVE_RELATIVE).toBe('.dsh-memory/archive/summaries')
    // 计划 v18 §7 协同点 3: 归档区不在 SHORT_TERM_FILES 中
    const resolved = SHORT_TERM_FILES.map(t => t.resolve('/ws', '/home/u'))
    expect(resolved.some(p => p.includes('archive/history') || p.includes('archive/summaries'))).toBe(false)
  })

  it('reveals the remaining relative directories and LLM defaults', () => {
    expect(AUDIT_DIR_RELATIVE).toBe('.dsh-memory/audit')
    expect(REFLECTIONS_DIR_RELATIVE).toBe('.dsh-memory/reflections')
    expect(MEMORY_DIR).toBe('.dsh-memory')
    expect(DEFAULT_ENDPOINT).toBe('http://10.10.10.2:9888/v1/chat/completions')
    expect(DEFAULT_MODEL).toBe('agnes/agnes-2.5-flash')
  })

  it('holds the tuned thresholds and wait times from the plan', () => {
    expect(TRIGGER_THRESHOLD_TURNS).toBe(8)
    expect(RETAIN_RECENT_TURNS).toBe(2)
    expect(POLL_INTERVAL_MS).toBe(5000)
    expect(CONFIRM_WAIT_MS).toBe(2000)
    expect(PENDING_WRITE_TTL_MS).toBe(5000)
    expect(CLASSIFY_CONFIDENCE_THRESHOLD).toBe(0.6)
  })
})

describe('resolveMemoryPaths (计划 v18 §3.7 / §4.2.3)', () => {
  const workspace = '/ws'
  const home = '/home/u'

  it('maps the workspace .dsh-memory layout (summary, suggestions, audit, reflections, archives)', () => {
    const p = resolveMemoryPaths(workspace, home)
    expect(p.summaryFile).toBe('/ws/.dsh-memory/conversationsummary-latest.md')
    expect(p.suggestionsFile).toBe('/ws/.dsh-memory/pending-suggestions.json')
    expect(p.pendingReviewFile).toBe('/ws/.dsh-memory/pending-review.json')
    expect(p.auditDir).toBe('/ws/.dsh-memory/audit')
    expect(p.reflectionsDir).toBe('/ws/.dsh-memory/reflections')
    expect(p.historyArchiveRoot).toBe('/ws/.dsh-memory/archive/history')
    expect(p.summariesArchiveDir).toBe('/ws/.dsh-memory/archive/summaries')
  })

  it('maps the user-level ~/.dsh/memory files (MEMORY / USER / CALENDAR)', () => {
    const p = resolveMemoryPaths(workspace, home)
    expect(p.userMemoryFile).toBe('/home/u/.dsh/memory/MEMORY.md')
    expect(p.userProfileFile).toBe('/home/u/.dsh/memory/USER.md')
    expect(p.userCalendarFile).toBe('/home/u/.dsh/memory/CALENDAR.md')
  })

  it('MEMORY_DIR is the workspace-relative .dsh-memory directory name', () => {
    expect(MEMORY_DIR).toBe('.dsh-memory')
  })
})

describe('SHORT_TERM_FILES (计划 v18 §5.2 步骤①)', () => {
  const workspace = '/ws'
  const home = '/home/u'

  it('lists both home-level and workspace-level memory files under audit', () => {
    const files = SHORT_TERM_FILES.map(t => t.resolve(workspace, home))
    expect(files).toContain('/home/u/.dsh/memory/MEMORY.md')
    expect(files).toContain('/home/u/.dsh/memory/USER.md')
    expect(files).toContain('/home/u/.dsh/memory/CALENDAR.md')
    expect(files).toContain('/ws/.dsh-memory/conversationsummary-latest.md')
    expect(files).toContain('/ws/.dsh-memory/pending-suggestions.json')
    expect(files).toContain('/ws/.dsh-memory/reflections')
    // 日志文件用 glob 模板（每日一文件, 计划 v18 §5.2 SHORT_TERM_FILES）
    expect(files).toContain('/ws/.dsh-memory/*.md')
    expect(files.some(p => p.includes('archive'))).toBe(false)
  })
})

describe('WRITE_SOURCES (计划 v18 §5.2 步骤②)', () => {
  it('covers every source the plan defines and maps its wait strategy', () => {
    expect(WRITE_SOURCES).toEqual([
      'model-explicit',
      'turn-stopping',
      'persona-learning',
      'history-compressor',
      'unknown',
    ])
    expect(resolveWriteWaitMs('model-explicit')).toBe(0)
    expect(resolveWriteWaitMs('turn-stopping')).toBe(500)
    expect(resolveWriteWaitMs('persona-learning')).toBe(500)
    expect(resolveWriteWaitMs('history-compressor')).toBe(500)
    expect(resolveWriteWaitMs('unknown')).toBe(2000)
    // unknown 是显式降级兜底, 不额外放宽
    expect(resolveWriteWaitMs('unknown')).toBe(2000)
  })
})

describe('resolveAllTargets (计划 v18 §5.2 步骤① 扫描)', () => {
  it('resolves concrete target files for every short-term file template', () => {
    const targets = resolveAllTargets('/ws', '/home/u')
    expect(targets).toEqual([
      '/home/u/.dsh/memory/MEMORY.md',
      '/home/u/.dsh/memory/USER.md',
      '/home/u/.dsh/memory/CALENDAR.md',
      '/ws/.dsh-memory/conversationsummary-latest.md',
      '/ws/.dsh-memory/pending-suggestions.json',
    ])
  })
})

describe('PluginConfig schema (计划 v18 §8.3-T12)', () => {
  it('defaults match the plan (agnes via 9888, triggers at 8 turns)', () => {
    const cfg: PluginConfig = {}
    expect(cfg.summaryEndpoint ?? DEFAULT_ENDPOINT).toBe(DEFAULT_ENDPOINT)
    expect(cfg.summaryModel ?? DEFAULT_MODEL).toBe(DEFAULT_MODEL)
    expect(cfg.classifyModel ?? DEFAULT_MODEL).toBe(DEFAULT_MODEL)
    expect(cfg.triggerThresholdTurns ?? TRIGGER_THRESHOLD_TURNS).toBe(TRIGGER_THRESHOLD_TURNS)
    expect(cfg.pollIntervalMs ?? POLL_INTERVAL_MS).toBe(POLL_INTERVAL_MS)
    expect(cfg.historyArchiveRoot).toBeUndefined()
  })

  it('validateConfig schema parses overrides and fills the plan defaults', () => {
    const parsed = Config({ summaryModel: 'agnes/agnes-3', triggerThresholdTurns: 12 })
    expect(parsed.summaryModel).toBe('agnes/agnes-3')
    expect(parsed.classifyModel).toBe(DEFAULT_MODEL)
    expect(parsed.triggerThresholdTurns).toBe(12)
    expect(parsed.summaryEndpoint).toBe(DEFAULT_ENDPOINT)
    expect(parsed.pollIntervalMs).toBe(POLL_INTERVAL_MS)
    expect(parsed.retainRecentTurns).toBe(RETAIN_RECENT_TURNS)
    expect(parsed.confirmWaitMs).toBe(CONFIRM_WAIT_MS)
    expect(parsed.pendingWriteTtlMs).toBe(PENDING_WRITE_TTL_MS)
    expect(parsed.classifyConfidenceThreshold).toBe(CLASSIFY_CONFIDENCE_THRESHOLD)
    expect(parsed.archiveMaxAgeDays).toBe(90)
    expect(parsed.summaryMaxAgeDays).toBe(7)
    expect(parsed.suggestionMaxAgeDays).toBe(7)
    expect(parsed.maxSummaryLines).toBe(50)
  })

  it('resolveConfig folds raw partials onto the same defaults', () => {
    const resolved = resolveConfig({ classifyConfidenceThreshold: 0.75 })
    expect(resolved.classifyConfidenceThreshold).toBe(0.75)
    expect(resolved.summaryEndpoint).toBe(DEFAULT_ENDPOINT)
    expect(resolved.summaryModel).toBe(DEFAULT_MODEL)
    expect(resolved.classifyModel).toBe(DEFAULT_MODEL)
    expect(resolved.triggerThresholdTurns).toBe(8)
    expect(resolved.retainRecentTurns).toBe(2)
    expect(resolved.pollIntervalMs).toBe(5000)
    expect(resolved.confirmWaitMs).toBe(2000)
    expect(resolved.pendingWriteTtlMs).toBe(5000)
    expect(resolved.archiveMaxAgeDays).toBe(90)
    expect(resolved.summaryMaxAgeDays).toBe(7)
    expect(resolved.suggestionMaxAgeDays).toBe(7)
    expect(resolved.maxSummaryLines).toBe(50)
    expect(resolved.historyArchiveRoot).toBeNull()
  })

  it('isGlobPattern detects directory-scan templates only', () => {
    expect(isGlobPattern('/ws/.dsh-memory/*.md')).toBe(true)
    expect(isGlobPattern('/ws/.dsh-memory/conversationsummary-latest.md')).toBe(false)
    expect(isGlobPattern('/ws/.dsh-memory/reflections')).toBe(false)
  })
})
