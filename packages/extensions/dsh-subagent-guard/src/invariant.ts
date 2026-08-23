/**
 * Invariant companion: registers this package's ownership with the
 * `ctx.invariants` registry so runtime-diagnostics can attribute findings to
 * `@deepseek-ai/dsh-subagent-guard`. The installer is intentionally empty —
 * this package's logging already carries the `[subagent-guard]` prefix.
 *
 * @module @deepseek-ai/dsh-subagent-guard/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import also loads dsh-invariants' Context augmentation (`ctx.invariants`).
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-guard'
const install: InvariantInstaller = () => {}

export const name = 'subagent-guard-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
