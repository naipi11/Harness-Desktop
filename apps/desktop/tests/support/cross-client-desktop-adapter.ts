/** App-owned real-Electron adapter for the built cross-client Runtime acceptance lane. */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  type Page,
} from '@playwright/test'
import type {
  CrossClientAppAdapter,
  CrossClientAppContext,
  CrossClientAppHandle,
} from '@harness-desktop/dsh-cross-client-runtime'

const MAIN_ENTRY = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const FIRST_WINDOW_TIMEOUT_MS = 30_000
const GRACEFUL_CLOSE_TIMEOUT_MS = 15_000
const FORCE_KILL_TIMEOUT_MS = 5_000

/** Minimal owned child face needed to prove an Electron close reaches process quiescence. */
interface DesktopChildProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
  once(event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this
}

/** Electron application operations retained by the adapter rather than exposed to fixture callers. */
interface DesktopApplication {
  close(): Promise<void>
  firstWindow(options?: { readonly timeout?: number }): Promise<Page>
  process(): DesktopChildProcess
}

interface DesktopLaunchOptions {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeout: number
}

interface DesktopAdapterDependencies {
  requireMainEntry(): Promise<void>
  launch(options: DesktopLaunchOptions): Promise<DesktopApplication>
  gracefulCloseTimeoutMs: number
  forceKillTimeoutMs: number
}

/** Token-free probe for the current real Desktop window and its exact owned Electron child. */
export interface DesktopDashboardProbe {
  readonly page: Page
  /** Force only this Desktop application's child to exit and wait for that exit. */
  terminateUnexpectedly(): Promise<void>
}

/** Stable public failure for test setup and child-lifecycle errors. */
class CrossClientDesktopAdapterError extends Error {
  constructor(message = 'The built Desktop acceptance adapter failed.') {
    super(message)
    this.name = 'CrossClientDesktopAdapterError'
  }
}

/** Build a non-extending environment for the Desktop child without fixture credentials or legacy homes. */
function isolatedDesktopEnvironment(context: CrossClientAppContext): NodeJS.ProcessEnv {
  const temporary = join(context.platformHome, 'tmp')
  const roots: NodeJS.ProcessEnv = {
    HARNESS_HOME: context.home,
    HOME: context.platformHome,
    USERPROFILE: context.platformHome,
    APPDATA: join(context.platformHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(context.platformHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(context.platformHome, '.config'),
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
  }
  if (process.platform !== 'win32') {
    return { ...roots, PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: temporary }
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return {
    ...roots,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    Path: [
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      systemRoot,
    ].join(';'),
    TEMP: temporary,
    TMP: temporary,
  }
}

/** Remove absent optional environment entries before passing the exact child environment to Playwright. */
function concreteEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ))
}

/** Whether an owned child has already settled, without inspecting process tables or a PID file. */
function hasExited(child: DesktopChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Await the exact owned child instead of treating a kill request as a completed teardown. */
function waitForExit(child: DesktopChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve()
  return new Promise((resolveExit) => {
    child.once('exit', () => { resolveExit() })
  })
}

/** Bound one owned operation without exposing a private child failure in the eventual diagnostic. */
function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolveOperation, rejectOperation) => {
    const timer = setTimeout(() => {
      rejectOperation(new CrossClientDesktopAdapterError('The built Desktop acceptance child did not settle before its deadline.'))
    }, timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolveOperation(value)
      },
      (_operationFailure: unknown) => {
        clearTimeout(timer)
        rejectOperation(new CrossClientDesktopAdapterError())
      },
    )
  })
}

/** Force the exact Playwright-returned Electron child to exit and confirm that it did. */
async function forceKill(child: DesktopChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return
  const exited = waitForExit(child)
  let accepted = false
  try {
    accepted = child.kill('SIGKILL')
  } catch {
    throw new CrossClientDesktopAdapterError()
  }
  if (!accepted && !hasExited(child)) throw new CrossClientDesktopAdapterError()
  try {
    await within(exited, timeoutMs)
  } catch {
    throw new CrossClientDesktopAdapterError()
  }
}

