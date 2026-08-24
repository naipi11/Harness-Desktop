import { PassThrough } from 'node:stream'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  RuntimeBusyError,
  RuntimeProtocolError,
  RuntimeUnavailableError,
  type ActiveWorkStatus,
  type ApprovalId,
  type BackgroundLeaseId,
  type LegacyMigrationState,
  type RuntimeClient,
  type RuntimeConnector,
  type RuntimeLease,
  type RuntimeLeaseStatus,
  type RuntimeStatus,
  type SessionId,
  type TerminalConnection,
  type TerminalControlCommand,
  type TerminalInput,
  type TerminalOpenRequest,
  type TerminalProtocolEvent,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  runTerminalInvocation,
  type InteractiveTerminalSurface,
  type TerminalIO,
  type TerminalInvocation,
  type TerminalUserAction,
} from '../src/terminal-client.ts'

function sessionId(value: string): SessionId {
  return value as SessionId
}

function approvalId(value: string): ApprovalId {
  return value as ApprovalId
}

class FakeTerminal implements TerminalConnection {
  readonly inputs: TerminalInput[] = []
  readonly controls: TerminalControlCommand[] = []
  cancelResult: Promise<{ readonly kind: 'cancelled' | 'idle' }> = Promise.resolve({ kind: 'cancelled' })
  closed = false
  closeError: Error | undefined
  closeResult: Promise<void> | undefined
  eventsError: Error | undefined
  eventsResult: Promise<void> | undefined

  constructor(private readonly protocolEvents: readonly TerminalProtocolEvent[]) {}

  async * events(): AsyncIterable<TerminalProtocolEvent> {
    for (const event of this.protocolEvents) yield event
    if (this.eventsResult !== undefined) await this.eventsResult
    if (this.eventsError !== undefined) throw this.eventsError
  }

  submit(input: TerminalInput): Promise<void> {
    this.inputs.push(input)
    return Promise.resolve()
  }

  runControl(command: TerminalControlCommand): Promise<void> {
    this.controls.push(command)
    return Promise.resolve()
  }

  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }> {
    return this.cancelResult
  }

  async close(): Promise<void> {
    if (this.closeResult !== undefined) return this.closeResult
    if (this.closeError !== undefined) throw this.closeError
    this.closed = true
  }
}

class FakeRuntimeClient implements RuntimeClient {
  readonly openRequests: TerminalOpenRequest[] = []
  readonly migrationActions: Array<'accept' | 'decline' | 'retry'> = []
  closed = false
  closeError: Error | undefined
  migration: LegacyMigrationState = { kind: 'not-needed' }
  active: ActiveWorkStatus[] = [{ ownUiWork: [] }]
  activeResult: Promise<ActiveWorkStatus> | undefined
  closeResult: Promise<void> | undefined

  constructor(readonly terminal: FakeTerminal) {}

  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection> {
    this.openRequests.push(request)
    return Promise.resolve(this.terminal)
  }

  attachDashboard(): ReturnType<RuntimeClient['attachDashboard']> {
    throw new Error('Dashboard is outside terminal client scope')
  }

  acquireBackgroundLease(): Promise<RuntimeLease> {
    return Promise.resolve({ id: 'web' as BackgroundLeaseId })
  }

  status(): Promise<RuntimeStatus> {
    throw new Error('status is outside terminal client scope')
  }

  releaseBackgroundLease(): Promise<RuntimeLeaseStatus> {
    return Promise.resolve({ id: 'web' as BackgroundLeaseId, state: 'absent' })
  }

  getLegacyMigration(): Promise<LegacyMigrationState> {
    return Promise.resolve(this.migration)
  }

  acceptLegacyMigration(): Promise<LegacyMigrationState> {
    this.migrationActions.push('accept')
    this.migration = { kind: 'imported', copied: ['sessions'] }
    return Promise.resolve(this.migration)
  }

  declineLegacyMigration(): Promise<LegacyMigrationState> {
    this.migrationActions.push('decline')
    this.migration = { kind: 'declined' }
    return Promise.resolve(this.migration)
  }

  retryLegacyMigration(): Promise<LegacyMigrationState> {
    this.migrationActions.push('retry')
    return Promise.resolve(this.migration)
  }

  getDesktopUpdateChannel(): ReturnType<RuntimeClient['getDesktopUpdateChannel']> {
    return Promise.reject(new Error('Desktop update controls are outside terminal client scope'))
  }

