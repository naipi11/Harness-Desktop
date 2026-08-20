/** Package-owned invariant companion. @module @harness-desktop/dsh-host-local-runtime/invariant */

import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-host-local-runtime'

/** Cordis companion plugin name. */
export const name = 'host-local-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: ownership records and private browser sessions have no model-visible or durable event relation. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
