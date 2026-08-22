/**
 * Static configuration, thresholds, and path templates for dsh-memory-manager
 * (计划 v18). Everything the plan pins down numerically lives here: trigger
 * thresholds, poll/confirm timing, the write-source wait table, the
 * short-term file watch list (归档区 explizit excluded), archive layout, and
 * the LLM defaults for the 9888 router. The plugin is config-light: sensible
 * plan defaults, per-instance overrides only.
 *
 * @module dsh-memory-manager/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** The workspace memory directory name (计划 v18 §二 映射表). */
export const MEMORY_DIR = '.dsh-memory'
/** Injection-backing summary file, single-file overwrite strategy (§3.6). */
export const SUMMARY_FILE = 'conversationsummary-latest.md'
/** Suggestion entries awaiting user confirmation (§4.2.3). */
export const PENDING_SUGGESTIONS_FILE = 'pending-suggestions.json'
/** Pending-review queue for out-of-category / semantic issues (§5.2 步骤④). */
export const PENDING_REVIEW_FILE = 'pending-review.json'
/** History archive root (过时/无用), NOT audited (§3.7). */
export const HISTORY_ARCHIVE_RELATIVE = '.dsh-memory/archive/history'
/** Expired-summary archive directory (§5.3). */
export const SUMMARIES_ARCHIVE_RELATIVE = '.dsh-memory/archive/summaries'
/** Audit log directory (§5.2 步骤⑥ / T9). */
export const AUDIT_DIR_RELATIVE = '.dsh-memory/audit'
/** Daily reflection directory (独立历史文档, §二 映射表). */
export const REFLECTIONS_DIR_RELATIVE = '.dsh-memory/reflections'

/** Compression fires only when history reaches this many turns (§4.2.4). */
export const TRIGGER_THRESHOLD_TURNS = 8
/** The most recent turns kept verbatim in the context (§4.2.4). */
export const RETAIN_RECENT_TURNS = 2
/** mtime poll interval for 步骤① (T3, default 5s). */
export const POLL_INTERVAL_MS = 5000
/** Fallback confirm wait for unknown write sources (步骤②, 2s). */
export const CONFIRM_WAIT_MS = 2000
/** pendingWrite map entry lifetime (步骤②, 5s). */
export const PENDING_WRITE_TTL_MS = 5000
/** LLM classify confidence below this degrades to rules/review (§4.2.2). */
export const CLASSIFY_CONFIDENCE_THRESHOLD = 0.6

/**
 * LLM tuning defaults for the 9888 router (实测根因修复): the gateway latency
 * grows with payload size (7.5KB → 4.4s, 93.7KB → 10.7s), so the old
 * hardcoded 10s timeout aborted every real 100KB+ session window. Timeouts
 * are raised to 25s, and the payload is bounded by batch caps + per-segment
 * truncation so the latency stays predictable.
 */
/** Classify LLM call timeout (9888 gateway, 大窗口防护). */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 25000
/** Summarize LLM call timeout (9888 gateway, 大窗口防护). */
export const DEFAULT_SUMMARIZE_TIMEOUT_MS = 25000
/** Max pending segments sent to the classify LLM in one batch (newest win). */
export const DEFAULT_CLASSIFY_MAX_BATCH = 60
/** Max still-useful segments sent to the summarize LLM (newest win). */
export const DEFAULT_SUMMARIZE_MAX_SEGMENTS = 30
/** Per-segment char cap for LLM payloads (truncated with an ellipsis marker). */
export const DEFAULT_LLM_SEGMENT_CHARS = 400

/** The 9888 router endpoint used for classify + summarize LLM calls. */
export const DEFAULT_ENDPOINT = 'http://10.10.10.2:9888/v1/chat/completions'
/** Default cheap model for classify + summarize (计划 v18 §8.3-T12). */
export const DEFAULT_MODEL = 'agnes/agnes-2.5-flash'

/**
 * Write-source classification (计划 v18 §5.2 步骤② table). Each source maps
 * to a wait strategy: atomic plugin writes need no wait, fast appendText
 * writers get a short wait, unknown stays at the 2s fallback.
 */
