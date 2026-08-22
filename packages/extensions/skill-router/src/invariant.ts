/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-skill-router`.
 * @module @deepseek-ai/dsh-skill-router/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-router'

/** Cordis companion plugin name. */
export const name = 'skill-router-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: filtering is a view-level transform on the skill-catalog
 * message and exposes no package-owned event or snapshot an independent
 * companion could observe; its behavior is covered by its unit + integration
 * tests instead.
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
