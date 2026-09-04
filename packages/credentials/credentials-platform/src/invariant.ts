/**
 * Package-owned invariant companion for `@harness-desktop/dsh-credentials-platform`.
 * @module @harness-desktop/dsh-credentials-platform/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-credentials-platform'

/** Cordis companion plugin name. */
export const name = 'credentials-platform-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion (`dsh-credentials/invariant`) owns the
 * `credentials/updated` lifecycle contract; this provider's adapter/metadata layering is
 * asynchronous I/O pinned by its unit suite.
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
