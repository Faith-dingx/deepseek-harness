/**
 * Public configuration surface for the subagent guard.
 *
 * @module @deepseek-ai/dsh-subagent-guard/types
 */

/**
 * Resolved guard behaviour. `maxConcurrent` caps simultaneous in-flight
 * subagent runs; `idleTimeoutMs` is how long a run may sit without session
 * progress (or, for remote runs, without settling at all) before the guard
 * force-disposes it; `idlePollMs` is the watchdog cadence; `enabled` is a
 * master switch that bypasses every interception when false.
 */
export interface GuardConfig {
  /** Default 2, minimum 1. */
  maxConcurrent: number
  /** Default 600000 (10min), minimum 1000. */
  idleTimeoutMs: number
  /** Default 30000 (30s), minimum 1000. */
  idlePollMs: number
  /** Default true. */
  enabled: boolean
}

/** Allow callers to pass a partial config; gaps are filled with defaults. */
export type RawConfig = Partial<GuardConfig>
