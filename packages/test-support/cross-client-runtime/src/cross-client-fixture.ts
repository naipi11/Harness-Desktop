/** Host-only owner for one canonical Runtime, mock provider, and client fixture lifetime. */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HistoryEntry,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@harness-desktop/dsh-host-apiproxy/api'
import {
  RuntimeBusyError,
  type DashboardAttachment,
  type RuntimeStatus,
  type TerminalConnection,
  type TerminalOpenRequest,
} from '@harness-desktop/dsh-host-local-runtime'
import type { SessionId } from '@harness-desktop/dsh-session/types'
import {
  type MockLlmBehavior,
  type MockLlmServerOptions,
} from '@harness-desktop/dsh-llm-mock-server'
import {
  createIsolatedSystemEnvironment,
  resolveCrossClientDependencies,
} from './cross-client-defaults.ts'

const TEST_API_KEY = 'cross-client-runtime-fixture-key'
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_HEALTH_INTERVAL_MS = 25
const DEFAULT_STOP_TIMEOUT_MS = 15_000
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 5_000

/** One created workspace/session pair observed only through supported API types. */
export interface CrossClientObservation {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Token-free lifecycle event for the one Runtime process owned by a fixture. */
export type CrossClientLifecycleEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'health-confirmed' }
  | { readonly kind: 'stopped' }

/** Detached token-free fixture state suitable for lifecycle assertions and test diagnostics. */
export interface CrossClientLifecycleSnapshot {
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'disposing' | 'disposed'
  readonly events: readonly CrossClientLifecycleEvent[]
  readonly observations: readonly CrossClientObservation[]
}

/** Stable process result observed without exposing output or environment values. */
export interface CrossClientRuntimeExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** Owned Runtime process controls required by fixture cleanup. */
export interface CrossClientRuntimeProcessHandle {
  /** Close stdin to request the canonical test-mode lifetime shutdown. */
  endInput(): void
  /** @param timeoutMs - upper bound for observing exit. @returns redacted process settlement. */
  waitForExit(timeoutMs: number): Promise<CrossClientRuntimeExit>
  /** Force-stop the exact owned process after graceful shutdown exceeds its bound. */
  forceKill(): Promise<void>
}

