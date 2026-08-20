/** Interactive and JSONL terminal presentation over the shared local Runtime. */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import {
  normalizeRecoveryDiagnostic,
  RuntimeBusyError,
  RuntimeProtocolError,
  RuntimeUnavailableError,
  type LegacyMigrationState,
  type RedactedRuntimeDiagnostic,
  type RuntimeConnector,
  type SessionId,
  type TerminalConnection,
  type TerminalControlCommand,
  type TerminalProtocolEvent,
} from '@harness-desktop/dsh-host-local-runtime'
import type { InteractiveInvocation, RunInvocation } from './args.ts'
import { connectTerminalRuntime, type TerminalRuntimeClient } from './runtime-client.ts'

const EVENT_DRAIN_MS = 500
const WORK_POLL_MS = 25

/** CLI-local failure passed to a renderer for mandatory redaction. */
export type RuntimeClientError =
  | { readonly kind: 'runtime'; readonly error: unknown }
  | { readonly kind: 'migration-decision-required' }
  | { readonly kind: 'migration-state'; readonly state: Extract<LegacyMigrationState, { readonly diagnostic: unknown }> }

type TerminalDiagnostic = Omit<RedactedRuntimeDiagnostic, 'code'> & {
  readonly code: RedactedRuntimeDiagnostic['code'] | 'migration-decision-required'
}

/** Protocol renderer shared by interactive and non-interactive clients. */
export interface TerminalRenderer {
  /** @param event - already validated and secret-screened Runtime protocol event. */
  writeEvent(event: TerminalProtocolEvent): void
  /** @param error - typed local failure normalized before any output. */
  writeDiagnostic(error: RuntimeClientError): void
}

/** User actions emitted by the interactive terminal boundary. */
export type TerminalUserAction =
  | { readonly kind: 'line'; readonly line: string }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'end' }

/** Ink-owned terminal boundary; tests replace only this external terminal layer. */
export interface InteractiveTerminalSurface extends TerminalRenderer {
  /** @returns user lines, interrupts, and input closure in terminal order. */
  actions(): AsyncIterable<TerminalUserAction>
  /** @param state - durable migration state produced by the Runtime. */
  writeMigration(state: LegacyMigrationState): void
  /** Restore terminal input state and unmount the Ink renderer. */
  close(): Promise<void>
}

interface ResizableWritable extends Writable {
  columns?: number
  getColorDepth?: () => number
}

interface RawReadable extends Readable {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
}

/** Process resources used by one CLI invocation. */
export interface TerminalIO {
  readonly stdin: RawReadable
  readonly stdout: ResizableWritable
  readonly stderr: Writable
  readonly workspace: string
  readonly columns: number
  readonly colorDepth: number
  /** Test seam for the external terminal only; Runtime and orchestration remain real. */
  readonly createInteractiveSurface?: (io: TerminalIO) => Promise<InteractiveTerminalSurface>
  /** Optional signal stream used by non-interactive commands. */
  readonly interrupts?: AsyncIterable<void>
  /** Immediate process-owned forced exit used only by a second Ctrl+C. */
  readonly forceExit?: (code: 131) => void
}

/** Invocation fields accepted by the terminal path, including a programmatic resume identity. */
export type TerminalInvocation = (InteractiveInvocation | RunInvocation) & { readonly sessionId?: SessionId }

/** JSONL renderer whose stdout contains protocol events only. */
export class JsonlTerminalRenderer implements TerminalRenderer {
  constructor(private readonly stdout: Writable, private readonly stderr: Writable) {}

  writeEvent(event: TerminalProtocolEvent): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  writeDiagnostic(error: RuntimeClientError): void {
    this.stderr.write(`${JSON.stringify(normalizeClientDiagnostic(error))}\n`)
  }
}

/** Human-readable stream renderer for non-JSON task mode. */
class StreamTerminalRenderer implements TerminalRenderer {
  constructor(private readonly stdout: Writable, private readonly stderr: Writable) {}

  writeEvent(event: TerminalProtocolEvent): void {
    const line = renderEvent(event)
    if (line !== undefined) this.stdout.write(line)
  }

  writeDiagnostic(error: RuntimeClientError): void {
    writeHumanDiagnostic(this.stderr, normalizeClientDiagnostic(error))
  }
}