export type WriteSource =
  | 'model-explicit' // memory_write tool call: atomic, complete on return
  | 'turn-stopping' // auto-memory turn-stopping appendText
  | 'persona-learning'
  | 'history-compressor' // this plugin's summary/suggestion writes
  | 'unknown'

export const WRITE_SOURCES: readonly WriteSource[] = ['model-explicit', 'turn-stopping', 'persona-learning', 'history-compressor', 'unknown'] as const

/** Wait budget before reading a file after its write source was identified. */
export function resolveWriteWaitMs(source: WriteSource): number {
  switch (source) {
    case 'model-explicit':
      return 0
    case 'turn-stopping':
    case 'persona-learning':
    case 'history-compressor':
      return 500
    case 'unknown':
      return CONFIRM_WAIT_MS
  }
}

/** Concrete paths of the memory system for one workspace + home. */
export interface MemoryPaths {
  readonly userMemoryFile: string
  readonly userProfileFile: string
  readonly userCalendarFile: string
  readonly summaryFile: string
  readonly suggestionsFile: string
  readonly pendingReviewFile: string
  readonly auditDir: string
  readonly reflectionsDir: string
  readonly historyArchiveRoot: string
  readonly summariesArchiveDir: string
}

function userMemoryDir(homeDir: string): string {
  return path.join(homeDir, '.dsh', 'memory')
}

/** Resolve every managed path for a workspace root and home directory. */
export function resolveMemoryPaths(workspaceRoot: string, homeDir: string): MemoryPaths {
  const memory = path.join(workspaceRoot, MEMORY_DIR)
  const user = userMemoryDir(homeDir)
  return {
    userMemoryFile: path.join(user, 'MEMORY.md'),
    userProfileFile: path.join(user, 'USER.md'),
    userCalendarFile: path.join(user, 'CALENDAR.md'),
    summaryFile: path.join(memory, SUMMARY_FILE),
    suggestionsFile: path.join(memory, PENDING_SUGGESTIONS_FILE),
    pendingReviewFile: path.join(memory, PENDING_REVIEW_FILE),
    auditDir: path.join(memory, 'audit'),
    reflectionsDir: path.join(memory, 'reflections'),
    historyArchiveRoot: path.join(memory, 'archive', 'history'),
    summariesArchiveDir: path.join(memory, 'archive', 'summaries'),
  }
}

/**
 * Short-term file watch list (计划 v18 §5.2 步骤① SHORT_TERM_FILES). Each
 * entry is a template resolved per workspace; `kind` tells the watcher how to
 * treat the resolved path: `file` = single fixed file, `scan` = enumerate the
 * directory / glob under it (daily logs `*.md`, reflections dir). The 归档区
 * (archive/) is explicitly NOT part of this list — writing there must never
 * re-trigger the audit pipeline (计划 v18 §7 协同点 3).
 */
export type ShortTermPatternKind = 'file' | 'scan'

export interface ShortTermFilePattern {
  readonly kind: ShortTermPatternKind
  readonly resolve: (workspaceRoot: string, homeDir: string) => string
}

export const SHORT_TERM_FILES: readonly ShortTermFilePattern[] = [
  { kind: 'file', resolve: (_ws, home) => path.join(userMemoryDir(home), 'MEMORY.md') },
  { kind: 'file', resolve: (_ws, home) => path.join(userMemoryDir(home), 'USER.md') },
  { kind: 'file', resolve: (_ws, home) => path.join(userMemoryDir(home), 'CALENDAR.md') },
  { kind: 'file', resolve: workspace => path.join(workspace, MEMORY_DIR, SUMMARY_FILE) },
  { kind: 'file', resolve: workspace => path.join(workspace, MEMORY_DIR, PENDING_SUGGESTIONS_FILE) },
  { kind: 'scan', resolve: workspace => path.join(workspace, MEMORY_DIR, 'reflections') },
  { kind: 'scan', resolve: workspace => path.join(workspace, MEMORY_DIR, '*.md') },
] as const