/** Input for starting the canonical built Runtime process. */
export interface CrossClientRuntimeProcessInput {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** Injectable process owner; the default launches the declared built Runtime bin under current Node. */
export interface CrossClientRuntimeProcessAdapter {
  /** @param input - isolated cwd and environment. @returns one owned process handle. */
  start(input: CrossClientRuntimeProcessInput): Promise<CrossClientRuntimeProcessHandle>
}

/** Narrow Runtime client face used by the fixture and implemented by the public local-Runtime client. */
export interface CrossClientRuntimeClient {
  /** @returns redacted public Runtime status. */
  status(): Promise<RuntimeStatus>
  /** @param request - public terminal attachment request. @returns owned terminal attachment. */
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  /** @returns owned Dashboard attachment. */
  attachDashboard(): Promise<DashboardAttachment>
  /** Release the base native client attachment. */
  close(): Promise<void>
}

/** No-start health probe inputs; endpoint discovery remains private to local-runtime. */
export interface CrossClientRuntimeHealthInput {
  readonly home: string
  readonly platformHome: string
  readonly start: false
}

/** Injectable public-health connector. */
export interface CrossClientRuntimeHealthAdapter {
  /** @param input - isolated roots and the required no-start mode. @returns an attached Runtime client. */
  connect(input: CrossClientRuntimeHealthInput): Promise<CrossClientRuntimeClient>
}

/** Supported API operations used to verify shared durable state. */
export interface CrossClientStateClient {
  /** @param path - existing workspace directory. @returns adopted workspace. */
  createWorkspace(path: string): Promise<WorkspaceView>
  /** @param workspaceId - owning workspace. @returns created session identity. */
  createSession(workspaceId: WorkspaceId): Promise<SessionId>
  /** @returns current workspace rows. */
  readWorkspaces(): Promise<readonly WorkspaceView[]>
  /** @returns current session rows. */
  readSessions(): Promise<readonly SessionSummary[]>
  /** @param sessionId - session to page from its tail. @returns durable history entries. */
  readHistory(sessionId: SessionId): Promise<readonly HistoryEntry[]>
  /** @param sessionId - target session. @param text - human text submitted through the API. */
  prompt(sessionId: SessionId, text: string): Promise<void>
  /** Forget carrier authentication retained by this client. */
  close(): Promise<void>
}

/** Authenticated API carrier plus the Dashboard attachment that minted it. */
export interface CrossClientDashboardApiHandle {
  readonly api: CrossClientStateClient
  readonly dashboard: DashboardAttachment
  /** @param text - candidate public output. @returns whether it contains an exact privately retained value. */
  readonly containsPrivateValue: (text: string) => boolean
}

/** Injectable Dashboard handoff and authenticated API carrier owner. */
export interface CrossClientDashboardApiAdapter {
  /** @param runtime - healthy base client. @returns API and Dashboard handles owned by the fixture. */
  connect(runtime: CrossClientRuntimeClient): Promise<CrossClientDashboardApiHandle>
}

/** File operations used to create and remove only the fixture's explicit temporary root. */
export interface CrossClientFileSystemAdapter {
  /** @param prefix - temporary path prefix. @returns created unique directory. */
  mkdtemp(prefix: string): Promise<string>
  /** @param path - directory path to create recursively. */
  mkdir(path: string): Promise<void>
  /** @param path - file path. @param data - complete UTF-8 content. */
  writeFile(path: string, data: string): Promise<void>
  /** @param path - exact fixture-owned root to remove recursively. */
  remove(path: string): Promise<void>
}

/** Running mock endpoint; the API key remains fixture-private. */
export interface CrossClientMockServerHandle {
  readonly baseURL: string
  /** Stop accepting requests and close active mock connections. */
  close(): Promise<void>
}

/** Mock startup input including the fixture-private API key. */
export interface CrossClientMockServerInput extends Omit<CrossClientMockOptions, 'sequence'> {
  readonly apiKey: string
  readonly sequence: readonly MockLlmBehavior[]
}

/** Injectable public mock-server launcher. */
export interface CrossClientMockServerAdapter {
  /** @param input - deterministic provider behavior. @returns running public mock handle. */
  start(input: CrossClientMockServerInput): Promise<CrossClientMockServerHandle>
}

/** Node-only app context without Runtime or provider credentials. */
export interface CrossClientAppContext {
  readonly home: string
  readonly platformHome: string
  readonly workspace: string
}

/** One app process or browser/Electron test handle owned by the fixture. */
export interface CrossClientAppHandle {
  /** Release only this app-test handle. */
  close(): Promise<void>
}

/** Node-only Web or Desktop adapter implemented by an app test module. */
export interface CrossClientAppAdapter {
  /** @param context - isolated non-secret roots. @returns one owned app handle. */
  open(context: CrossClientAppContext): Promise<CrossClientAppHandle>
}

/** Redacted CLI process result. */
export interface CrossClientCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Node-only CLI adapter implemented by the CLI test module. */
export interface CrossClientCliAdapter {
  /** @param args - product arguments. @param context - isolated non-secret roots. @returns captured result. */
  run(args: readonly string[], context: CrossClientAppContext): Promise<CrossClientCliResult>
}

/** App-specific adapters supplied by phase-B acceptance modules. */
export interface CrossClientAppAdapters {
  readonly cli?: CrossClientCliAdapter
  readonly web?: CrossClientAppAdapter
  readonly desktop?: CrossClientAppAdapter
}

/** Host dependency injection points used by focused lifecycle tests. */
export interface CrossClientFixtureDependencies {
  readonly fileSystem: CrossClientFileSystemAdapter
  readonly mockServer: CrossClientMockServerAdapter
  readonly runtimeProcess: CrossClientRuntimeProcessAdapter
  readonly runtimeHealth: CrossClientRuntimeHealthAdapter
  readonly dashboardApi: CrossClientDashboardApiAdapter
  /** @param milliseconds - retry delay. */
  delay(milliseconds: number): Promise<void>
}

/** Public mock configuration; network identity and credentials stay fixture-owned. */
export type CrossClientMockOptions = Omit<
  MockLlmServerOptions,
  'apiKey' | 'host' | 'port' | 'sequence'
> & { readonly sequence?: readonly MockLlmBehavior[] }

/** Fixture construction options. */
export interface CrossClientFixtureOptions {
  /** Parent for the single owned temporary root; defaults to the platform temp directory. */
  readonly temporaryParent?: string
  /** Public mock behavior; defaults to repeatable success. */
  readonly mock?: CrossClientMockOptions
  /** Bound for public no-start health retries. */
  readonly healthTimeoutMs?: number
  /** Delay between public no-start health retries. */
  readonly healthIntervalMs?: number
  /** Graceful stdin-EOF Runtime shutdown bound. */
  readonly stopTimeoutMs?: number
  /** Forced Runtime shutdown observation bound. */
  readonly forceStopTimeoutMs?: number
  /** App-specific Node adapters; no browser or Electron dependency enters this package. */
  readonly adapters?: CrossClientAppAdapters
  /** Complete host dependency override used by focused fixture tests. */
  readonly dependencies?: CrossClientFixtureDependencies
}

/** Fixture method called after cleanup begins. */
export class CrossClientFixtureClosedError extends Error {
  constructor() {
    super('The cross-client fixture is not accepting operations.')
    this.name = 'CrossClientFixtureClosedError'
  }
}

/** App operation whose phase-B adapter was not supplied. */
export class CrossClientFixtureAdapterError extends Error {
  constructor() {
    super('The requested cross-client app adapter is not configured.')
    this.name = 'CrossClientFixtureAdapterError'
  }
}

/** Bounded, secret-free fixture setup failure. */
export class CrossClientFixtureSetupError extends Error {
  constructor() {
    super('The cross-client fixture could not start its isolated Runtime.')
    this.name = 'CrossClientFixtureSetupError'
  }
}

/** Bounded, secret-free failure from an injected or authenticated operation. */
export class CrossClientFixtureOperationError extends Error {
  constructor() {
    super('The cross-client fixture operation failed.')
    this.name = 'CrossClientFixtureOperationError'
  }
}

/** Public phase-A host fixture shared by later app acceptance tests. */
export interface CrossClientFixture {
  readonly home: string
  readonly platformHome: string
  readonly workspace: string
  readonly observations: readonly CrossClientObservation[]
  /** @param path - existing directory, defaulting to {@link workspace}. @returns the API workspace row. */
  createWorkspace(path?: string): Promise<WorkspaceView>
  /** @param workspaceId - owner, defaulting to the last created fixture workspace. @returns paired observation. */
  createSession(workspaceId?: WorkspaceId): Promise<CrossClientObservation>
  /** @returns workspace rows read through the authenticated API. */
  readWorkspaces(): Promise<readonly WorkspaceView[]>
  /** @returns session rows read through the authenticated API. */
  readSessions(): Promise<readonly SessionSummary[]>
  /** @param sessionId - session to read. @returns durable history through the authenticated API. */
  readHistory(sessionId: SessionId): Promise<readonly HistoryEntry[]>
  /** @param sessionId - target session. @param text - human prompt. */
  prompt(sessionId: SessionId, text: string): Promise<void>
  /** @param request - optional public terminal request; workspace defaults to the fixture workspace. */
  openTerminal(request?: Omit<TerminalOpenRequest, 'workspace'> & { readonly workspace?: string }): Promise<TerminalConnection>
  /**
   * Attempt one initial task against a session already owned by active terminal work.
   * @param sessionId - busy session identity. @param text - blocked contender task.
   * @returns the exact public busy error after verifying its branded session id.
   */
  expectSameSessionBusy(sessionId: SessionId, text?: string): Promise<RuntimeBusyError>
  /** @param args - CLI product arguments. @returns adapter result after secret-output rejection. */
  runCli(args: readonly string[]): Promise<CrossClientCliResult>
  /** @returns injected Web app handle owned by this fixture. */
  openWeb(): Promise<CrossClientAppHandle>
  /** @returns injected Desktop app handle owned by this fixture. */
  openDesktop(): Promise<CrossClientAppHandle>
  /** Close every owned client, then stop the exact Runtime by stdin EOF with a bounded force-kill fallback. */
  stopRuntime(): Promise<void>
  /** @returns a detached token-free lifecycle and observation snapshot. */
  lifecycleSnapshot(): CrossClientLifecycleSnapshot
  /** Close every owned handle, stop the Runtime and mock, then remove only the explicit temporary root. */
  dispose(): Promise<void>
}

/**
 * Require one owned Runtime to pass started, public health, and exactly one stopped event in order.
 * @param snapshot - detached token-free fixture state.
 * @throws Error when the lifecycle ledger is incomplete or duplicated.
 */
export function assertCrossClientLifecycle(snapshot: CrossClientLifecycleSnapshot): void {
  const counts = { started: 0, health: 0, stopped: 0 }
  let stage = 0
  for (const event of snapshot.events) {
    switch (event.kind) {
      case 'started':
        counts.started += 1
        if (stage !== 0) throw new Error('cross-client lifecycle started event is out of order')
        stage = 1
        break
      case 'health-confirmed':
        counts.health += 1
        if (stage !== 1) throw new Error('cross-client lifecycle health-confirmed event is out of order')
        stage = 2
        break
      case 'stopped':
        counts.stopped += 1
        if (stage !== 2) throw new Error('cross-client lifecycle stopped event is out of order')
        stage = 3
        break
    }
  }
  if (counts.started !== 1) throw new Error('cross-client lifecycle requires exactly one started event')
  if (counts.health !== 1) throw new Error('cross-client lifecycle requires exactly one health-confirmed event')
  if (counts.stopped !== 1) throw new Error('cross-client lifecycle requires exactly one stopped event')
}

class FixtureTransportError extends Error {}

class OwnedTerminal implements TerminalConnection {
  private closePromise: Promise<void> | undefined