/** Build process-backed IO without giving the terminal client access to Runtime storage. */
export function createProcessTerminalIO(): TerminalIO {
  const interrupts = new ActionQueue<void>()
  const stdout = process.stdout as ResizableWritable
  const onSignal = () => { interrupts.push(undefined) }
  process.on('SIGINT', onSignal)
  interrupts.onClose = () => { process.off('SIGINT', onSignal) }
  return {
    stdin: process.stdin,
    stdout,
    stderr: process.stderr,
    workspace: process.cwd(),
    columns: stdout.columns ?? 80,
    colorDepth: stdout.getColorDepth?.() ?? 1,
    interrupts,
    forceExit: code => process.exit(code),
  }
}

/**
 * Run one interactive or task invocation through RuntimeConnector,
 * RuntimeClient, and TerminalConnection only.
 * @param invocation - parsed terminal product invocation.
 * @param io - process or test terminal resources.
 * @param connector - token-encapsulating shared Runtime connector.
 * @returns the exact public CLI exit code.
 */
export async function runTerminalInvocation(
  invocation: TerminalInvocation,
  io: TerminalIO,
  connector: RuntimeConnector,
): Promise<number> {
  const fallbackRenderer = invocation.mode === 'run' && invocation.json
    ? new JsonlTerminalRenderer(io.stdout, io.stderr)
    : new StreamTerminalRenderer(io.stdout, io.stderr)
  let runtime: TerminalRuntimeClient | undefined
  let terminal: TerminalConnection | undefined
  let surface: InteractiveTerminalSurface | undefined
  let actions: AsyncIterator<TerminalUserAction> | undefined
  let code = 5
  try {
    runtime = await connectTerminalRuntime(connector)
    const migration = await runtime.getLegacyMigration()
    let openTerminal = true
    if (invocation.mode === 'interactive') {
      surface = await (io.createInteractiveSurface?.(io) ?? createInkTerminalSurface(io))
      actions = surface.actions()[Symbol.asyncIterator]()
      const migrationCode = await settleInteractiveMigration(runtime, migration, surface, actions)
      if (migrationCode !== undefined) {
        code = migrationCode
        openTerminal = false
      }
    } else if (requiresMigrationDecision(migration)) {
      fallbackRenderer.writeDiagnostic(migration.kind === 'decision-required'
        ? { kind: 'migration-decision-required' }
        : { kind: 'migration-state', state: migration })
      code = 5
      openTerminal = false
    }

    if (openTerminal) {
      const initialTask = invocation.mode === 'run' ? invocation.task : invocation.initialTask
      terminal = await runtime.openTerminal({
        workspace: io.workspace,
        ...(initialTask === undefined ? {} : { initialTask }),
        ...(invocation.sessionId === undefined ? {} : { sessionId: invocation.sessionId }),
      })
      if (invocation.mode === 'interactive') {
        if (surface === undefined || actions === undefined) throw new Error('interactive terminal surface is unavailable')
        code = await runInteractive(terminal, surface, actions, io.forceExit)
      } else {
        code = await runTask(terminal, runtime, fallbackRenderer, io.interrupts)
      }
    }
  } catch (error: unknown) {
    const renderer = surface ?? fallbackRenderer
    renderer.writeDiagnostic({ kind: 'runtime', error })
    code = exitCodeFor(error)
  } finally {
    if (io.interrupts instanceof ActionQueue) io.interrupts.close()
    if (code === 131) {
      containCleanup(() => terminal?.close())
      containCleanup(() => surface?.close())
      containCleanup(() => runtime?.close())
      return code
    }
    let cleanupError: unknown
    try {
      await terminal?.close()
    } catch (error: unknown) {
      cleanupError = error
    }
    try {
      await surface?.close()
    } catch (error: unknown) {
      cleanupError ??= error
    }
    try {
      await runtime?.close()
    } catch (error: unknown) {
      cleanupError ??= error
    }
    if (cleanupError !== undefined && code === 0) {
      fallbackRenderer.writeDiagnostic({ kind: 'runtime', error: cleanupError })
      code = 5
    }
  }
  return code
}