  setDesktopUpdateChannel(
    _channel: Parameters<RuntimeClient['setDesktopUpdateChannel']>[0],
  ): ReturnType<RuntimeClient['setDesktopUpdateChannel']> {
    return Promise.reject(new Error('Desktop update controls are outside terminal client scope'))
  }

  recordDesktopUpdateOutcome(
    _outcome: Parameters<RuntimeClient['recordDesktopUpdateOutcome']>[0],
  ): ReturnType<RuntimeClient['recordDesktopUpdateOutcome']> {
    return Promise.reject(new Error('Desktop update controls are outside terminal client scope'))
  }

  observeActiveWork(): Promise<ActiveWorkStatus> {
    if (this.activeResult !== undefined) return this.activeResult
    return Promise.resolve(this.active.shift() ?? { ownUiWork: [] })
  }

  stopOwnUiWork(): ReturnType<RuntimeClient['stopOwnUiWork']> {
    return Promise.resolve({ kind: 'none-active' })
  }

  close(): Promise<void> {
    if (this.closeResult !== undefined) return this.closeResult
    if (this.closeError !== undefined) return Promise.reject(this.closeError)
    this.closed = true
    return Promise.resolve()
  }
}

class FakeConnector implements RuntimeConnector {
  readonly starts: boolean[] = []

  constructor(private readonly result: RuntimeClient | Error) {}

  connect(options: { readonly start: boolean }): Promise<RuntimeClient> {
    this.starts.push(options.start)
    return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result)
  }
}

class FakeSurface implements InteractiveTerminalSurface {
  readonly events: TerminalProtocolEvent[] = []
  readonly diagnostics: unknown[] = []
  readonly migrationStates: LegacyMigrationState[] = []
  closed = false
  closeResult: Promise<void> | undefined
  private readonly actionStream: AsyncIterable<TerminalUserAction>

  constructor(userActions: () => AsyncIterable<TerminalUserAction>) {
    this.actionStream = userActions()
  }

  actions(): AsyncIterable<TerminalUserAction> {
    return this.actionStream
  }

  writeEvent(event: TerminalProtocolEvent): void {
    this.events.push(event)
  }

  writeDiagnostic(error: unknown): void {
    this.diagnostics.push(error)
  }

  writeMigration(state: LegacyMigrationState): void {
    this.migrationStates.push(state)
  }

  close(): Promise<void> {
    if (this.closeResult !== undefined) return this.closeResult
    this.closed = true
    return Promise.resolve()
  }
}

function output(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8').on('data', (chunk: string) => { value += chunk })
  return { stream, text: () => value }
}

function io(
  surface?: FakeSurface,
  overrides: Partial<TerminalIO> = {},
): { io: TerminalIO; stdout: () => string; stderr: () => string } {
  const out = output()
  const err = output()
  return {
    io: {
      stdin: new PassThrough(),
      stdout: out.stream,
      stderr: err.stream,
      workspace: 'C:\\workspace',
      colorDepth: 1,
      columns: 80,
      ...(surface === undefined ? {} : { createInteractiveSurface: () => Promise.resolve(surface) }),
      ...overrides,
    },
    stdout: out.text,
    stderr: err.text,
  }
}