  constructor(private readonly terminal: TerminalConnection) {}

  events(): AsyncIterable<import('@harness-desktop/dsh-host-local-runtime').TerminalProtocolEvent> {
    return this.terminal.events()
  }

  submit(input: import('@harness-desktop/dsh-host-local-runtime').TerminalInput): Promise<void> {
    return this.terminal.submit(input)
  }

  runControl(command: import('@harness-desktop/dsh-host-local-runtime').TerminalControlCommand): Promise<void> {
    return this.terminal.runControl(command)
  }

  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }> {
    return this.terminal.cancel()
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.terminal.close().catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    }))
  }
}

class OwnedAppHandle implements CrossClientAppHandle {
  private closePromise: Promise<void> | undefined

  constructor(private readonly handle: CrossClientAppHandle) {}

  close(): Promise<void> {
    return (this.closePromise ??= this.handle.close().catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    }))
  }
}

class CrossClientFixtureImpl implements CrossClientFixture {
  private state: CrossClientLifecycleSnapshot['state'] = 'starting'
  private readonly events: CrossClientLifecycleEvent[] = []
  private readonly observationRows: CrossClientObservation[] = []
  private readonly appHandles: OwnedAppHandle[] = []
  private readonly terminals: OwnedTerminal[] = []
  private mock: CrossClientMockServerHandle | undefined
  private process: CrossClientRuntimeProcessHandle | undefined
  private runtime: CrossClientRuntimeClient | undefined
  private readonly runtimeClients = new Set<CrossClientRuntimeClient>()
  private readonly closedOwners = new Set<object>()
  private apiHandle: CrossClientDashboardApiHandle | undefined
  private lastWorkspaceId: WorkspaceId | undefined
  private runtimeStopped = false
  private mockClosed = false
  private rootRemoved = false
  private closeOwnedPromise: Promise<readonly Error[]> | undefined
  private stopPromise: Promise<void> | undefined
  private disposePromise: Promise<void> | undefined
  private admittedOperations = 0
  private readonly admittedWaiters = new Set<() => void>()

