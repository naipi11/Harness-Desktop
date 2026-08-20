/** Shipped private assembly for native Runtime control and Dashboard bootstrap ownership. */

import type { Context } from '@harness-desktop/cordis'
import {
  createBootstrapCleanup,
  createBootstrapDocument,
  LocalDashboardAuth,
  type BootstrapCleanupOptions,
} from './auth.ts'
import { mountLocalControlRoutes } from './control-routes.ts'

type BootstrapCleanup = ReturnType<typeof createBootstrapCleanup>

/** Runtime-private handle that owns each local browser bootstrap until settlement. */
export interface PrivateRuntimeControl {
  /** Create, dispatch, and retain one clean local bootstrap document. */
  openDashboard(): Promise<void>
  /** Remove every bootstrap document still owned by this Runtime control assembly. */
  close(): Promise<void>
}

/** Inputs known only to the Runtime process and its native launcher. */
export interface PrivateRuntimeControlOptions {
  /** Endpoint token retained in the private Runtime endpoint record. */
  readonly accessToken: string
  /** Exact loopback Runtime origin. */
  readonly origin: string
  /** Parent where each launcher-owned private bootstrap directory is created. */
  readonly bootstrapParent: string
  /** Native dispatcher receiving only the clean local file URL. */
  readonly openBootstrap: (url: string) => Promise<void>
  /** Injectable clock for Runtime-local expiry tests. */
  readonly now?: () => number
  /** Injectable bootstrap cleanup dependencies. */
  readonly cleanup?: BootstrapCleanupOptions
  /** Mounts the existing browser API and event transport with the session validator. */
  readonly mountAuthenticatedDashboard: (auth: LocalDashboardAuth) => void
}

/**
 * Mount the private native-control and browser-authentication routes into an
 * already assembled Runtime. The package build ships this module for the
 * Runtime process, while package exports keep endpoint-token APIs private.
 * @param ctx - Runtime composition context injected with WebServer.
 * @param options - Runtime-private endpoint and launcher dependencies.
 * @returns the launcher owner for Dashboard bootstrap documents.
 */
export function mountPrivateRuntimeControl(ctx: Context, options: PrivateRuntimeControlOptions): PrivateRuntimeControl {
  const auth = new LocalDashboardAuth({
    accessToken: options.accessToken,
    origin: options.origin,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const pending = new Map<string, BootstrapCleanup>()
  const settle = async (id: string): Promise<void> => {
    const cleanup = pending.get(id)
    if (cleanup === undefined) return
    pending.delete(id)
    await cleanup.exchangeSettled()
  }
  const control: PrivateRuntimeControl = {
    async openDashboard() {
      const handoff = auth.mintBrowserHandoff()
      const bootstrap = await createBootstrapDocument({
        parent: options.bootstrapParent,
        origin: options.origin,
        handoff,
      })
      const cleanup = createBootstrapCleanup(bootstrap.path, handoff.expiresAt, options.cleanup)
      pending.set(handoff.id, cleanup)
      try {
        await options.openBootstrap(bootstrap.url)
      } catch (error) {
        pending.delete(handoff.id)
        try {
          await cleanup.dispatchFailed()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'host-local-runtime: bootstrap dispatch and cleanup both failed')
        }
        throw error
      }
    },
    async close() {
      const cleanups = [...pending.values()]
      pending.clear()
      await Promise.all(cleanups.map(cleanup => cleanup.exchangeSettled()))
    },
  }
  mountLocalControlRoutes(ctx, {
    auth,
    mountAuthenticatedDashboard: options.mountAuthenticatedDashboard,
    onHandoffSettled: settle,
  })
  ctx.effect(() => () => control.close(), 'host-local-runtime: bootstrap documents')
  return control
}
