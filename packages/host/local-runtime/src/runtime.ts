/** Canonical local Runtime composition, ownership accounting, and ordered teardown. */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@harness-desktop/cordis'
import type { Branded } from '@harness-desktop/dsh-brand'
import type { WebServer } from '@harness-desktop/dsh-host-webserver'
import type { HarnessHomeProvider } from './harness-home-provider.ts'
import { mountPrivateRuntimeControl } from './runtime-control.ts'
import {
  redactRuntimeStatus,
  removePrivateEndpointRecord,
  writePrivateEndpointRecord,
  type RedactedRuntimeStatus,
  type RuntimeId,
} from './endpoint-record.ts'
import { acquireRuntimeLock, type RuntimeLock } from './instance-lock.ts'
import { IdleLifecycle } from './idle-lifecycle.ts'

/** Opaque attached-client identity, supplied by the future Runtime connection layer. */
export type RuntimeClientId = Branded<'RuntimeClientId'>

/** Opaque session identity for Runtime-owned agent work. */
export type SessionId = Branded<'SessionId'>

/** Identity of one active Runtime work reservation. */
export type RuntimeWorkLeaseId = Branded<'RuntimeWorkLeaseId'>

/** Opaque accounting lease that keeps one Runtime agent operation active. */
export interface RuntimeWorkLease {
  readonly id: RuntimeWorkLeaseId
  readonly session: SessionId
}

/** Identity of one explicit background retention lease. */
export type BackgroundLeaseId = Branded<'BackgroundLeaseId'>

/** Explicit owner retention lease; it does not grant endpoint-token access. */
export interface BackgroundLease {
  readonly id: BackgroundLeaseId
}

/** Token-free acknowledgement that one client is attached to this process. */
export interface RuntimeAttachment {}

/** Existing composition callback owned by the application assembly. */
export type RuntimeBoot = (harnessHome: HarnessHomeProvider) => Promise<Context>

/** Inputs for one Runtime process owner. */
export interface StartRuntimeConfig {
  /** One already-resolved writable home shared with every composed writer. */
  readonly harnessHome: HarnessHomeProvider
  /** Existing application composition that mounts one WebServer and durable services. */
  readonly boot: RuntimeBoot
  /** Idle duration selected by the application composition. */
  readonly idleTimeoutMs: number
  /** Schedule one idle shutdown callback; injectable for lifecycle tests. */
  readonly scheduleIdle?: (callback: () => Promise<void>, timeoutMs: number) => ReturnType<typeof setTimeout>
  /** Cancel one scheduled idle callback; injectable for lifecycle tests. */
  readonly cancelIdle?: (handle: ReturnType<typeof setTimeout>) => void
  /** Flush composed durable providers before endpoint retirement. */
  readonly flush?: (ctx: Context) => Promise<void>
  /** Mount private native control and authenticated Dashboard routes before endpoint publication. */
  readonly mountPrivateControl?: boolean
  /** Native bootstrap dispatcher retained by the Runtime process. */
  readonly openBootstrap?: (url: string) => Promise<void>
}

/** Inputs for the shipped base-and-Web Runtime composition. */
export interface CanonicalRuntimeConfig extends Omit<StartRuntimeConfig, 'boot' | 'mountPrivateControl'> {}

/** Runtime process handle kept behind the future connection and control layers. */
export interface RuntimeHandle {
  /** @returns token-free Runtime lifecycle status. */
  readonly status: () => RedactedRuntimeStatus
  /** @param client - client establishing one actual attachment. @returns an attachment acknowledgement. */
  attachClient(client: RuntimeClientId): Promise<RuntimeAttachment>
  /** @param client - attached client releasing its one attachment. */
  releaseClient(client: RuntimeClientId): Promise<void>
  /** @param session - session whose agent operation begins. @returns one active work lease. */
  beginAgentWork(session: SessionId): Promise<RuntimeWorkLease>
  /** @param lease - active agent work lease to settle. */
  endAgentWork(lease: RuntimeWorkLease): Promise<void>
  /** @param owner - client requesting explicit background retention. @returns one background lease. */
  acquireBackgroundLease(owner: RuntimeClientId): Promise<BackgroundLease>
  /** @param lease - explicit background lease to release. */
  releaseBackgroundLease(lease: BackgroundLease): Promise<void>
  /** Flush, retire the endpoint, release ownership, and dispose the Cordis root once. */
  dispose(): Promise<void>
}

/**
 * Acquire one home lock, boot exactly one supplied composition, publish its
 * healthy loopback endpoint, and account for its retained users.
 * @param config - resolved-home composition and lifecycle dependencies.
 * @returns the owner-local Runtime handle; endpoint discovery stays private.
 */
