/**
 * Shared types for the dsh-skill-router plugin.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

/** How the plugin behaves when the classifier is unavailable or its output is unreadable. */
export type FallbackMode = 'close' | 'open' | 'minimal'

/**
 * The outcome of one classification pass: which skill names to keep exposed to
 * the model. Names are matched against the catalog's available skills; unknown
 * names are ignored by the injector.
 */
export interface SkillFilterResult {
  /** Skill names to keep (a subset of the available catalog entries). */
  readonly included: readonly string[]
  /** Human-readable justification from the classifier, if any. */
  readonly reason?: string
}

/** One entry of the durable skill-catalog message (mirrors dsh-tool-skill). */
export interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
}

/** Plugin configuration (validated by the schemastery schema). */
export interface SkillRouterConfig {
  /** HTTP endpoint for the auxiliary classifier Chat Completions call. */
  classifierEndpoint: string
  /** Model id used for classification. */
  classifierModel: string
  /** Fallback policy when classification fails. */
  fallback: FallbackMode
  /** Abort timeout for a single classifier request, milliseconds. */
  timeoutMs: number
  /** Cache TTL, milliseconds. */
  cacheTtlMs: number
  /** Maximum number of entries in the classification cache. */
  cacheMax: number
}

/** Context passed to the classifier alongside the user message. */
export interface ClassifierContext {
  /** Absolute workspace root path. */
  readonly workspacePath: string
  /** The agent/preset id the task runs under. */
  readonly presetId: string
  /** The session id the task belongs to. */
  readonly sessionId: string
}