describe('runTerminalInvocation', () => {
  it('accepts only task-bearing invocation modes', () => {
    expectTypeOf<TerminalInvocation['mode']>().toEqualTypeOf<'interactive' | 'run'>()
  })

  it('renders JSON mode as protocol-only newline-delimited records and closes only its attachments', async () => {
    const events: TerminalProtocolEvent[] = [
      { kind: 'session-opened', sessionId: sessionId('session-json') },
      { kind: 'output', text: 'answer' },
      { kind: 'tool-activity', title: 'Read file' },
    ]
    const terminal = new FakeTerminal(events)
    const client = new FakeRuntimeClient(terminal)
    const connector = new FakeConnector(client)
    const streams = io()

    const code = await runTerminalInvocation(
      { mode: 'run', task: 'test JSON', json: true, sessionId: sessionId('resumed-json') },
      streams.io,
      connector,
    )

    expect(code).toBe(0)
    expect(connector.starts).toEqual([true])
    expect(client.openRequests).toEqual([{
      workspace: 'C:\\workspace', initialTask: 'test JSON', sessionId: sessionId('resumed-json'),
    }])
    expect(streams.stdout().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)).toEqual(events)
    expect(streams.stderr()).toBe('')
    expect(terminal.closed).toBe(true)
    expect(client.closed).toBe(true)
  })

  it('maps every slash control one-for-one and submits task and approval inputs', async () => {
    const requestedApproval = approvalId('11111111-1111-4111-8111-111111111111')
    const terminal = new FakeTerminal([
      { kind: 'session-opened', sessionId: sessionId('session-interactive') },
      { kind: 'approval-requested', approvalId: requestedApproval, prompt: 'Approve write?' },
    ])
    const client = new FakeRuntimeClient(terminal)
    const surface = new FakeSurface(async function * () {
      while (!surface.events.some(event => event.kind === 'approval-requested')) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      for (const line of [
        'plain task', 'approve', '/model deepseek-chat', '/permissions standard', '/plan', '/compact',
        '/resume session-next', '/diff', '/terminal', '/doctor', '/exit',
      ]) yield { kind: 'line', line }
    })
    const streams = io(surface)

    const code = await runTerminalInvocation(
      { mode: 'interactive', initialTask: undefined }, streams.io, new FakeConnector(client),
    )

    expect(code).toBe(0)
    expect(client.openRequests).toEqual([{ workspace: 'C:\\workspace' }])
    expect(terminal.inputs).toEqual([
      { kind: 'task', text: 'plain task' },
      { kind: 'approval', approvalId: requestedApproval, decision: 'approve' },
    ])
    expect(terminal.controls).toEqual([
      { command: 'model', model: 'deepseek-chat' },
      { command: 'permissions', permission: 'standard' },
      { command: 'plan' },
      { command: 'compact' },
      { command: 'resume', sessionId: sessionId('session-next') },
      { command: 'diff' },
      { command: 'terminal' },
      { command: 'doctor' },
      { command: 'exit' },
    ])
    expect(surface.events).toEqual(expect.arrayContaining([
      { kind: 'session-opened', sessionId: sessionId('session-interactive') },
      { kind: 'approval-requested', approvalId: requestedApproval, prompt: 'Approve write?' },
    ]))
    expect(surface.closed).toBe(true)
  })

  it('requires an explicit first-start migration decision before opening a terminal', async () => {
    const terminal = new FakeTerminal([])
    const client = new FakeRuntimeClient(terminal)
    client.migration = { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false }
    const surface = new FakeSurface(async function * () {
      yield { kind: 'line', line: 'import' }
      yield { kind: 'line', line: '/exit' }
    })

    const code = await runTerminalInvocation(
      { mode: 'interactive', initialTask: 'after migration' }, io(surface).io, new FakeConnector(client),
    )

    expect(code).toBe(0)
    expect(client.migrationActions).toEqual(['accept'])
    expect(surface.migrationStates).toEqual([
      { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false },
      { kind: 'imported', copied: ['sessions'] },
    ])
    expect(client.openRequests).toEqual([{ workspace: 'C:\\workspace', initialTask: 'after migration' }])
    expect(terminal.controls).toEqual([{ command: 'exit' }])
  })

  it('does not copy legacy data in non-interactive mode and emits only a normalized diagnostic', async () => {
    const client = new FakeRuntimeClient(new FakeTerminal([]))
    client.migration = { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false }
    const streams = io()

    const code = await runTerminalInvocation(
      { mode: 'run', task: 'must wait', json: true }, streams.io, new FakeConnector(client),
    )

    expect(code).toBe(5)
    expect(client.migrationActions).toEqual([])
    expect(client.openRequests).toEqual([])
    expect(streams.stdout()).toBe('')
    const diagnostic = JSON.parse(streams.stderr()) as { code: string; message: string; correction: string; diagnosticId: string }
    expect(diagnostic.code).toBe('migration-decision-required')
    expect(diagnostic.message).toContain('migration decision')
    expect(diagnostic.correction).toContain('interactive')
    expect(diagnostic.diagnosticId).toEqual(expect.any(String))
    expect(JSON.stringify(diagnostic)).not.toMatch(/C:\\|credential|token|runtime-endpoint/i)
  })

  it.each([
    [new RuntimeUnavailableError(), 3],
    [new RuntimeBusyError(sessionId('busy-session')), 4],
    [new RuntimeProtocolError(), 5],
    [new Error('raw token=private C:\\Users\\person\\Harness'), 5],
  ])('maps a typed Runtime failure to exit code %i without reflecting raw details', async (error, expectedCode) => {
    const streams = io()

    const code = await runTerminalInvocation(
      { mode: 'run', task: 'failure', json: true }, streams.io, new FakeConnector(error),
    )

    expect(code).toBe(expectedCode)
    expect(streams.stdout()).toBe('')
    expect(() => { JSON.parse(streams.stderr()) }).not.toThrow()
    expect(streams.stderr()).not.toMatch(/private|C:\\Users|token=/)
  })

  it('forces the second Ctrl+C without waiting for the first cancellation to settle', async () => {
    const terminal = new FakeTerminal([])
    terminal.cancelResult = new Promise(() => {})
    const client = new FakeRuntimeClient(terminal)
    terminal.closeResult = new Promise(() => {})
    client.closeResult = new Promise(() => {})
    const surface = new FakeSurface(async function * () {
      yield { kind: 'interrupt' }
      yield { kind: 'interrupt' }
    })
    surface.closeResult = new Promise(() => {})
    let forcedCode: number | undefined
    const streams = io(surface, { forceExit: (code) => { forcedCode = code } })

    const code = await Promise.race([
      runTerminalInvocation(
        { mode: 'interactive', initialTask: undefined }, streams.io, new FakeConnector(client),
      ),
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
    ])

    expect(code).toBe(131)
    expect(forcedCode).toBe(131)
  })

  it('forces a JSON second Ctrl+C without waiting for stalled pump or cleanup', async () => {
    const terminal = new FakeTerminal([])
    terminal.cancelResult = new Promise(() => {})
    terminal.closeResult = new Promise(() => {})
    terminal.eventsResult = new Promise(() => {})
    const client = new FakeRuntimeClient(terminal)
    client.activeResult = new Promise(() => {})
    client.closeResult = new Promise(() => {})
    async function * interrupts(): AsyncIterable<void> {
      yield undefined
      yield undefined
    }
    let forcedCode: number | undefined
    const streams = io(undefined, { interrupts: interrupts(), forceExit: (code) => { forcedCode = code } })

    const code = await Promise.race([
      runTerminalInvocation(
        { mode: 'run', task: 'force stalled JSON exit', json: true }, streams.io, new FakeConnector(client),
      ),
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
    ])

    expect(code).toBe(131)
    expect(forcedCode).toBe(131)
    expect(streams.stdout()).toBe('')
    expect(streams.stderr()).toBe('')
  })

  it('maps an interactive Runtime-unavailable event pump failure to exit 3', async () => {
    const terminal = new FakeTerminal([])
    terminal.eventsError = new RuntimeUnavailableError()
    const client = new FakeRuntimeClient(terminal)
    const surface = new FakeSurface(async function * () {
      await new Promise(() => {})
    })
    const streams = io(surface)

    const code = await Promise.race([
      runTerminalInvocation(
        { mode: 'interactive', initialTask: undefined }, streams.io, new FakeConnector(client),
      ),
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
    ])

    expect(code).toBe(3)
    expect(surface.diagnostics).toHaveLength(1)
  })

  it('maps an interactive pump failure after the action stream closes', async () => {
    const terminal = new FakeTerminal([])
    terminal.eventsError = new RuntimeUnavailableError()
    const client = new FakeRuntimeClient(terminal)
    const surface = new FakeSurface(async function * () {})
    const streams = io(surface)

    const code = await runTerminalInvocation(
      { mode: 'interactive', initialTask: undefined }, streams.io, new FakeConnector(client),
    )

    expect(code).toBe(3)
    expect(surface.diagnostics).toHaveLength(1)
  })

  it.each([
    [new RuntimeUnavailableError(), 3],
    [new RuntimeBusyError(sessionId('pump-busy-session')), 4],
    [new RuntimeProtocolError(), 5],
  ])('maps a JSON event pump failure to exit %i', async (pumpError, expectedCode) => {
    const terminal = new FakeTerminal([])
    terminal.eventsError = pumpError
    const client = new FakeRuntimeClient(terminal)
    client.activeResult = new Promise(() => {})
    const streams = io()

    const code = await runTerminalInvocation(
      { mode: 'run', task: 'pump failure', json: true }, streams.io, new FakeConnector(client),
    )

    expect(code).toBe(expectedCode)
    expect(JSON.parse(streams.stderr())).toMatchObject({ subject: 'Runtime' })
  })

  it('returns protocol/internal failure when attachment cleanup rejects', async () => {
    const terminal = new FakeTerminal([
      { kind: 'session-opened', sessionId: sessionId('cleanup-session') },
      { kind: 'output', text: 'completed before cleanup' },
    ])
    const client = new FakeRuntimeClient(terminal)
    client.closeError = new Error('private cleanup failure')
    const streams = io()

    const code = await runTerminalInvocation(
      { mode: 'run', task: 'cleanup failure', json: true }, streams.io, new FakeConnector(client),
    )

    expect(code).toBe(5)
    expect(streams.stderr()).not.toContain('private cleanup failure')
    expect(() => { JSON.parse(streams.stderr()) }).not.toThrow()
  })
})