export async function startRuntime(config: StartRuntimeConfig): Promise<RuntimeHandle> {
  const acquisition = await acquireRuntimeLock(config.harnessHome.home)
  if (acquisition.kind !== 'acquired') throw ownershipError(acquisition)
  let ctx: Context | undefined
  let runtimeId: RuntimeId | undefined
  try {
    ctx = await config.boot(config.harnessHome)
    const webServer = ctx.get('webServer') as WebServer | undefined
    if (webServer === undefined || webServer.host !== '127.0.0.1' || !Number.isSafeInteger(webServer.port) || webServer.port < 1) {
      throw new Error('host-local-runtime: composition must expose one healthy 127.0.0.1 WebServer with an OS-assigned port')
    }
    runtimeId = randomId('RuntimeId')
    const record = {
      protocolVersion: 1 as const,
      runtimeId,
      port: webServer.port,
      process: acquisition.lock.process,
      accessToken: randomBytes(32).toString('base64url'),
    }
    if (config.mountPrivateControl === true) {
      const connectionModule = await import(pathToFileURL(createRequire(import.meta.url).resolve('@harness-desktop/dsh-client-connection')).href) as {
        apply: (
          context: Context,
          config: { trustedHosts: readonly string[] },
          authentication: { authorize(request: unknown): boolean },
        ) => void
      }
      mountPrivateRuntimeControl(ctx, {
        accessToken: record.accessToken,
        origin: `http://127.0.0.1:${String(record.port)}`,
        bootstrapParent: config.harnessHome.path('runtime-bootstrap'),
        openBootstrap: config.openBootstrap ?? (async () => {}),
        mountAuthenticatedDashboard(auth) {
          connectionModule.apply(ctx, { trustedHosts: ['127.0.0.1'] }, {
            authorize: request => auth.authorizeDashboard(request as { headers: Headers }),
          })
        },
      })
    }
    await writePrivateEndpointRecord(config.harnessHome.home, record)
    return createRuntimeHandle(config, acquisition.lock, ctx, record)
  } catch (error) {
    const cleanup = await cleanupFailedStart(config, acquisition.lock, ctx, runtimeId)
    if (cleanup !== undefined) throw new AggregateError([error, cleanup], 'host-local-runtime: Runtime startup and cleanup both failed')
    throw error
  }
}

/**
 * Start the one shipped base-plus-Web composition with private local control.
 * @param config - resolved Runtime ownership and idle-lifecycle inputs.
 * @returns the canonical local Runtime owner.
 */
export async function startCanonicalRuntime(config: CanonicalRuntimeConfig): Promise<RuntimeHandle> {
  return startRuntime({ ...config, mountPrivateControl: true, boot: bootCanonicalComposition })
}

/** Boot the shipped base and Web patch layers over the package-owned empty root. */
async function bootCanonicalComposition(harnessHome: HarnessHomeProvider): Promise<Context> {
  const require = createRequire(import.meta.url)
  const appBoot = await import(pathToFileURL(require.resolve('@harness-desktop/dsh-app-boot')).href) as {
    boot: (
      binName: string,
      configPath: string,
      patches: unknown[],
      prepare: (ctx: Context) => void,
      bareModuleBaseUrl: undefined,
      provider: HarnessHomeProvider,
    ) => Promise<Context>
    loadOverlayPatches: (binName: string, path: string) => unknown[]
  }
  const cmdline = await import(pathToFileURL(require.resolve('@harness-desktop/dsh-cmdline')).href) as {
    provideCmdline: (ctx: Context, host: { args: readonly string[]; exit: (code: number) => void }) => void
  }
  const baseRequire = createRequire(require.resolve('@harness-desktop/dsh-base/package.json'))
  const webRequire = createRequire(require.resolve('@harness-desktop/dsh-web-app/package.json'))
  const patches = [
    ...resolvePatchModules(
      appBoot.loadOverlayPatches('harness-runtime', require.resolve('@harness-desktop/dsh-base/cordis.patch.yml')),
      baseRequire,
    ),
    ...resolvePatchModules(
      appBoot.loadOverlayPatches('harness-runtime', require.resolve('@harness-desktop/dsh-web-app/cordis.patch.yml')),
      webRequire,
    ),
  ]
  return appBoot.boot('harness-runtime', fileURLToPath(new URL('../runtime.cordis.yml', import.meta.url)), patches, (ctx) => {
    cmdline.provideCmdline(ctx, { args: [], exit: () => {} })
  }, undefined, harnessHome)
}

