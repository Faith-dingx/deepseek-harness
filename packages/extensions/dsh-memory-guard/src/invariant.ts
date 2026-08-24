/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-guard`.
 * @module @deepseek-ai/dsh-memory-guard/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-guard'

/** Cordis companion plugin name. */
export const name = 'dsh-memory-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the guard is a pre-execute payload policy with no
 * package-owned event or snapshot an independent companion could observe; its
 * behavior is covered by the integration tests instead.
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
