/**
 * Configuration schema and bounds normalization for the subagent guard.
 *
 * `Config` is the schemastery schema cordis uses for validation/UI metadata;
 * `resolveConfig` is the runtime entry point that clamps out-of-range values
 * back to defaults with a warning instead of throwing, then applies the
 * schema's remaining defaults.
 *
 * @module @deepseek-ai/dsh-subagent-guard/config
 */

import z from '@deepseek-ai/schemastery'
import type { GuardConfig, RawConfig } from './types.ts'

/** Narrow logger surface so config.ts stays dependency-light. */
export interface GuardLogger {
  warn(message: string): void
}

const DEFAULTS: GuardConfig = {
  maxConcurrent: 2,
  idleTimeoutMs: 600000,
  idlePollMs: 30000,
  enabled: true,
}

export const Config = z.object({
  maxConcurrent: z.natural().min(1).default(DEFAULTS.maxConcurrent),
  idleTimeoutMs: z.natural().min(1000).default(DEFAULTS.idleTimeoutMs),
  idlePollMs: z.natural().min(1000).default(DEFAULTS.idlePollMs),
  enabled: z.boolean().default(DEFAULTS.enabled),
})

/**
 * Normalize a raw (possibly partial, possibly out-of-range) config into a
 * valid {@link GuardConfig}. Out-of-bounds values fall back to the default
 * with a warning rather than throwing, so a stale preset or hostile value
 * cannot disable the guard through bounds alone.
 */
export function resolveConfig(raw: RawConfig = {}, logger?: GuardLogger): GuardConfig {
  const out: RawConfig = { ...raw }

  if (
    typeof out.maxConcurrent !== 'number'
    || !Number.isInteger(out.maxConcurrent)
    || (out.maxConcurrent as number) < 1
  ) {
    if (out.maxConcurrent !== undefined) {
      logger?.warn(`[subagent-guard] maxConcurrent=${out.maxConcurrent} 越界，回退默认 ${DEFAULTS.maxConcurrent}`)
    }
    out.maxConcurrent = DEFAULTS.maxConcurrent
  }
  if (
    typeof out.idleTimeoutMs !== 'number'
    || !Number.isInteger(out.idleTimeoutMs)
    || (out.idleTimeoutMs as number) < 1000
  ) {
    if (out.idleTimeoutMs !== undefined) {
      logger?.warn(`[subagent-guard] idleTimeoutMs=${out.idleTimeoutMs} 越界，回退默认 ${DEFAULTS.idleTimeoutMs}`)
    }
    out.idleTimeoutMs = DEFAULTS.idleTimeoutMs
  }
  if (
    typeof out.idlePollMs !== 'number'
    || !Number.isInteger(out.idlePollMs)
    || (out.idlePollMs as number) < 1000
  ) {
    if (out.idlePollMs !== undefined) {
      logger?.warn(`[subagent-guard] idlePollMs=${out.idlePollMs} 越界，回退默认 ${DEFAULTS.idlePollMs}`)
    }
    out.idlePollMs = DEFAULTS.idlePollMs
  }
  if (typeof out.enabled !== 'boolean') {
    out.enabled = DEFAULTS.enabled
  }

  return Config(out) as GuardConfig
}