  constructor(
    private readonly root: string,
    readonly home: string,
    readonly platformHome: string,
    readonly workspace: string,
    private readonly dependencies: CrossClientFixtureDependencies,
    private readonly options: CrossClientFixtureOptions,
  ) {}

  get observations(): readonly CrossClientObservation[] {
    return this.observationRows.map(row => ({ ...row }))
  }

  async initialize(): Promise<void> {
    const mockOptions = this.options.mock ?? {}
    this.mock = await this.dependencies.mockServer.start({
      ...mockOptions,
      apiKey: TEST_API_KEY,
      sequence: mockOptions.sequence ?? ['success'],
      repeatLast: mockOptions.repeatLast ?? true,
    })
    const env: NodeJS.ProcessEnv = {
      ...createIsolatedSystemEnvironment(this.platformHome),
      HARNESS_HOME: this.home,
      DSH_HOME: join(this.root, 'legacy-home'),
      HOME: this.platformHome,
      USERPROFILE: this.platformHome,
      APPDATA: join(this.platformHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(this.platformHome, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(this.platformHome, '.config'),
      DEEPSEEK_API_KEY: TEST_API_KEY,
      DEEPSEEK_BASE_URL: `${this.mock.baseURL}/v1`,
      DSH_TELEMETRY_DISABLED: '1',
      HARNESS_RUNTIME_TEST_MODE: 'stdin-lifetime',
      FORCE_COLOR: '0',
    }
    this.process = await this.dependencies.runtimeProcess.start({ cwd: this.workspace, env })
    this.events.push({ kind: 'started' })
    this.runtime = await this.waitForHealth()
    this.events.push({ kind: 'health-confirmed' })
    this.apiHandle = await this.dependencies.dashboardApi.connect(this.runtime)
    this.state = 'ready'
  }

  createWorkspace(path = this.workspace): Promise<WorkspaceView> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      try {
        const workspace = await api.createWorkspace(path)
        this.lastWorkspaceId = workspace.workspaceId
        return workspace
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  createSession(workspaceId?: WorkspaceId): Promise<CrossClientObservation> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      const owner = workspaceId ?? this.lastWorkspaceId ?? (await this.createWorkspace()).workspaceId
      try {
        const id = await api.createSession(owner)
        const observation = { workspaceId: owner, sessionId: id }
        this.observationRows.push(observation)
        return { ...observation }
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  readWorkspaces(): Promise<readonly WorkspaceView[]> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      try {
        return await api.readWorkspaces()
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  readSessions(): Promise<readonly SessionSummary[]> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      try {
        return await api.readSessions()
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  readHistory(sessionId: SessionId): Promise<readonly HistoryEntry[]> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      try {
        return await api.readHistory(sessionId)
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  prompt(sessionId: SessionId, text: string): Promise<void> {
    return this.runAdmitted(async () => {
      const api = this.requireApi()
      try {
        await api.prompt(sessionId, text)
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  openTerminal(
    request: Omit<TerminalOpenRequest, 'workspace'> & { readonly workspace?: string } = {},
  ): Promise<TerminalConnection> {
    return this.runAdmitted(async () => {
      const runtime = this.runtime as CrossClientRuntimeClient
      let terminal: OwnedTerminal
      try {
        terminal = new OwnedTerminal(await runtime.openTerminal({
          ...request,
          workspace: request.workspace ?? this.workspace,
        }))
      } catch (error) {
        if (error instanceof RuntimeBusyError) throw error
        throw new CrossClientFixtureOperationError()
      }
      this.terminals.push(terminal)
      if (this.state !== 'ready') {
        await terminal.close().catch(() => {})
        throw new CrossClientFixtureClosedError()
      }
      return terminal
    })
  }

  expectSameSessionBusy(
    sessionId: SessionId,
    text = 'cross-client contender must not run',
  ): Promise<RuntimeBusyError> {
    return this.runAdmitted(async () => {
      const runtime = this.runtime as CrossClientRuntimeClient
      try {
        const terminal = await runtime.openTerminal({ workspace: this.workspace, sessionId, initialTask: text })
        await terminal.close()
      } catch (error) {
        if (error instanceof RuntimeBusyError && error.sessionId === sessionId) return error
        throw new CrossClientFixtureOperationError()
      }
      throw new CrossClientFixtureOperationError()
    })
  }

  runCli(args: readonly string[]): Promise<CrossClientCliResult> {
    return this.runAdmitted(async () => {
      const adapter = this.options.adapters?.cli
      if (adapter === undefined) throw new CrossClientFixtureAdapterError()
      try {
        const result = await adapter.run([...args], this.appContext())
        if (this.cliResultLeaksPrivateValue(result)) throw new CrossClientFixtureOperationError()
        return result
      } catch (error) {
        if (error instanceof CrossClientFixtureOperationError) throw error
        throw new CrossClientFixtureOperationError()
      }
    })
  }

  openWeb(): Promise<CrossClientAppHandle> {
    return this.openApp(this.options.adapters?.web)
  }

  openDesktop(): Promise<CrossClientAppHandle> {
    return this.openApp(this.options.adapters?.desktop)
  }

  stopRuntime(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    if (this.state === 'ready') this.state = 'stopping'
    this.stopPromise = this.stopRuntimeFlight()
    return this.stopPromise
  }

  lifecycleSnapshot(): CrossClientLifecycleSnapshot {
    return {
      state: this.state,
      events: this.events.map(event => ({ ...event })),
      observations: this.observationRows.map(row => ({ ...row })),
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.state = 'disposing'
    this.disposePromise = this.disposeFlight()
    return this.disposePromise
  }

  private async waitForHealth(): Promise<CrossClientRuntimeClient> {
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
    for (;;) {
      let candidate: CrossClientRuntimeClient | undefined
      try {
        candidate = await this.dependencies.runtimeHealth.connect({
          home: this.home,
          platformHome: this.platformHome,
          start: false,
        })
        this.runtimeClients.add(candidate)
        const status = await candidate.status()
        if (status.state === 'running') {
          this.runtime = candidate
          return candidate
        }
      } catch (_readinessFailure) {
        // Public no-start discovery is retried until its fixture-owned deadline.
      }
      if (candidate !== undefined) {
        try {
          await candidate.close()
          this.runtimeClients.delete(candidate)
        } catch (_candidateCloseFailure) {
          // Cleanup retries every retained candidate and reports a stable stage if it still fails.
        }
      }
      if (Date.now() >= deadline) throw new FixtureTransportError()
      await this.dependencies.delay(this.options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS)
    }
  }

  private requireApi(): CrossClientStateClient {
    this.ensureReady()
    const handle = this.apiHandle as CrossClientDashboardApiHandle
    return handle.api
  }

  private ensureReady(): void {
    if (this.state !== 'ready') throw new CrossClientFixtureClosedError()
  }

  private appContext(): CrossClientAppContext {
    return { home: this.home, platformHome: this.platformHome, workspace: this.workspace }
  }

  private cliResultLeaksPrivateValue(result: CrossClientCliResult): boolean {
    const output = `${result.stdout}\n${result.stderr}`
    const folded = output.toLowerCase()
    if ([this.home, this.platformHome, TEST_API_KEY].some(value => folded.includes(value.toLowerCase()))) return true
    if (this.apiHandle?.containsPrivateValue(output) === true) return true
    return /\b(?:accesstoken|bearer|authorization|auth|cookie|handoff)\b/iu.test(output)
  }

  private async runAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.admitOperation()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private admitOperation(): () => void {
    this.ensureReady()
    this.admittedOperations += 1
    return () => {
      this.admittedOperations -= 1
      if (this.admittedOperations !== 0) return
      for (const resolveWaiter of this.admittedWaiters) resolveWaiter()
      this.admittedWaiters.clear()
    }
  }

  private waitForAdmittedOperations(): Promise<void> {
    if (this.admittedOperations === 0) return Promise.resolve()
    return new Promise((resolve) => { this.admittedWaiters.add(resolve) })
  }

  private async openApp(adapter: CrossClientAppAdapter | undefined): Promise<CrossClientAppHandle> {
    return this.runAdmitted(async () => {
      if (adapter === undefined) throw new CrossClientFixtureAdapterError()
      let handle: OwnedAppHandle
      try {
        handle = new OwnedAppHandle(await adapter.open(this.appContext()))
      } catch (_operationFailure) {
        throw new CrossClientFixtureOperationError()
      }
      this.appHandles.push(handle)
      if (this.state !== 'ready') {
        await handle.close().catch(() => {})
        throw new CrossClientFixtureClosedError()
      }
      return handle
    })
  }

  private closeOwnedClients(): Promise<readonly Error[]> {
    return (this.closeOwnedPromise ??= this.closeOwnedClientsFlight())
  }

  private async closeOwnedClientsFlight(): Promise<readonly Error[]> {
    const errors = await this.closeOwnedClientsOnce()
    if (errors.length > 0) this.closeOwnedPromise = undefined
    return errors
  }

  private async closeOwnedClientsOnce(): Promise<readonly Error[]> {
    const errors: Error[] = []
    for (const handle of this.appHandles.toReversed()) {
      await this.closeOwner(errors, 'app-handle', handle, () => handle.close())
    }
    for (const terminal of this.terminals.toReversed()) {
      await this.closeOwner(errors, 'terminal', terminal, () => terminal.close())
    }
    const apiHandle = this.apiHandle
    if (apiHandle !== undefined) {
      await this.closeOwner(errors, 'dashboard', apiHandle.dashboard, () => apiHandle.dashboard.close())
      await this.closeOwner(errors, 'api-client', apiHandle.api, () => apiHandle.api.close())
    }
    for (const runtime of this.runtimeClients) {
      await this.closeOwner(errors, 'runtime-client', runtime, () => runtime.close())
    }
    return errors
  }

  private async closeOwner(
    errors: Error[],
    stage: string,
    owner: object,
    close: () => Promise<void>,
  ): Promise<void> {
    if (this.closedOwners.has(owner)) return
    try {
      await close()
      this.closedOwners.add(owner)
    } catch (_privateFailure) {
      errors.push(new Error(`cross-client cleanup failed at ${stage}`))
    }
  }

  private async stopRuntimeFlight(): Promise<void> {
    try {
      await this.closeClientsAndStopRuntime()
    } catch (error) {
      if (!this.runtimeStopped) this.stopPromise = undefined
      throw error
    }
  }

  private async closeClientsAndStopRuntime(): Promise<void> {
    await this.waitForAdmittedOperations()
    const errors = [...await this.closeOwnedClients()]
    if (errors.length > 0) throw new AggregateError(errors, 'Cross-client fixture Runtime stop failed.')
    try {
      await this.stopRuntimeProcessOnce()
    } catch (_processStopFailure) {
      errors.push(new Error('cross-client cleanup failed at runtime-process'))
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Cross-client fixture Runtime stop failed.')
  }

  private async stopRuntimeProcessOnce(): Promise<void> {
    /* v8 ignore next -- a settled stop flight is retained, so this is a defensive duplicate-call guard */
    if (this.runtimeStopped) return
    const processHandle = this.process
    if (processHandle === undefined) return
    processHandle.endInput()
    let forced = false
    let result: CrossClientRuntimeExit
    try {
      result = await processHandle.waitForExit(this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
    } catch (_gracefulStopFailure) {
      forced = true
      await processHandle.forceKill().catch(() => { throw new FixtureTransportError() })
      try {
        result = await processHandle.waitForExit(this.options.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS)
      } catch (_forcedStopFailure) {
        throw new FixtureTransportError()
      }
    }
    this.runtimeStopped = true
    this.events.push({ kind: 'stopped' })
    if (this.state === 'stopping') this.state = 'stopped'
    if (!forced && (result.exitCode !== 0 || result.signal !== null)) throw new FixtureTransportError()
  }

  private async disposeFlight(): Promise<void> {
    try {
      await this.disposeOnce()
    } catch (error) {
      if (this.hasUnresolvedCleanup()) this.disposePromise = undefined
      throw error
    }
  }

  private async disposeOnce(): Promise<void> {
    const terminalErrors: Error[] = []
    try {
      await this.stopRuntime()
    } catch (stopFailure) {
      if (!this.runtimeStopped) throw stopFailure
      for (const error of (stopFailure as AggregateError).errors as Error[]) {
        terminalErrors.push(new Error(error.message))
      }
    }
    const mock = this.mock
    if (mock !== undefined && !this.mockClosed) {
      try {
        await mock.close()
        this.mockClosed = true
      } catch (_privateMockFailure) {
        throw new AggregateError(
          [...terminalErrors, new Error('cross-client cleanup failed at mock-server')],
          'Cross-client fixture cleanup failed.',
        )
      }
    }
    /* v8 ignore else -- a settled root retains its dispose flight, so retries only enter while unresolved */
    if (!this.rootRemoved) {
      try {
        await this.dependencies.fileSystem.remove(this.root)
        this.rootRemoved = true
      } catch (_privateRootFailure) {
        throw new AggregateError(
          [...terminalErrors, new Error('cross-client cleanup failed at temporary-root')],
          'Cross-client fixture cleanup failed.',
        )
      }
    }
    this.state = 'disposed'
    if (terminalErrors.length > 0) {
      throw new AggregateError(terminalErrors, 'Cross-client fixture cleanup failed.')
    }
  }

  private hasUnresolvedCleanup(): boolean {
    const owners: object[] = [...this.appHandles, ...this.terminals, ...this.runtimeClients]
    if (this.apiHandle !== undefined) owners.push(this.apiHandle.dashboard, this.apiHandle.api)
    if (owners.some(owner => !this.closedOwners.has(owner))) return true
    if (this.process !== undefined && !this.runtimeStopped) return true
    if (this.mock !== undefined && !this.mockClosed) return true
    return !this.rootRemoved
  }
}

/**
 * Create one isolated canonical built Runtime and authenticated shared-state fixture.
 * Setup failures are redacted after best-effort cleanup; callers never receive provider,
 * handoff, cookie, endpoint, or process output values.
 * @param options - bounded host adapters and deterministic mock behavior.
 * @returns a ready fixture after public no-start status reports `running`.
 * @throws {@link CrossClientFixtureSetupError} when setup or readiness fails.
 */
export async function createCrossClientFixture(
  options: CrossClientFixtureOptions = {},
): Promise<CrossClientFixture> {
  const dependencies = resolveCrossClientDependencies(options.dependencies)
  let root: string
  try {
    root = await dependencies.fileSystem.mkdtemp(join(options.temporaryParent ?? tmpdir(), 'harness-cross-client-'))
  } catch (_temporaryRootFailure) {
    throw new CrossClientFixtureSetupError()
  }
  const home = join(root, 'harness-home')
  const platformHome = join(root, 'platform-home')
  const workspace = join(root, 'workspace')
  const fixture = new CrossClientFixtureImpl(root, home, platformHome, workspace, dependencies, options)
  try {
    const directoryResults = await Promise.allSettled([
      dependencies.fileSystem.mkdir(join(home, '.agent-presets', 'standard')),
      dependencies.fileSystem.mkdir(platformHome),
      dependencies.fileSystem.mkdir(join(platformHome, 'tmp')),
      dependencies.fileSystem.mkdir(workspace),
    ])
    if (directoryResults.some(result => result.status === 'rejected')) throw new FixtureTransportError()
    await dependencies.fileSystem.writeFile(
      join(home, '.agent-presets', 'standard', 'agent.cordis.yml'),
      '[]\n',
    )
    await fixture.initialize()
    return fixture
  } catch (_setupFailure) {
    const setupError = new CrossClientFixtureSetupError()
    try {
      await fixture.dispose()
    } catch (cleanupFailure) {
      let cleanupErrors: Error[]
      /* v8 ignore else -- defensive containment if dispose violates its internal AggregateError contract */
      if (cleanupFailure instanceof AggregateError) {
        cleanupErrors = (cleanupFailure.errors as Error[]).map(error => new Error(error.message))
      } else {
        cleanupErrors = [new Error('cross-client cleanup failed at unknown stage')]
      }
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        'Cross-client fixture setup and cleanup failed.',
      )
    }
    throw setupError
  }
}
