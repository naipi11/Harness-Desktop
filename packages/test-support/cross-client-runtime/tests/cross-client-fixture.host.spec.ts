/** Host fixture lifecycle, state, cleanup, and dependency-boundary acceptance. */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryEntry, SessionSummary, WorkspaceId, WorkspaceView } from '@harness-desktop/dsh-host-apiproxy/api'
import {
  RuntimeBusyError,
  type DashboardAttachment,
  type RuntimeStatus,
  type SessionId,
  type TerminalConnection,
  type TerminalOpenRequest,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  CrossClientFixtureAdapterError,
  CrossClientFixtureOperationError,
  CrossClientFixtureSetupError,
  assertCrossClientLifecycle,
  createCrossClientFixture,
  CrossClientFixtureClosedError,
  type CrossClientDashboardApiHandle,
  type CrossClientFixtureDependencies,
  type CrossClientRuntimeClient,
  type CrossClientRuntimeProcessHandle,
  type CrossClientStateClient,
} from '../src/index.ts'

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function workspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

function sessionId(value: string): SessionId {
  return value as SessionId
}

function runningStatus(): RuntimeStatus {
  return {
    state: 'running',
    runtimeId: 'runtime-fixture' as RuntimeStatus['runtimeId'],
    dashboardOrigin: 'http://127.0.0.1:43123' as RuntimeStatus['dashboardOrigin'],
    backgroundLease: { id: 'web' as RuntimeStatus['backgroundLease']['id'], state: 'absent' },
  }
}

class StateClient implements CrossClientStateClient {
  private readonly workspaces: WorkspaceView[] = []
  private readonly sessions: SessionSummary[] = []
  private readonly histories = new Map<SessionId, HistoryEntry[]>()