/** Resolve shipped bundle entry modules from the bundle that declares each dependency. */
function resolvePatchModules(patches: readonly unknown[], require: NodeRequire): unknown[] {
  return structuredClone(patches).map((patch) => {
    if (typeof patch !== 'object' || patch === null || !('insert' in patch) || !Array.isArray(patch.insert)) return patch
    return {
      ...patch,
      insert: patch.insert.map((entry) => {
        if (typeof entry !== 'object' || entry === null || typeof entry.name !== 'string' || entry.name.startsWith('cordis:')) return entry
        return { ...entry, name: pathToFileURL(require.resolve(entry.name)).href }
      }),
    }
  })
}

/** Build the local handle after the endpoint is durably visible to attachers. */
function createRuntimeHandle(
  config: StartRuntimeConfig,
  lock: RuntimeLock,
  ctx: Context,
  record: { readonly runtimeId: RuntimeId; readonly port: number },
): RuntimeHandle {
  const clients = new Set<RuntimeClientId>()
  const work = new Map<RuntimeWorkLeaseId, SessionId>()
  const backgrounds = new Set<BackgroundLeaseId>()
  let state: RedactedRuntimeStatus['state'] = 'running'
  let disposal: Promise<void> | undefined
  const lifecycle = new IdleLifecycle({
    timeoutMs: config.idleTimeoutMs,
    schedule: config.scheduleIdle ?? ((callback, timeoutMs) => setTimeout(() => { void callback() }, timeoutMs)),
    cancel: config.cancelIdle ?? clearTimeout,
    onIdle: async () => {
      if (clients.size === 0 && work.size === 0 && backgrounds.size === 0) await dispose()
    },
  })
  const reconcile = (): void => lifecycle.reconcile(clients.size === 0 && work.size === 0 && backgrounds.size === 0 && state === 'running')
  const dispose = async (): Promise<void> => {
    if (disposal !== undefined) return disposal
    state = 'stopping'
    lifecycle.cancel()
    disposal = (async () => {
      await config.flush?.(ctx)
      await removePrivateEndpointRecord(config.harnessHome.home, record.runtimeId)
      await lock.release()
      await ctx.fiber.dispose()
    })()
    return disposal
  }
  const handle: RuntimeHandle = {
    status: () => redactRuntimeStatus({ ...record, protocolVersion: 1, process: lock.process, accessToken: '' }, state, backgrounds.size),
    async attachClient(client) {
      ensureRunning(state)
      clients.add(client)
      reconcile()
      return Object.freeze({})
    },
    async releaseClient(client) {
      clients.delete(client)
      reconcile()
    },
    async beginAgentWork(session) {
      ensureRunning(state)
      const id = randomId('RuntimeWorkLeaseId')
      work.set(id, session)
      reconcile()
      return Object.freeze({ id, session })
    },
    async endAgentWork(lease) {
      work.delete(lease.id)
      reconcile()
    },
    async acquireBackgroundLease(_owner) {
      ensureRunning(state)
      const id = randomId('BackgroundLeaseId')
      backgrounds.add(id)
      reconcile()
      return Object.freeze({ id })
    },
    async releaseBackgroundLease(lease) {
      backgrounds.delete(lease.id)
      reconcile()
    },
    dispose,
  }
  reconcile()
  return Object.freeze(handle)
}

/** Remove every startup-owned resource while preserving the original failure. */
async function cleanupFailedStart(
  config: StartRuntimeConfig,
  lock: RuntimeLock,
  ctx: Context | undefined,
  runtimeId: RuntimeId | undefined,
): Promise<unknown | undefined> {
  try {
    if (runtimeId !== undefined) await removePrivateEndpointRecord(config.harnessHome.home, runtimeId)
    await ctx?.fiber.dispose()
    await lock.release()
    return undefined
  } catch (error) {
    return error
  }
}

/** Turn a non-owner lock result into a redacted caller diagnostic. */
function ownershipError(result: Exclude<Awaited<ReturnType<typeof acquireRuntimeLock>>, { readonly kind: 'acquired' }>): Error {
  if (result.kind === 'owned-by-live-runtime') return new Error('host-local-runtime: a live Runtime already owns this Harness home')
  return new Error('host-local-runtime: Runtime ownership could not be verified')
}

/** Reject operations once ordered shutdown has begun. */
function ensureRunning(state: RedactedRuntimeStatus['state']): void {
  if (state !== 'running') throw new Error('host-local-runtime: Runtime is stopping')
}

/** Create a high-entropy opaque branded identifier without exposing endpoint credentials. */
function randomId<T extends string>(_brand: T): Branded<T> {
  return randomBytes(24).toString('base64url') as Branded<T>
}