/** Gracefully close an owned app, then force only its child if that close does not reach quiescence. */
async function closeApplication(application: DesktopApplication, dependencies: DesktopAdapterDependencies): Promise<void> {
  const child = application.process()
  const exited = waitForExit(child)
  try {
    await within(Promise.all([application.close(), exited]), dependencies.gracefulCloseTimeoutMs)
  } catch {
    await forceKill(child, dependencies.forceKillTimeoutMs)
  }
}

/** Own one application close flight, retaining a failure for a caller-controlled retry. */
function closeHandle(application: DesktopApplication, dependencies: DesktopAdapterDependencies): () => Promise<void> {
  let closing: Promise<void> | undefined
  let settled = false
  return (): Promise<void> => {
    if (settled) return Promise.resolve()
    if (closing !== undefined) return closing
    closing = closeApplication(application, dependencies).then(
      () => { settled = true },
      (error: unknown) => {
        closing = undefined
        throw error instanceof Error ? error : new CrossClientDesktopAdapterError()
      },
    )
    return closing
  }
}

/** Retry setup rollback once so a transient owned-close failure does not orphan the Electron child. */
async function retryOpenFailureCleanup(close: () => Promise<void>): Promise<Error | undefined> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await close()
      return undefined
    } catch (error) {
      failure = error
    }
  }
  return failure instanceof Error
    ? new Error(failure.message)
    : new CrossClientDesktopAdapterError('Cross-client Desktop cleanup failed.')
}

const DEFAULT_DEPENDENCIES: DesktopAdapterDependencies = {
  requireMainEntry: () => access(MAIN_ENTRY, constants.R_OK),
  launch: async options => electron.launch({
    args: [...options.args],
    cwd: options.cwd,
    env: concreteEnvironment(options.env),
    timeout: options.timeout,
  }),
  gracefulCloseTimeoutMs: GRACEFUL_CLOSE_TIMEOUT_MS,
  forceKillTimeoutMs: FORCE_KILL_TIMEOUT_MS,
}

/**
 * Create the built Desktop adapter for the fixture's caller-owned Electron process.
 * @param dependencies - physical artifact launcher and short close deadlines overridden by focused tests.
 * @returns the fixture adapter and the latest real Desktop window probe.
 */
export function createCrossClientDesktopAdapter(
  dependencies: DesktopAdapterDependencies = DEFAULT_DEPENDENCIES,
): { readonly adapter: CrossClientAppAdapter; readonly latest: () => DesktopDashboardProbe } {
  let latestProbe: DesktopDashboardProbe | undefined
  return {
    latest(): DesktopDashboardProbe {
      if (latestProbe === undefined) throw new CrossClientDesktopAdapterError('No cross-client Desktop is open.')
      return latestProbe
    },
    adapter: {
      async open(context: CrossClientAppContext): Promise<CrossClientAppHandle> {
        try {
          await dependencies.requireMainEntry()
        } catch {
          throw new CrossClientDesktopAdapterError('built Desktop acceptance requires apps/desktop/out/main/index.js; run pnpm run build first')
        }

        let application: DesktopApplication | undefined
        let close: (() => Promise<void>) | undefined
        try {
          application = await dependencies.launch({
            args: [MAIN_ENTRY, '--lang=en-US'],
            cwd: context.workspace,
            env: isolatedDesktopEnvironment(context),
            timeout: FIRST_WINDOW_TIMEOUT_MS,
          })
          close = closeHandle(application, dependencies)
          const page = await application.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })
          const child = application.process()
          latestProbe = {
            page,
            terminateUnexpectedly: () => forceKill(child, dependencies.forceKillTimeoutMs),
          }
          return { close }
        } catch {
          const openFailure = new CrossClientDesktopAdapterError()
          const cleanupFailure = close === undefined ? undefined : await retryOpenFailureCleanup(close)
          if (cleanupFailure !== undefined) {
            throw new AggregateError(
              [openFailure, cleanupFailure],
              'Cross-client Desktop open and cleanup failed.',
            )
          }
          throw openFailure
        }
      },
    },
  }
}