/** Whether a resolved short-term path carries a glob needing a dir scan. */
export function isGlobPattern(resolvedPath: string): boolean {
  return resolvedPath.includes('*')
}

/** Fixed (single-file) audit targets for one workspace — used by watcher. */
export function resolveAllTargets(workspaceRoot: string, homeDir: string): string[] {
  return SHORT_TERM_FILES
    .filter(t => t.kind === 'file')
    .map(t => t.resolve(workspaceRoot, homeDir))
}

/** Map a short-term file path to its content kind for the audit pass. */
export function kindOfFile(path: string, paths: MemoryPaths): MemoryFileKindLike {
  if (path === paths.summaryFile || path.endsWith(`/${SUMMARY_FILE}`)) return 'summary'
  if (path === paths.suggestionsFile || path.endsWith(`/${PENDING_SUGGESTIONS_FILE}`)) return 'suggestions'
  if (path === paths.userCalendarFile) return 'calendar'
  if (path === paths.userMemoryFile || path === paths.userProfileFile) return 'memory'
  if (path.startsWith(`${paths.reflectionsDir}/`)) return 'reflection'
  return 'log'
}

/** The audit content kinds (unions with the validator's MemoryFileKind). */
export type MemoryFileKindLike = 'memory' | 'log' | 'reflection' | 'summary' | 'suggestions' | 'calendar'

/**
 * Plugin configuration (计划 v18 §8.3-T12). All fields optional with the
 * plan's defaults; callers get the effective values through
 * {@link resolveConfig}.
 */
export interface PluginConfig {
  summaryEndpoint?: string
  summaryModel?: string
  classifyModel?: string
  /** History compression fires when turns >= threshold (§4.2.4). */
  triggerThresholdTurns?: number
  /** Recent turns kept verbatim (§4.2.4). */
  retainRecentTurns?: number
  /** mtime poll interval (步骤①). */
  pollIntervalMs?: number
  /** Unknown-source write wait (步骤②). */
  confirmWaitMs?: number
  /** pendingWrite map entry lifetime (步骤②). */
  pendingWriteTtlMs?: number
  /** Classify confidence threshold (§4.2.2). */
  classifyConfidenceThreshold?: number
  /** Classify LLM call timeout (9888 gateway, 大窗口防护). */
  classifyTimeoutMs?: number
  /** Summarize LLM call timeout (9888 gateway, 大窗口防护). */
  summaryTimeoutMs?: number
  /** Max pending segments sent to the classify LLM in one batch (newest win). */
  classifyMaxBatch?: number
  /** Max still-useful segments sent to the summarize LLM (newest win). */
  summarizeMaxSegments?: number
  /** Per-segment char cap for LLM payloads (truncated with an ellipsis marker). */
  llmSegmentChars?: number
  /** Maintenance: archive files older than N days get gzip-compressed (§5.3). */
  archiveMaxAgeDays?: number
  /** Maintenance: summary older than N days moves to archive/summaries (§5.3). */
  summaryMaxAgeDays?: number
  /** Maintenance: suggestion entries older than N days expire (§5.3). */
  suggestionMaxAgeDays?: number
  /** Summary length budget: total lines (计划 v18 §3.6 长度预算). */
  maxSummaryLines?: number
  /** Optional override of the history archive root (default per workspace). */
  historyArchiveRoot?: string | null
}

/** Fully-resolved plugin settings (every field has an effective value). */
export interface ResolvedPluginConfig {
  readonly summaryEndpoint: string
  readonly summaryModel: string
  readonly classifyModel: string
  readonly triggerThresholdTurns: number
  readonly retainRecentTurns: number
  readonly pollIntervalMs: number
  readonly confirmWaitMs: number
  readonly pendingWriteTtlMs: number
  readonly classifyConfidenceThreshold: number
  readonly classifyTimeoutMs: number
  readonly summaryTimeoutMs: number
  readonly classifyMaxBatch: number
  readonly summarizeMaxSegments: number
  readonly llmSegmentChars: number
  readonly archiveMaxAgeDays: number
  readonly summaryMaxAgeDays: number
  readonly suggestionMaxAgeDays: number
  readonly maxSummaryLines: number
  readonly historyArchiveRoot: string | null
}