async function settleInteractiveMigration(
  runtime: TerminalRuntimeClient,
  initial: LegacyMigrationState,
  surface: InteractiveTerminalSurface,
  actions: AsyncIterator<TerminalUserAction>,
): Promise<number | undefined> {
  let state = initial
  if (!requiresMigrationDecision(state)) return undefined
  surface.writeMigration(state)
  for (;;) {
    const next = await actions.next()
    if (next.done === true) return 0
    const action = next.value
    if (action.kind === 'interrupt') return 130
    if (action.kind === 'end') return 0
    const choice = action.line.trim().toLowerCase()
    if (choice === 'import') state = await runtime.acceptLegacyMigration()
    else if (choice === 'decline') state = await runtime.declineLegacyMigration()
    else if (choice === 'retry' && state.kind !== 'decision-required') state = await runtime.retryLegacyMigration()
    else continue
    surface.writeMigration(state)
    if (!requiresMigrationDecision(state)) return undefined
  }
}

function requiresMigrationDecision(state: LegacyMigrationState): state is
  | Extract<LegacyMigrationState, { readonly kind: 'decision-required' }>
  | Extract<LegacyMigrationState, { readonly diagnostic: unknown }> {
  return state.kind === 'decision-required' || state.kind === 'target-not-empty' || state.kind === 'failed'
}

async function runInteractive(
  terminal: TerminalConnection,
  surface: InteractiveTerminalSurface,
  actions: AsyncIterator<TerminalUserAction>,
  forceExit: TerminalIO['forceExit'],
): Promise<number> {
  let pendingApproval: Extract<TerminalProtocolEvent, { kind: 'approval-requested' }> | undefined
  const pump = pumpEvents(terminal, surface, (event) => {
    if (event.kind === 'approval-requested') pendingApproval = event
  })
  const pumpFailure = new Promise<{ readonly error: unknown }>((resolve) => {
    void pump.catch((error: unknown) => { resolve({ error }) })
  })
  let cancellation: Promise<void> | undefined
  const interrupt = (): boolean => {
    if (cancellation !== undefined) {
      return true
    }
    cancellation = terminal.cancel().then(
      () => { cancellation = undefined },
      (error: unknown) => {
        cancellation = undefined
        surface.writeDiagnostic({ kind: 'runtime', error })
      },
    )
    return false
  }
  for (;;) {
    const outcome = await Promise.race([
      actions.next().then(next => ({ kind: 'action' as const, next })),
      pumpFailure.then(({ error }) => ({ kind: 'pump-error' as const, error })),
    ])
    if (outcome.kind === 'pump-error') throw outcome.error
    const next = outcome.next
    if (next.done === true) break
    const action = next.value
    if (action.kind === 'interrupt') {
      if (interrupt()) {
        forceExit?.(131)
        return 131
      }
      continue
    }
    if (action.kind === 'end') break
    try {
      const line = action.line.trim()
      if (line.length === 0) continue
      if (pendingApproval !== undefined && (line === 'approve' || line === 'reject')) {
        await terminal.submit({
          kind: 'approval', approvalId: pendingApproval.approvalId,
          decision: line,
        })
        pendingApproval = undefined
        continue
      }
      const control = parseControl(line)
      if (control !== undefined) {
        await terminal.runControl(control)
        if (control.command === 'exit') break
      } else {
        await terminal.submit({ kind: 'task', text: line })
      }
    } catch (error: unknown) {
      surface.writeDiagnostic({ kind: 'runtime', error })
    }
  }
  await terminal.close()
  await pump
  return 0
}

