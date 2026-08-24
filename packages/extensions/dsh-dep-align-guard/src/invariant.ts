/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-dep-align-guard`.
 * @module @deepseek-ai/dsh-dep-align-guard/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-dep-align-guard'

/** Cordis companion plugin name. */
export const name = 'dsh-dep-align-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the guard is a pre/post-execute policy transform whose
 * blocking state lives in host memory; its behavior is covered by the
 * integration tests instead (detection, warn, block, alignment checks).
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