/** Schemastery schema validating plugin config and filling plan defaults. */
export const Config: z<PluginConfig> = z.object({
  summaryEndpoint: z.string().default(DEFAULT_ENDPOINT),
  summaryModel: z.string().default(DEFAULT_MODEL),
  classifyModel: z.string().default(DEFAULT_MODEL),
  triggerThresholdTurns: z.number().default(TRIGGER_THRESHOLD_TURNS),
  retainRecentTurns: z.number().default(RETAIN_RECENT_TURNS),
  pollIntervalMs: z.number().default(POLL_INTERVAL_MS),
  confirmWaitMs: z.number().default(CONFIRM_WAIT_MS),
  pendingWriteTtlMs: z.number().default(PENDING_WRITE_TTL_MS),
  classifyConfidenceThreshold: z.number().default(CLASSIFY_CONFIDENCE_THRESHOLD),
  classifyTimeoutMs: z.number().default(DEFAULT_CLASSIFY_TIMEOUT_MS),
  summaryTimeoutMs: z.number().default(DEFAULT_SUMMARIZE_TIMEOUT_MS),
  classifyMaxBatch: z.number().default(DEFAULT_CLASSIFY_MAX_BATCH),
  summarizeMaxSegments: z.number().default(DEFAULT_SUMMARIZE_MAX_SEGMENTS),
  llmSegmentChars: z.number().default(DEFAULT_LLM_SEGMENT_CHARS),
  archiveMaxAgeDays: z.number().default(90),
  summaryMaxAgeDays: z.number().default(7),
  suggestionMaxAgeDays: z.number().default(7),
  maxSummaryLines: z.number().default(50),
  // Preserve omission (Schemastery convention): optional path override.
  historyArchiveRoot: z.string().default(undefined as unknown as string),
})

/** Fold raw config onto the plan defaults, nulling the absent override. */
export function resolveConfig(raw: PluginConfig): ResolvedPluginConfig {
  return {
    summaryEndpoint: raw.summaryEndpoint ?? DEFAULT_ENDPOINT,
    summaryModel: raw.summaryModel ?? DEFAULT_MODEL,
    classifyModel: raw.classifyModel ?? DEFAULT_MODEL,
    triggerThresholdTurns: raw.triggerThresholdTurns ?? TRIGGER_THRESHOLD_TURNS,
    retainRecentTurns: raw.retainRecentTurns ?? RETAIN_RECENT_TURNS,
    pollIntervalMs: raw.pollIntervalMs ?? POLL_INTERVAL_MS,
    confirmWaitMs: raw.confirmWaitMs ?? CONFIRM_WAIT_MS,
    pendingWriteTtlMs: raw.pendingWriteTtlMs ?? PENDING_WRITE_TTL_MS,
    classifyConfidenceThreshold: raw.classifyConfidenceThreshold ?? CLASSIFY_CONFIDENCE_THRESHOLD,
    classifyTimeoutMs: raw.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
    summaryTimeoutMs: raw.summaryTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
    classifyMaxBatch: raw.classifyMaxBatch ?? DEFAULT_CLASSIFY_MAX_BATCH,
    summarizeMaxSegments: raw.summarizeMaxSegments ?? DEFAULT_SUMMARIZE_MAX_SEGMENTS,
    llmSegmentChars: raw.llmSegmentChars ?? DEFAULT_LLM_SEGMENT_CHARS,
    archiveMaxAgeDays: raw.archiveMaxAgeDays ?? 90,
    summaryMaxAgeDays: raw.summaryMaxAgeDays ?? 7,
    suggestionMaxAgeDays: raw.suggestionMaxAgeDays ?? 7,
    maxSummaryLines: raw.maxSummaryLines ?? 50,
    historyArchiveRoot: raw.historyArchiveRoot ?? null,
  }
}
