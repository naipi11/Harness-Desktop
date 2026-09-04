/**
 * Package-owned invariant companion for `@harness-desktop/dsh-client-web`.
 * @module @harness-desktop/dsh-client-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@harness-desktop/cordis'
import type { InvariantInstaller } from '@harness-desktop/dsh-invariants'

const PACKAGE_NAME = '@harness-desktop/dsh-client-web'

/** Cordis companion plugin name. */
export const name = 'client-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: workbench focus and panel selection are browser-local
 * React state, while its Session, Workspace, deliverables, and Runtime-control
 * relationships cross the authenticated browser carrier. Built AppWebEntry
 * e2e and the real Runtime process suite assert those acceptance paths.
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
