/** Package-owned invariant companion for `@harness-desktop/dsh-update-policy`. */

/* jscpd:ignore-start */
import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-update-policy'

/** Cordis companion plugin name. */
export const name = 'update-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this pure verifier owns no event stream or mutable runtime data; unit tests enforce its rejection rules. */
const install: InvariantInstaller = () => {}

/**
 * Registers this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