async function runTask(
  terminal: TerminalConnection,
  runtime: TerminalRuntimeClient,
  renderer: TerminalRenderer,
  interrupts: AsyncIterable<void> | undefined,
): Promise<number> {
  let pumpSettled = false
  const lifecycle = { closing: false }
  const pump = pumpEvents(terminal, renderer).finally(() => { pumpSettled = true })
  const pumpExit = pump.then(
    () => 0,
    (error: unknown) => {
      if (lifecycle.closing) return 0
      renderer.writeDiagnostic({ kind: 'runtime', error })
      return exitCodeFor(error)
    },
  )
  let resolveExit!: (code: number) => void
  const exit = new Promise<number>((resolve) => { resolveExit = resolve })
  let cancellation: Promise<void> | undefined
  const monitor = interrupts === undefined ? Promise.resolve() : (async () => {
    for await (const _ of interrupts) {
      if (cancellation !== undefined) {
        resolveExit(131)
        return
      }
      cancellation = terminal.cancel().then(
        (result) => {
          cancellation = undefined
          if (result.kind === 'cancelled') resolveExit(130)
        },
        (error: unknown) => {
          cancellation = undefined
          renderer.writeDiagnostic({ kind: 'runtime', error })
          resolveExit(5)
        },
      )
    }
  })()
  const completion = (async () => {
    while (!pumpSettled) {
      if ((await runtime.observeActiveWork()).ownUiWork.length === 0) {
        await delay(EVENT_DRAIN_MS)
        return 0
      }
      await delay(WORK_POLL_MS)
    }
    return 0
  })()
  const code = await Promise.race([exit, completion, pumpExit])
  lifecycle.closing = true
  await terminal.close()
  await pump.catch(() => {})
  void monitor
  return code
}

async function pumpEvents(
  terminal: TerminalConnection,
  renderer: TerminalRenderer,
  observe?: (event: TerminalProtocolEvent) => void,
): Promise<void> {
  for await (const event of terminal.events()) {
    observe?.(event)
    renderer.writeEvent(event)
  }
}

function parseControl(line: string): TerminalControlCommand | undefined {
  const [command, ...parts] = line.split(/\s+/u)
  const argument = parts.length === 0 ? undefined : parts.join(' ')
  switch (command) {
    case '/model': return { command: 'model', ...(argument === undefined ? {} : { model: argument }) }
    case '/permissions': return { command: 'permissions', ...(argument === undefined ? {} : { permission: argument }) }
    case '/plan': return { command: 'plan' }
    case '/compact': return { command: 'compact' }
    case '/resume': return { command: 'resume', ...(argument === undefined ? {} : { sessionId: argument as SessionId }) }
    case '/diff': return { command: 'diff' }
    case '/terminal': return { command: 'terminal' }
    case '/doctor': return { command: 'doctor' }
    case '/exit': return { command: 'exit' }
    default: return undefined
  }
}

function exitCodeFor(error: unknown): 3 | 4 | 5 {
  if (error instanceof RuntimeUnavailableError) return 3
  if (error instanceof RuntimeBusyError) return 4
  return 5
}

function normalizeClientDiagnostic(error: RuntimeClientError): TerminalDiagnostic {
  if (error.kind === 'runtime') return normalizeRecoveryDiagnostic(error.error)
  if (error.kind === 'migration-state') return error.state.diagnostic
  const base = normalizeRecoveryDiagnostic(new RuntimeProtocolError('runtime-start-failed'))
  return {
    ...base,
    code: 'migration-decision-required',
    message: 'A legacy data migration decision is required before this task can run.',
    correction: 'Start Harness interactively and choose import or decline.',
  }
}

function writeHumanDiagnostic(stderr: Writable, diagnostic: TerminalDiagnostic): void {
  stderr.write(`${diagnostic.message}\n${diagnostic.correction}\nDiagnostic: ${diagnostic.diagnosticId}\n`)
}

function renderEvent(event: TerminalProtocolEvent): string | undefined {
  switch (event.kind) {
    case 'session-opened': return `Session ${event.sessionId}\n`
    case 'output': return event.text
    case 'tool-activity': return `Tool: ${event.title}\n`
    case 'approval-requested': return `${event.prompt} (approve/reject)\n`
    case 'model-changed': return `Model: ${event.model}\n`
    case 'permission-changed': return `Permissions: ${event.permission}\n`
    case 'diagnostic': return undefined
  }
}