  async createWorkspace(path: string): Promise<WorkspaceView> {
    const existing = this.workspaces.find(workspace => workspace.path === path)
    if (existing !== undefined) return existing
    const now = '2026-08-24T00:00:00.000Z'
    const workspace: WorkspaceView = {
      workspaceId: workspaceId(`workspace-${String(this.workspaces.length + 1)}`),
      path,
      title: 'workspace',
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    this.workspaces.push(workspace)
    return workspace
  }

  async createSession(owner: WorkspaceId): Promise<SessionId> {
    const id = sessionId(`session-${String(this.sessions.length + 1)}`)
    const workspace = this.workspaces.find(candidate => candidate.workspaceId === owner)
    if (workspace === undefined) throw new Error('workspace missing')
    workspace.sessionIds.push(id)
    this.sessions.push({ sessionId: id, updatedAt: 0, running: false, blank: true })
    this.histories.set(id, [])
    return id
  }

  async readWorkspaces(): Promise<readonly WorkspaceView[]> {
    return this.workspaces
  }

  async readSessions(): Promise<readonly SessionSummary[]> {
    return this.sessions
  }

  async readHistory(id: SessionId): Promise<readonly HistoryEntry[]> {
    return this.histories.get(id) ?? []
  }

  async prompt(id: SessionId, _text: string): Promise<void> {
    const summary = this.sessions.find(session => session.sessionId === id)
    if (summary === undefined) throw new Error('session missing')
    summary.blank = false
  }

  async close(): Promise<void> {}
}

interface FixtureSignals {
  readonly healthInputs: Array<{ readonly home: string; readonly platformHome: string; readonly start: boolean }>
  runtimeInputEnded: number
  runtimeWaited: number
  runtimeKilled: number
  runtimeClientClosed: number
  dashboardClosed: number
  apiClosed: number
  mockClosed: number
  removedRoots: string[]
  appClosed: number
  terminalClosed: number
}

interface DependencyOptions {
  readonly healthFailures?: number
  readonly closeFailures?: ReadonlySet<'runtime-client' | 'dashboard' | 'api' | 'mock' | 'app' | 'terminal'>
  readonly waitForExit?: () => Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
  readonly forceKill?: () => Promise<void>
  readonly mockStartFailure?: boolean
}

async function dependencies(
  temporaryParent: string,
  options: DependencyOptions = {},
): Promise<{
  readonly dependencies: CrossClientFixtureDependencies
  readonly signals: FixtureSignals
  readonly state: StateClient
  readonly runtimeClient: CrossClientRuntimeClient
  readonly terminal: TerminalConnection
}> {
  const signals: FixtureSignals = {
    healthInputs: [],
    runtimeInputEnded: 0,
    runtimeWaited: 0,
    runtimeKilled: 0,
    runtimeClientClosed: 0,
    dashboardClosed: 0,
    apiClosed: 0,
    mockClosed: 0,
    removedRoots: [],
    appClosed: 0,
    terminalClosed: 0,
  }
  const failures = options.closeFailures ?? new Set()
  const state = new StateClient()
  const dashboard: DashboardAttachment = {
    createBrowserHandoff: async () => { throw new Error('not used by injected API adapter') },
    close: async () => {
      signals.dashboardClosed += 1
      if (failures.has('dashboard')) throw new Error('dashboard secret failure')
    },
  }
  const terminal: TerminalConnection = {
    events: async function * () {},
    submit: async () => {},
    runControl: async () => {},
    cancel: async () => ({ kind: 'idle' }),
    close: async () => {
      signals.terminalClosed += 1
      if (failures.has('terminal')) throw new Error('terminal secret failure')
    },
  }
  const runtimeClient: CrossClientRuntimeClient = {
    status: async () => runningStatus(),
    openTerminal: async (_request: TerminalOpenRequest) => terminal,
    attachDashboard: async () => dashboard,
    close: async () => {
      signals.runtimeClientClosed += 1
      if (failures.has('runtime-client')) throw new Error('runtime client secret failure')
    },
  }
  const process: CrossClientRuntimeProcessHandle = {
    endInput: () => { signals.runtimeInputEnded += 1 },
    waitForExit: async () => {
      signals.runtimeWaited += 1
      return options.waitForExit?.() ?? { exitCode: 0, signal: null }
    },
    forceKill: async () => {
      signals.runtimeKilled += 1
      await options.forceKill?.()
    },
  }
  let healthFailures = options.healthFailures ?? 0
  state.close = async () => {
    signals.apiClosed += 1
    if (failures.has('api')) throw new Error('api secret failure')
  }
  const api: CrossClientDashboardApiHandle = {
    api: state,
    dashboard,
  }
  const result: CrossClientFixtureDependencies = {
    fileSystem: {
      mkdtemp: (prefix) => {
        if (!prefix.startsWith(temporaryParent)) throw new Error('fixture escaped its selected temporary parent')
        return mkdtemp(prefix)
      },
      mkdir: path => mkdir(path, { recursive: true }).then(() => {}),
      writeFile: (path, data) => writeFile(path, data),
      remove: async (path) => {
        signals.removedRoots.push(path)
        await rm(path, { recursive: true, force: true })
      },
    },
    mockServer: {
      start: async () => {
        if (options.mockStartFailure === true) throw new Error('private mock start failure')
        return {
          baseURL: 'http://127.0.0.1:43999',
          close: async () => {
            signals.mockClosed += 1
            if (failures.has('mock')) throw new Error('mock secret failure')
          },
        }
      },
    },
    runtimeProcess: { start: async () => process },
    runtimeHealth: {
      connect: async (input) => {
        signals.healthInputs.push(input)
        if (healthFailures > 0) {
          healthFailures -= 1
          throw new Error('private readiness failure')
        }
        return runtimeClient
      },
    },
    dashboardApi: { connect: async () => api },
    delay: async () => {},
  }
  return { dependencies: result, signals, state, runtimeClient, terminal }
}

async function temporaryParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cross-client-host-spec-'))
  roots.add(parent)
  return parent
}

