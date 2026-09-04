/**
 * Package-owned invariant companion for `@harness-desktop/dsh-client-ui-goal`.
 * @module @harness-desktop/dsh-client-ui-goal/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-client-ui-goal'

/** Cordis companion plugin name. */
export const name = 'client-ui-goal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a single GoalBar dock registration whose disposal is
 * proven by the HMR-safety spec — the plugin owns no store (state arrives on
 * the goal projection), emits no cordis events, and holds no cross-plugin
 * mutable state.
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
