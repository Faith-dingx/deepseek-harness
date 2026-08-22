/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-manager`.
 * @module @deepseek-ai/dsh-memory-manager/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-manager'

/** Cordis companion plugin name. */
export const name = 'dsh-memory-manager-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the manager is a four-category triage + six-step
 * audit pipeline over memory files with fail-open degradations on every path;
 * its behavior is covered by the unit + integration tests instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
