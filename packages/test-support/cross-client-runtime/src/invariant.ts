/**
 * Package-owned invariant companion for `@harness-desktop/dsh-cross-client-runtime`.
 * @module @harness-desktop/dsh-cross-client-runtime/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-cross-client-runtime'

/** Cordis companion plugin name. */
export const name = 'cross-client-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the fixture owns host-process lifecycle observations,
 * not a Cordis event or mutable-data relationship; host tests enforce its ledger.
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
