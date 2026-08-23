/** Canonical built-process, public mock, connector, and Dashboard carrier adapters. */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  AbstractApiClient,
  type IApiClient,
} from '@harness-desktop/dsh-host-apiproxy/client'
import type {
  HistoryEntry,
  RpcResponse,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@harness-desktop/dsh-host-apiproxy/api'
import {
  createRuntimeConnector,
  type SessionId,
} from '@harness-desktop/dsh-host-local-runtime'
import { startMockLlmServer } from '@harness-desktop/dsh-llm-mock-server'
import type {
  CrossClientFixtureDependencies,
  CrossClientRuntimeExit,
  CrossClientStateClient,
} from './cross-client-fixture.ts'

class DefaultAdapterError extends Error {}
class ProcessTimeoutError extends Error {}

class CookieApiClient extends AbstractApiClient {
  #cookie: string

  constructor(private readonly origin: string, cookie: string) {
    super()
    this.#cookie = cookie
  }

  protected override resolveBase(): string {
    return this.origin
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    if (input.origin !== this.origin) throw new DefaultAdapterError()
    const headers = new Headers(init?.headers)
    headers.set('cookie', this.#cookie)
    headers.set('origin', this.origin)
    return fetch(input, { ...init, headers })
  }

  close(): void {
    this.#cookie = ''
  }
}

function unwrap<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new DefaultAdapterError()
  return response.result.value
}

class DashboardStateClient implements CrossClientStateClient {
  constructor(private readonly client: IApiClient & { close(): void }) {}

  async createWorkspace(path: string): Promise<WorkspaceView> {
    return unwrap(await this.client.workspace.create({ path })).workspace
  }

  async createSession(workspaceId: WorkspaceId): Promise<SessionId> {
    return unwrap(await this.client.sessions.create({ workspaceId, agentPreset: 'standard' })).sessionId
  }

  async readWorkspaces(): Promise<readonly WorkspaceView[]> {
    return unwrap(await this.client.workspace.list({})).items
  }

  async readSessions(): Promise<readonly SessionSummary[]> {
    return unwrap(await this.client.sessions.list({})).items
  }

  async readHistory(sessionId: SessionId): Promise<readonly HistoryEntry[]> {
    return unwrap(await this.client.sessions.history({ sessionId })).events
  }

  async prompt(sessionId: SessionId, text: string): Promise<void> {
    unwrap(await this.client.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }))
  }

  close(): Promise<void> {
    this.client.close()
    return Promise.resolve()
  }
}

function waitForChild(child: ChildProcess): Promise<CrossClientRuntimeExit> {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ exitCode: child.exitCode, signal: child.signalCode })
      return
    }
    child.once('error', rejectExit)
    child.once('exit', (exitCode, signal) => {
      resolveExit({ exitCode, signal })
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => { rejectTimeout(new ProcessTimeoutError()) }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolveTimeout(value) },
      (error: unknown) => {
        clearTimeout(timer)
        rejectTimeout(error instanceof Error ? error : new DefaultAdapterError())
      },
    )
  })
}

function runtimeBin(): string {
  const manifest = createRequire(import.meta.url).resolve('@harness-desktop/dsh-host-local-runtime/package.json')
  const packageRoot = dirname(manifest)
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly bin?: Record<string, unknown> }
  const declaration = parsed.bin?.['harness-runtime']
  if (typeof declaration !== 'string' || declaration.length === 0) throw new DefaultAdapterError()
  const entry = resolve(packageRoot, declaration)
  const fromPackage = relative(packageRoot, entry)
  if (fromPackage === '' || fromPackage.startsWith('..') || isAbsolute(fromPackage)) {
    throw new DefaultAdapterError()
  }
  return entry
}

/**
 * Build a non-extending environment for the canonical Runtime child.
 * @param platformHome - isolated platform home and temporary-directory owner.
 * @returns system executable paths plus isolated temporary directories only.
 */
export function createIsolatedSystemEnvironment(platformHome: string): NodeJS.ProcessEnv {
  const temporary = join(platformHome, 'tmp')
  if (process.platform !== 'win32') {
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: temporary,
    }
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return {
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

/** Canonical adapters used when focused host tests do not inject replacements. */
export const defaultCrossClientDependencies: CrossClientFixtureDependencies = {
  fileSystem: {
    mkdtemp,
    mkdir: path => mkdir(path, { recursive: true }).then(() => {}),
    writeFile: (path, data) => writeFile(path, data),
    remove: path => rm(path, { recursive: true, force: true }),
  },
  mockServer: {
    start: input => startMockLlmServer({ ...input, host: '127.0.0.1', port: 0 }),
  },
  runtimeProcess: {
    start(input) {
      const child = spawn(process.execPath, [runtimeBin()], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      })
      const exit = waitForChild(child)
      return Promise.resolve({
        endInput: () => { child.stdin.end() },
        waitForExit: timeoutMs => withTimeout(exit, timeoutMs),
        forceKill: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          return Promise.resolve()
        },
      })
    },
  },
  runtimeHealth: {
    connect: input => createRuntimeConnector({
      input: { env: { HARNESS_HOME: input.home }, homeDir: input.platformHome },
    }).connect({ start: input.start }),
  },
  dashboardApi: {
    async connect(runtime) {
      const dashboard = await runtime.attachDashboard()
      try {
        const navigation = await dashboard.createBrowserHandoff()
        const exchanged = await fetch(`${navigation.origin}/_harness/handoff`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
          body: new URLSearchParams({ handoff: navigation.handoff.id }),
        })
        const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
        if (exchanged.status !== 303 || cookie === undefined) throw new DefaultAdapterError()
        const client = new CookieApiClient(navigation.origin, cookie)
        return { api: new DashboardStateClient(client), dashboard }
      } catch (_handoffFailure) {
        await dashboard.close().catch(() => {})
        throw new DefaultAdapterError()
      }
    },
  },
  delay: milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)),
}

/**
 * Select injected host dependencies or the canonical built-process adapters.
 * @param dependencies - optional complete injected dependency set.
 * @returns the supplied set or the canonical defaults.
 */
export function resolveCrossClientDependencies(
  dependencies: CrossClientFixtureDependencies | undefined,
): CrossClientFixtureDependencies {
  return dependencies ?? defaultCrossClientDependencies
}