describe('cross-client Runtime fixture', () => {
  it('owns one isolated layout and records explicit public health before accepting shared state', async () => {
    const parent = await temporaryParent()
    const setup = await dependencies(parent, { healthFailures: 2 })
    const fixture = await createCrossClientFixture({
      temporaryParent: parent,
      healthTimeoutMs: 1_000,
      dependencies: setup.dependencies,
    })

    expect(fixture.home.startsWith(parent)).toBe(true)
    expect(fixture.platformHome.startsWith(parent)).toBe(true)
    expect(fixture.workspace.startsWith(parent)).toBe(true)
    expect(await readFile(join(fixture.home, '.agent-presets', 'standard', 'agent.cordis.yml'), 'utf8'))
      .toBe('[]\n')
    expect(setup.signals.healthInputs).toEqual([
      { home: fixture.home, platformHome: fixture.platformHome, start: false },
      { home: fixture.home, platformHome: fixture.platformHome, start: false },
      { home: fixture.home, platformHome: fixture.platformHome, start: false },
    ])
    expect(fixture.lifecycleSnapshot()).toEqual({
      state: 'ready',
      events: [{ kind: 'started' }, { kind: 'health-confirmed' }],
      observations: [],
    })

    const workspace = await fixture.createWorkspace()
    const observation = await fixture.createSession(workspace.workspaceId)
    await fixture.prompt(observation.sessionId, 'one public prompt')
    expect(await fixture.readWorkspaces()).toHaveLength(1)
    expect(await fixture.readSessions()).toEqual([
      { sessionId: observation.sessionId, updatedAt: 0, running: false, blank: false },
    ])
    expect(await fixture.readHistory(observation.sessionId)).toEqual([])
    expect(fixture.observations).toEqual([observation])

    await fixture.dispose()
    const snapshot = fixture.lifecycleSnapshot()
    expect(snapshot).toEqual({
      state: 'disposed',
      events: [{ kind: 'started' }, { kind: 'health-confirmed' }, { kind: 'stopped' }],
      observations: [observation],
    })
    expect(() => { assertCrossClientLifecycle(snapshot) }).not.toThrow()
    expect(setup.signals.removedRoots).toEqual([join(fixture.home, '..')])
    await expect(access(parent)).resolves.toBeUndefined()
    await expect(access(fixture.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a lifecycle ledger that never observes the owned Runtime stop', () => {
    expect(() => { assertCrossClientLifecycle({
      state: 'disposed',
      events: [{ kind: 'started' }, { kind: 'health-confirmed' }],
      observations: [],
    }) }).toThrow('exactly one stopped event')
  })

  it('rejects every invalid lifecycle order and missing required stage', () => {
    const invalid: Array<readonly [Parameters<typeof assertCrossClientLifecycle>[0], string]> = [
      [{ state: 'disposed', events: [], observations: [] }, 'exactly one started event'],
      [{ state: 'disposed', events: [{ kind: 'started' }], observations: [] }, 'exactly one health-confirmed event'],
      [{ state: 'disposed', events: [{ kind: 'started' }, { kind: 'started' }], observations: [] }, 'started event is out of order'],
      [{ state: 'disposed', events: [{ kind: 'health-confirmed' }], observations: [] }, 'health-confirmed event is out of order'],
      [{ state: 'disposed', events: [{ kind: 'stopped' }], observations: [] }, 'stopped event is out of order'],
    ]
    for (const [snapshot, message] of invalid) {
      expect(() => { assertCrossClientLifecycle(snapshot) }).toThrow(message)
    }
  })

  it('redacts each authenticated state failure and exercises implicit workspace ownership', async () => {
    const parent = await temporaryParent()
    const setup = await dependencies(parent)
    const fixture = await createCrossClientFixture({ temporaryParent: parent, dependencies: setup.dependencies })

    const originalCreateWorkspace = setup.state.createWorkspace.bind(setup.state)
    setup.state.createWorkspace = async () => { throw new Error('private workspace token') }
    await expect(fixture.createWorkspace()).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    setup.state.createWorkspace = originalCreateWorkspace
    const workspace = await fixture.createWorkspace()

    const originalCreateSession = setup.state.createSession.bind(setup.state)
    setup.state.createSession = async () => { throw new Error('private session token') }
    await expect(fixture.createSession(workspace.workspaceId)).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    setup.state.createSession = originalCreateSession

    const operations: Array<readonly [keyof StateClient, () => Promise<unknown>]> = [
      ['readWorkspaces', () => fixture.readWorkspaces()],
      ['readSessions', () => fixture.readSessions()],
      ['readHistory', () => fixture.readHistory(sessionId('missing'))],
      ['prompt', () => fixture.prompt(sessionId('missing'), 'private prompt')],
    ]
    for (const [method, operation] of operations) {
      const original = setup.state[method].bind(setup.state) as (...args: never[]) => Promise<unknown>
      Object.assign(setup.state, { [method]: async () => { throw new Error('private API token') } })
      await expect(operation()).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
      Object.assign(setup.state, { [method]: original })
    }
    await fixture.dispose()

    const implicitSetup = await dependencies(parent)
    const implicit = await createCrossClientFixture({ temporaryParent: parent, dependencies: implicitSetup.dependencies })
    const first = await implicit.createSession()
    const second = await implicit.createSession()
    expect(first.workspaceId).toBe(second.workspaceId)
    await implicit.dispose()
  })

  it('wraps terminal, busy, CLI, and app adapters without leaking injected failures', async () => {
    const parent = await temporaryParent()
    const setup = await dependencies(parent)
    let cliMode: 'success' | 'stdout-secret' | 'stderr-secret' | 'failure' = 'success'
    let desktopFailure = false
    const fixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: setup.dependencies,
      adapters: {
        cli: {
          run: async (args, context) => {
            expect(args).toEqual(['run', 'task'])
            expect(context.workspace).toBe(fixture.workspace)
            if (cliMode === 'failure') throw new Error('private CLI failure')
            return {
              exitCode: 0,
              stdout: cliMode === 'stdout-secret' ? 'cross-client-runtime-fixture-key' : 'ok',
              stderr: cliMode === 'stderr-secret' ? 'cross-client-runtime-fixture-key' : '',
            }
          },
        },
        desktop: {
          open: async () => {
            if (desktopFailure) throw new Error('private Desktop failure')
            return { close: async () => { setup.signals.appClosed += 1 } }
          },
        },
      },
    })

    await expect(fixture.openWeb()).rejects.toBeInstanceOf(CrossClientFixtureAdapterError)
    const desktop = await fixture.openDesktop()
    await desktop.close()
    await desktop.close()
    desktopFailure = true
    await expect(fixture.openDesktop()).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    expect(await fixture.runCli(['run', 'task'])).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' })
    cliMode = 'stdout-secret'
    await expect(fixture.runCli(['run', 'task'])).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    cliMode = 'stderr-secret'
    await expect(fixture.runCli(['run', 'task'])).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    cliMode = 'failure'
    await expect(fixture.runCli(['run', 'task'])).rejects.toBeInstanceOf(CrossClientFixtureOperationError)

    const originalOpen = setup.runtimeClient.openTerminal.bind(setup.runtimeClient)
    setup.runtimeClient.openTerminal = async (request) => {
      throw new RuntimeBusyError(request.sessionId ?? sessionId('busy'))
    }
    await expect(fixture.openTerminal({ sessionId: sessionId('busy') })).rejects.toBeInstanceOf(RuntimeBusyError)
    expect((await fixture.expectSameSessionBusy(sessionId('busy'))).sessionId).toBe(sessionId('busy'))
    setup.runtimeClient.openTerminal = async () => { throw new RuntimeBusyError(sessionId('other')) }
    await expect(fixture.expectSameSessionBusy(sessionId('busy'), 'wrong owner')).rejects
      .toBeInstanceOf(CrossClientFixtureOperationError)
    setup.runtimeClient.openTerminal = async () => { throw new Error('private terminal failure') }
    await expect(fixture.openTerminal()).rejects.toBeInstanceOf(CrossClientFixtureOperationError)
    await expect(fixture.expectSameSessionBusy(sessionId('busy'), 'unknown failure')).rejects
      .toBeInstanceOf(CrossClientFixtureOperationError)
    setup.runtimeClient.openTerminal = originalOpen
    await expect(fixture.expectSameSessionBusy(sessionId('not-busy'), 'unexpected success')).rejects
      .toBeInstanceOf(CrossClientFixtureOperationError)
    await fixture.dispose()
    expect(setup.signals.appClosed).toBe(1)

    const missingSetup = await dependencies(parent)
    const missing = await createCrossClientFixture({ temporaryParent: parent, dependencies: missingSetup.dependencies })
    await expect(missing.runCli([])).rejects.toBeInstanceOf(CrossClientFixtureAdapterError)
    await expect(missing.openDesktop()).rejects.toBeInstanceOf(CrossClientFixtureAdapterError)
    await missing.dispose()
  })

  it('stops new operations during cleanup and aggregates independent resource failures once', async () => {
    const parent = await temporaryParent()
    let releaseExit: (() => void) | undefined
    const exit = new Promise<void>((resolve) => { releaseExit = resolve })
    const setup = await dependencies(parent, {
      closeFailures: new Set(['runtime-client', 'dashboard', 'api', 'mock', 'app', 'terminal']),
      waitForExit: async () => {
        await exit
        return { exitCode: 0, signal: null }
      },
    })
    const fixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: setup.dependencies,
      adapters: {
        web: {
          open: async () => ({
            close: async () => {
              setup.signals.appClosed += 1
              throw new Error('app secret failure')
            },
          }),
        },
      },
    })
    await fixture.openWeb()
    const terminal = await fixture.openTerminal()
    terminal.events()
    await terminal.submit({ kind: 'task', text: 'proxy task' })
    await terminal.runControl({ command: 'doctor' })
    expect(await terminal.cancel()).toEqual({ kind: 'idle' })

    const disposing = fixture.dispose()
    await expect(fixture.createWorkspace()).rejects.toBeInstanceOf(CrossClientFixtureClosedError)
    releaseExit?.()
    const first = await disposing.catch((error: unknown) => error)
    const second = await fixture.dispose().catch((error: unknown) => error)

    expect(first).toBeInstanceOf(AggregateError)
    expect(second).toBe(first)
    expect((first as AggregateError).errors).toHaveLength(6)
    expect((first as AggregateError).errors.map(error => (error as Error).message)).toEqual([
      'cross-client cleanup failed at app-handle',
      'cross-client cleanup failed at terminal',
      'cross-client cleanup failed at dashboard',
      'cross-client cleanup failed at api-client',
      'cross-client cleanup failed at runtime-client',
      'cross-client cleanup failed at mock-server',
    ])
    const publicDiagnostic = [
      String(first),
      ...(first as AggregateError).errors.map(error => String(error)),
      JSON.stringify(fixture.lifecycleSnapshot()),
    ].join('\n')
    for (const secret of [
      fixture.home,
      'runtime client secret failure',
      'dashboard secret failure',
      'api secret failure',
      'mock secret failure',
      'app secret failure',
      'terminal secret failure',
    ]) expect(publicDiagnostic).not.toContain(secret)
    expect(setup.signals).toMatchObject({
      runtimeInputEnded: 1,
      runtimeWaited: 1,
      runtimeClientClosed: 1,
      dashboardClosed: 1,
      apiClosed: 1,
      mockClosed: 1,
      appClosed: 1,
      terminalClosed: 1,
    })
    expect(setup.signals.removedRoots).toHaveLength(1)
  })

  it('force-stops after the bounded stdin-EOF wait and records one stop before removal', async () => {
    const parent = await temporaryParent()
    let wait = 0
    const setup = await dependencies(parent, {
      waitForExit: async () => {
        wait += 1
        if (wait === 1) throw new Error('private process timeout with token')
        return { exitCode: null, signal: 'SIGKILL' }
      },
    })
    const fixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: setup.dependencies,
      stopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
    })

    await fixture.dispose()

    expect(setup.signals).toMatchObject({
      runtimeInputEnded: 1,
      runtimeWaited: 2,
      runtimeKilled: 1,
    })
    expect(fixture.lifecycleSnapshot().events).toEqual([
      { kind: 'started' },
      { kind: 'health-confirmed' },
      { kind: 'stopped' },
    ])
    expect(setup.signals.removedRoots).toHaveLength(1)
  })

  it('closes every owned client before direct Runtime stop and leaves final root cleanup to dispose', async () => {
    const parent = await temporaryParent()
    const setup = await dependencies(parent)
    const fixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: setup.dependencies,
      adapters: {
        web: {
          open: async () => ({
            close: async () => { setup.signals.appClosed += 1 },
          }),
        },
      },
    })
    await fixture.openWeb()
    await fixture.openTerminal()

    await fixture.stopRuntime()

    expect(setup.signals).toMatchObject({
      appClosed: 1,
      terminalClosed: 1,
      dashboardClosed: 1,
      apiClosed: 1,
      runtimeClientClosed: 1,
      runtimeInputEnded: 1,
      runtimeWaited: 1,
      mockClosed: 0,
    })
    expect(setup.signals.removedRoots).toEqual([])
    expect(fixture.lifecycleSnapshot().state).toBe('stopped')

    await fixture.dispose()
    expect(setup.signals).toMatchObject({
      appClosed: 1,
      terminalClosed: 1,
      dashboardClosed: 1,
      apiClosed: 1,
      runtimeClientClosed: 1,
      mockClosed: 1,
    })
    expect(setup.signals.removedRoots).toHaveLength(1)
  })

  it('surfaces a redacted setup and cleanup aggregate after health timeout without leaking the owned root', async () => {
    const parent = await temporaryParent()
    const setup = await dependencies(parent, {
      closeFailures: new Set(['runtime-client', 'mock']),
    })
    setup.runtimeClient.status = async () => { throw new Error('private status failure') }

    const failure = await createCrossClientFixture({
      temporaryParent: parent,
      healthTimeoutMs: 0,
      dependencies: setup.dependencies,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(3)
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(CrossClientFixtureSetupError)
    expect(String((failure as AggregateError).errors[1])).toBe('Error: cross-client cleanup failed at runtime-client')
    expect(String((failure as AggregateError).errors[2])).toBe('Error: cross-client cleanup failed at mock-server')
    expect(setup.signals).toMatchObject({
      runtimeInputEnded: 1,
      runtimeWaited: 1,
      runtimeClientClosed: 2,
      mockClosed: 1,
    })
    expect(setup.signals.removedRoots).toHaveLength(1)
    const publicDiagnostic = [
      String(failure),
      ...(failure as AggregateError).errors.map(error => String(error)),
    ].join('\n')
    expect(publicDiagnostic).not.toContain(parent)
    expect(publicDiagnostic).not.toContain('private readiness failure')
    expect(publicDiagnostic).not.toContain('mock secret failure')
  })

  it('cleans a successful health-timeout setup and redacts temporary-root creation failure', async () => {
    const parent = await temporaryParent()
    const timeoutSetup = await dependencies(parent, { healthFailures: 1 })
    await expect(createCrossClientFixture({
      temporaryParent: parent,
      healthTimeoutMs: 0,
      dependencies: timeoutSetup.dependencies,
    })).rejects.toBeInstanceOf(CrossClientFixtureSetupError)
    expect(timeoutSetup.signals.removedRoots).toHaveLength(1)

    const rootSetup = await dependencies(parent)
    rootSetup.dependencies.fileSystem.mkdtemp = async () => { throw new Error('private root path') }
    await expect(createCrossClientFixture({
      temporaryParent: parent,
      dependencies: rootSetup.dependencies,
    })).rejects.toBeInstanceOf(CrossClientFixtureSetupError)

    const defaultParentSetup = await dependencies(tmpdir())
    const defaultParent = await createCrossClientFixture({ dependencies: defaultParentSetup.dependencies })
    await defaultParent.dispose()
  })

  it('retries a stopping health client and contains each terminal process-stop failure', async () => {
    const parent = await temporaryParent()
    const healthSetup = await dependencies(parent)
    let statusCalls = 0
    let closeCalls = 0
    healthSetup.runtimeClient.status = async () => {
      statusCalls += 1
      return statusCalls < 3 ? { ...runningStatus(), state: 'stopping' } : runningStatus()
    }
    healthSetup.runtimeClient.close = async () => {
      closeCalls += 1
      if (closeCalls === 2) throw new Error('private transient close')
    }
    const healthFixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: healthSetup.dependencies,
      healthIntervalMs: 0,
    })
    expect(statusCalls).toBe(3)
    await healthFixture.dispose()

    for (const outcome of [
      { exitCode: 1, signal: null },
      { exitCode: 0, signal: 'SIGTERM' as const },
    ]) {
      const stopSetup = await dependencies(parent, { waitForExit: async () => outcome })
      const stopped = await createCrossClientFixture({ temporaryParent: parent, dependencies: stopSetup.dependencies })
      await expect(stopped.stopRuntime()).rejects.toBeInstanceOf(AggregateError)
      await expect(stopped.dispose()).rejects.toBeInstanceOf(AggregateError)
      expect(stopSetup.signals.removedRoots).toHaveLength(1)
    }

    const killSetup = await dependencies(parent, {
      waitForExit: async () => { throw new Error('private wait failure') },
      forceKill: async () => { throw new Error('private kill failure') },
    })
    const killFixture = await createCrossClientFixture({ temporaryParent: parent, dependencies: killSetup.dependencies })
    await expect(killFixture.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(killSetup.signals.removedRoots).toEqual([])

    let forcedWaits = 0
    const forcedWaitSetup = await dependencies(parent, {
      waitForExit: async () => {
        forcedWaits += 1
        throw new Error('private forced wait failure')
      },
    })
    const forcedWaitFixture = await createCrossClientFixture({
      temporaryParent: parent,
      dependencies: forcedWaitSetup.dependencies,
    })
    await expect(forcedWaitFixture.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(forcedWaits).toBe(2)
    expect(forcedWaitSetup.signals.removedRoots).toEqual([])

    const mockSetup = await dependencies(parent, { mockStartFailure: true })
    await expect(createCrossClientFixture({ temporaryParent: parent, dependencies: mockSetup.dependencies }))
      .rejects.toBeInstanceOf(CrossClientFixtureSetupError)
    expect(mockSetup.signals.runtimeInputEnded).toBe(0)
    expect(mockSetup.signals.removedRoots).toHaveLength(1)
  })
})

describe('host-only source dependency boundary', () => {
  it('contains no browser runner, Electron, or browser-only client fixture import', async () => {
    const sourcePaths = ['index.ts', 'cross-client-fixture.ts', 'cross-client-defaults.ts', 'invariant.ts']
    const imports = (await Promise.all(sourcePaths.map(async (file) => {
      const source = await readFile(join(import.meta.dirname, '..', 'src', file), 'utf8')
      return ts.preProcessFile(source).importedFiles.map(item => item.fileName)
    }))).flat()

    expect(imports.filter(specifier =>
      specifier === 'electron'
      || specifier.startsWith('electron/')
      || specifier.includes('playwright')
      || specifier.includes('packages/test-support/client-runtime')
      || specifier === '@harness-desktop/dsh-client-test-runtime',
    )).toEqual([])
  })
})
