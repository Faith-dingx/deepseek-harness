/**
 * Shared types for the dsh-guard-main-agent plugin.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

/** Fallback policy when the auxiliary classifier is unavailable or its output is unreadable. */
export type FallbackMode = 'close' | 'open'

/**
 * Why a classification attempt failed, if it did.
 * - `timeout` -> the classifier request timed out (transient jitter; retried)
 * - `fatal`  -> caller abort, network/HTTP errors, unreadable output (no retry)
 */
export type ClassifyErrorType = 'timeout' | 'fatal'

/**
 * Final per-call decision of the guard. `block` denies the tool call
 * (fail-close default), `allow` passes it through.
 */
export type GuardVerdict = 'block' | 'allow'

/**
 * Which existing subagent tool the guard auto-dispatches after a block.
 * - `code-agent`  -> `call_code_agent`  (opencode-go/deepseek-v4-flash)
 * - `check-agent` -> `call_check_agent` (agnes/agnes-2.5-flash)
 * - `plan-reviewer` is NEVER auto-dispatched; the classifier hands its prompt
 *   back through `reviewPrompt` and the main agent decides (plan decision 3).
 */
export type DelegateTarget = 'code-agent' | 'check-agent' | null

/** The structured decision for one tool call, logged verbatim for traceability. */
export interface PolicyVerdict {
  readonly verdict: GuardVerdict
  /** Human-readable justification (deny reason / allow note). */
  readonly reason: string
  /** Subagent to auto-dispatch after a block, or null. */
  readonly delegateTo: DelegateTarget
  /** Plan-review prompt handed to the main agent (never auto-dispatched). */
  readonly reviewPrompt: string | null
  /** Whether the classifier was unavailable/unreadable (traceability flag). */
  readonly classifierFailed: boolean
  /** Tool that was evaluated. */
  readonly toolName: string
  /**
   * Classification failure cause when the classifier failed (`timeout` =
   * transient, retried; `fatal` = real failure). Absent on success/cache hits.
   */
  readonly errorType?: ClassifyErrorType
}

/** Raw classifier output, matching the prompt contract in prompt.ts. */
export interface ClassifierOutput {
  readonly verdict?: 'block' | 'allow'
  readonly reason?: string
  readonly delegateTo?: DelegateTarget
  readonly reviewPrompt?: string | null
}

/** User-facing plugin config (validated by the schemastery schema in index.ts). */
export interface GuardPluginConfig {
  /** Auxiliary classifier Chat Completions endpoint. */
  classifierEndpoint?: string
  /** Auxiliary classifier model id (e.g. `agnes/agnes-2.5-flash`). */
  classifierModel?: string
  /** Fallback policy when classification fails (default `close`). */
  fallback?: FallbackMode
  /** Fallback policy for diagnostic/read-only tools (default `open`). */
  diagnosticFallback?: FallbackMode
  /** Classifier request timeout, milliseconds. */
  timeoutMs?: number
  /**
   * Retry count for transient classifier timeouts (default `1`). HTTP
   * errors, network failures, caller aborts and unreadable output never retry.
   */
  retryCount?: number
  /** Cache TTL, milliseconds. */
  cacheTtlMs?: number
  /** LRU cache cap. */
  cacheMax?: number
  /** Agent/preset id used in the classification cache key. */
  presetId?: string
  /** YAML whitelist file path (file policy), relative to the workspace cwd. */
  filePolicyPath?: string
  /** Optional boundary-doc path whose text is prepended to the classifier system prompt. */
  boundaryDocPath?: string
}

/** Resolved plugin configuration with defaults applied. */
export interface ResolvedGuardConfig {
  readonly classifierEndpoint: string
  readonly classifierModel: string
  readonly fallback: FallbackMode
  readonly diagnosticFallback: FallbackMode
  readonly timeoutMs: number
  /** Retry count for transient classifier timeouts (resolved default `1`). */
  readonly retryCount: number
  readonly cacheTtlMs: number
  readonly cacheMax: number
  readonly presetId: string
  readonly filePolicyPath: string | null
  readonly boundaryDocPath: string | null
}

/** Everything the classifier needs to judge one tool call. */
export interface ClassifierContext {
  /** Session id (cache key field). */
  readonly sessionId: string
  /** Workspace root (cache key field). */
  readonly workspacePath: string
  /** Preset id (cache key field). */
  readonly presetId: string
  /** Tool name being evaluated. */
  readonly toolName: string
  /** Summarized tool arguments (first 500 chars, per plan decision 3 risk). */
  readonly argsSummary: string
  /** Last 5 rounds of user + assistant message text. */
  readonly conversation: string
  /** Last user message text (task driving the current turn). */
  readonly userMessage: string
}