async function createInkTerminalSurface(io: TerminalIO): Promise<InteractiveTerminalSurface> {
  const reactPackage: string = 'react'
  const inkPackage: string = 'ink'
  const React = await import(reactPackage) as {
    readonly Fragment: unknown
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  }
  const Ink = await import(inkPackage) as {
    readonly Static: unknown
    readonly Text: unknown
    render(node: unknown, options: {
      readonly stdin: NodeJS.ReadStream
      readonly stdout: NodeJS.WriteStream
      readonly stderr: NodeJS.WriteStream
      readonly exitOnCtrlC: boolean
      readonly patchConsole: boolean
    }): {
      rerender(node: unknown): void
      unmount(): void
      waitUntilExit(): Promise<void>
    }
  }
  const actions = new ActionQueue<TerminalUserAction>()
  let rows: Array<{ id: string; text: string; color?: string }> = []
  let input = ''
  let closed = false
  const color = io.colorDepth >= 4
  const App = () => React.createElement(
    React.Fragment,
    null,
    React.createElement(Ink.Static, { items: rows }, (row: { id: string; text: string; color?: string }) =>
      React.createElement(Ink.Text, { key: row.id, ...(color ? { color: row.color } : {}) }, row.text)),
    React.createElement(Ink.Text, null, `Harness> ${input}`),
  )
  const instance = Ink.render(React.createElement(App), {
    stdin: io.stdin as NodeJS.ReadStream,
    stdout: io.stdout as NodeJS.WriteStream,
    stderr: io.stderr as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const rerender = () => { instance.rerender(React.createElement(App)) }
  const append = (text: string, rowColor?: string) => {
    rows = [...rows, { id: randomUUID(), text, ...(rowColor === undefined ? {} : { color: rowColor }) }]
    rerender()
  }
  const onData = (chunk: Buffer | string) => {
    for (const character of String(chunk)) {
      if (character === '\u0003') actions.push({ kind: 'interrupt' })
      else if (character === '\u0004') actions.push({ kind: 'end' })
      else if (character === '\r' || character === '\n') {
        if (input.length > 0) actions.push({ kind: 'line', line: input })
        input = ''
        rerender()
      } else if (character === '\u007f' || character === '\b') {
        input = Array.from(input).slice(0, -1).join('')
        rerender()
      } else if (character >= ' ') {
        input += character
        rerender()
      }
    }
  }
  const onEnd = () => { actions.push({ kind: 'end' }); actions.close() }
  const onResize = () => { rerender() }
  io.stdin.setEncoding('utf8')
  io.stdin.on('data', onData)
  io.stdin.once('end', onEnd)
  io.stdout.on('resize', onResize)
  if (io.stdin.isTTY === true) io.stdin.setRawMode?.(true)
  io.stdin.resume()
  return {
    actions: () => actions,
    writeEvent(event) {
      if (event.kind === 'diagnostic') writeHumanDiagnostic(io.stderr, event.diagnostic)
      else {
        const text = renderEvent(event)
        if (text !== undefined) append(text.replace(/\n$/u, ''), event.kind === 'approval-requested' ? 'yellow' : 'cyan')
      }
    },
    writeDiagnostic(error) { writeHumanDiagnostic(io.stderr, normalizeClientDiagnostic(error)) },
    writeMigration(state) {
      switch (state.kind) {
        case 'decision-required': append('Legacy data from DSH_HOME is available. Type import or decline.', 'yellow'); break
        case 'target-not-empty':
        case 'failed': append(`${state.diagnostic.message} Type retry after correcting it.`, 'red'); break
        case 'imported': append(`Imported legacy data: ${state.copied.join(', ') || 'no supported roots'}.`, 'cyan'); break
        case 'declined': append('Legacy data import declined.', 'cyan'); break
        case 'not-needed': break
      }
    },
    async close() {
      if (closed) return
      closed = true
      actions.close()
      io.stdin.off('data', onData)
      io.stdin.off('end', onEnd)
      io.stdout.off('resize', onResize)
      if (io.stdin.isTTY === true) io.stdin.setRawMode?.(false)
      io.stdin.pause()
      const exited = instance.waitUntilExit()
      instance.unmount()
      await exited
    },
  }
}

class ActionQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{ readonly value: T }> = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  onClose: (() => void) | undefined

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push({ value })
    else waiter({ done: false, value })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onClose?.()
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.values.shift()
        if (entry !== undefined) return Promise.resolve({ done: false, value: entry.value })
        if (this.closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => { this.waiters.push(resolve) })
      },
      return: () => { this.close(); return Promise.resolve({ done: true, value: undefined }) },
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function containCleanup(cleanup: () => Promise<void> | undefined): void {
  void Promise.resolve().then(cleanup).catch(() => {})
}
