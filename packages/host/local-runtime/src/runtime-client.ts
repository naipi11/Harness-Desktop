/** Public token-encapsulating Runtime connector, client, and recovery API. */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Branded } from '@harness-desktop/dsh-brand'
import { readPrivateEndpointRecord, type PrivateEndpointRecord, type RuntimeId } from './endpoint-record.ts'
import { resolveHarnessHome, type HarnessHomeInput } from './data-root.ts'

const CONTROL_PATH = '/_harness/control'
const INTERNAL_CONTROL_PATH = '/_harness/control/internal'
const HANDOFF_CONTROL_PATH = '/_harness/control/browser-handoff'
const START_TIMEOUT_MS = 30_000
const protocolRecoveryCodes = new WeakMap<RuntimeProtocolError, 'runtime-version-mismatch' | 'runtime-start-failed'>()

/** Maximum encoded bytes accepted from one authenticated Runtime control response. */
export const MAX_RUNTIME_CONTROL_RESPONSE_BYTES = 1_048_576
/** Maximum events returned in one terminal poll page. */
export const MAX_TERMINAL_EVENT_PAGE_ITEMS = 256
/** Maximum encoded bytes across one terminal poll page's events. */
export const MAX_TERMINAL_EVENT_PAGE_BYTES = 262_144
/** Maximum encoded bytes in one terminal event's human-readable string. */
export const MAX_TERMINAL_EVENT_TEXT_BYTES = 65_536

/** Opaque identity of one Runtime lifetime. */
export type { RuntimeId } from './endpoint-record.ts'
/** Opaque identity of one attached native client or child attachment. */
export type RuntimeClientId = Branded<'RuntimeClientId'>
/** Opaque identity of one shared session. */
export type SessionId = Branded<'SessionId'>
/** Stable identity of the named background lease. */
export type BackgroundLeaseId = Branded<'BackgroundLeaseId'>
/** One-time browser bootstrap identity. */
export type BrowserHandoffId = Branded<'BrowserHandoffId'>
/** Opaque approval identity emitted by a terminal connection. */
export type ApprovalId = Branded<'ApprovalId'>
/** Opaque identity of active work owned by one UI client. */
export type ActiveWorkId = Branded<'ActiveWorkId'>
/** Copyable identity for one redacted recovery diagnostic. */
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>
/** Exact public loopback Dashboard origin. */
export type DashboardOrigin = Branded<'DashboardOrigin'>

/** Inputs for opening or resuming one terminal session attachment. */
export interface TerminalOpenRequest {
  /** Absolute user workspace associated with the session. */
  readonly workspace: string
  /** Optional first task admitted as write work during open. */
  readonly initialTask?: string
  /** Optional existing shared session identity. */
  readonly sessionId?: SessionId
}

/** Events a terminal renderer may receive from one connection. */
export type TerminalProtocolEvent =
  | { readonly kind: 'session-opened'; readonly sessionId: SessionId }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'tool-activity'; readonly title: string }
  | { readonly kind: 'approval-requested'; readonly approvalId: ApprovalId; readonly prompt: string }
  | { readonly kind: 'model-changed'; readonly model: string }
  | { readonly kind: 'permission-changed'; readonly permission: string }
  | { readonly kind: 'diagnostic'; readonly diagnostic: RedactedRuntimeDiagnostic }

/** Human input accepted by one terminal connection. */
export type TerminalInput =
  | { readonly kind: 'task'; readonly text: string }
  | { readonly kind: 'approval'; readonly approvalId: ApprovalId; readonly decision: 'approve' | 'reject' }

/** Control commands accepted without changing the public connection type. */
export type TerminalControlCommand =
  | { readonly command: 'model'; readonly model?: string }
  | { readonly command: 'permissions'; readonly permission?: string }
  | { readonly command: 'plan' }
  | { readonly command: 'compact' }
  | { readonly command: 'resume'; readonly sessionId?: SessionId }
  | { readonly command: 'diff' }
  | { readonly command: 'terminal' }
  | { readonly command: 'doctor' }
  | { readonly command: 'exit' }

/** Independently retained terminal attachment; closing it never stops other clients or work. */
export interface TerminalConnection {
  /**
   * @returns real session/Agent protocol events in Runtime order until close.
   * @throws {@link RuntimeProtocolError} when a wire page is malformed and
   *   {@link RuntimeUnavailableError} when the Runtime cannot be reached.
   */
  events(): AsyncIterable<TerminalProtocolEvent>
  /**
   * @param input - task or approval submitted through the Runtime.
   * @returns settlement after the real Agent/API or approval owner accepts it;
   *   Agent completion remains observable through events and active-work state.
   *   A successful slash command has no turn: its safe text is emitted and its
   *   exact work reservation is released before this promise settles.
   * @throws {@link RuntimeBusyError} when an exact session operation is active,
   *   or a redacted Runtime error for wrong-owner, unavailable, or rejected input.
   */
  submit(input: TerminalInput): Promise<void>
  /**
   * Run one owner-checked control through its existing model, permission,
   * session, or command owner. `exit` releases only this terminal. The Runtime
   * stays retained until the operation settles.
   * @param command - terminal control command.
   * @returns settlement after the state change, command, resume, or release.
   * @throws a redacted Runtime error when the attachment is foreign, busy, the
   *   requested owner is unavailable, or the owner rejects the operation.
   */
  runControl(command: TerminalControlCommand): Promise<void>
  /**
   * Cancel only this terminal's exact admitted operation. An unclaimed message
   * is removed by id; a claimed operation is signalled with inbox preservation,
   * then only its correlated `turn/end` and Runtime-lease cleanup are awaited.
   * Foreign queued, steering, and replacement work remain independent.
   * @returns whether an active operation was cancelled.
   */
  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  /**
   * Release only this terminal attachment; active work continues unless
   * cancelled separately. Closed commits only after release succeeds, so a
   * transient rejection may be retried and concurrent closes share one flight.
   */
  close(): Promise<void>
}

/** One-time browser handoff retained only until exchange or expiry. */
export interface BrowserHandoff {
  /** Opaque form-body value. */
  readonly id: BrowserHandoffId
  /** Unix epoch milliseconds after which exchange is rejected. */
  readonly expiresAt: number
}

/** Clean Dashboard origin plus body-only browser bootstrap value. */
export interface DashboardNavigation {
  /** Exact loopback Dashboard origin without the handoff. */
  readonly origin: DashboardOrigin
  /** Value a launcher writes only into the private bootstrap document body. */
  readonly handoff: BrowserHandoff
}

/** Independently retained Dashboard attachment. */
export interface DashboardAttachment {
  /** @returns a fresh one-time body-only browser navigation. */
  createBrowserHandoff(): Promise<DashboardNavigation>
  /**
   * Release only this Dashboard attachment. Closed commits only after the
   * authenticated release succeeds; a transient rejection may be retried.
   */
  close(): Promise<void>
}

/** Launcher-owned browser transport for a private one-time bootstrap document. */
export interface BrowserHandoffTransport {
  /** @param navigation - clean origin and handoff written only to the private document body. @returns settlement after dispatch. */
  open(navigation: DashboardNavigation): Promise<void>
}

/** Token-free acknowledgement of the named Web background lease. */
export interface RuntimeLease { readonly id: BackgroundLeaseId }

/** Redacted health and named-lease state for one Runtime. */
export interface RuntimeStatus {
  /** Current lifecycle state. */
  readonly state: 'running' | 'stopping'
  /** Opaque Runtime lifetime identity. */
  readonly runtimeId: RuntimeId
  /** Exact public loopback Dashboard origin. */
  readonly dashboardOrigin: DashboardOrigin
  /** Current durable named Web lease state. */
  readonly backgroundLease: RuntimeLeaseStatus
}

/** Current state of one named background lease. */
export interface RuntimeLeaseStatus {
  /** Stable per-home lease identity. */
  readonly id: BackgroundLeaseId
  /** Whether the Runtime currently retains the lease. */
  readonly state: 'present' | 'absent'
}

/** Stable categories callers may render without inspecting raw failures. */
export type RuntimeRecoveryCode =
  | 'runtime-unavailable'
  | 'runtime-version-mismatch'
  | 'runtime-start-failed'
  | 'dashboard-unavailable'

/** Exact secret-free recovery value permitted in Node clients and Renderer IPC. */
export interface RedactedRuntimeDiagnostic {
  /** Stable recovery category. */
  readonly code: RuntimeRecoveryCode
  /** User-visible component that failed. */
  readonly subject: 'Runtime' | 'Dashboard'
  /** Safe failure summary without endpoint, token, credential, or absolute-home fields. */
  readonly message: string
  /** Safe next action. */
  readonly correction: string
  /** Copyable correlation identity. */
  readonly diagnosticId: RuntimeDiagnosticId
}

/** Shared durable legacy-import decision and redacted result. */
export type LegacyMigrationState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'decision-required'; readonly sourceLabel: 'DSH_HOME'; readonly retryable: boolean }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly copied: readonly string[] }
  | { readonly kind: 'target-not-empty'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }
  | { readonly kind: 'failed'; readonly retryable: true; readonly diagnostic: RedactedRuntimeDiagnostic }

/** Active work visible to the requesting UI owner only. */
export interface ActiveWorkStatus {
  /** Work ids owned by this UI client. */
  readonly ownUiWork: readonly ActiveWorkId[]
}

/** Result of safely stopping only the requesting UI owner's work. */
export type OwnUiWorkStopResult =
  | { readonly kind: 'stopped'; readonly work: readonly ActiveWorkId[] }
  | { readonly kind: 'none-active' }
  | { readonly kind: 'failed'; readonly diagnostic: RedactedRuntimeDiagnostic }

/** Public native-control operations; the endpoint token remains in the connector closure. */
export type RuntimeControlRequest =
  | { readonly operation: 'status' }
  | { readonly operation: 'acquire-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'release-background-lease'; readonly lease: 'web' }
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }
  | { readonly operation: 'observe-active-work' }
  | { readonly operation: 'stop-own-ui-work' }

/** Authenticated Dashboard migration operations sharing the Runtime's durable state. */
export type DashboardControlRequest =
  | { readonly operation: 'get-legacy-migration' }
  | { readonly operation: 'accept-legacy-migration' }
  | { readonly operation: 'decline-legacy-migration' }
  | { readonly operation: 'retry-legacy-migration' }

/** Redacted control failures and per-session admission response. */
export type RuntimeControlResult =
  | { readonly kind: 'not-running' }
  | { readonly kind: 'version-mismatch'; readonly diagnostic: RedactedRuntimeDiagnostic }
  | { readonly kind: 'owned-by-live-runtime'; readonly runtimeId: RuntimeId }
  | { readonly kind: 'session-busy'; readonly sessionId: SessionId; readonly options: readonly ['observe', 'new-session', 'wait'] }
  | { readonly kind: 'unavailable'; readonly diagnostic: RedactedRuntimeDiagnostic }

/** Attached Node client; each child attachment owns its own independent release. */
export interface RuntimeClient {
  /**
   * Create or resume through the composed Agent API, independently attach the
   * terminal, and admit `initialTask` as a real turn when supplied.
   * @param request - workspace, optional task, and optional shared session.
   * @returns an independently retained terminal connection after admission.
   * @throws {@link RuntimeBusyError} without retaining the attempted child when
   *   another operation owns the session.
   */
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  /** @returns an independently retained Dashboard attachment. */
  attachDashboard(): Promise<DashboardAttachment>
  /** @returns the idempotently acquired named Web lease. */
  acquireBackgroundLease(): Promise<RuntimeLease>
  /** @returns redacted Runtime health and Web lease state. */
  status(): Promise<RuntimeStatus>
  /** @returns the now-absent named Web lease without stopping work or clients. */
  releaseBackgroundLease(): Promise<RuntimeLeaseStatus>
  /** @returns the shared byte-bounded durable legacy-import state. */
  getLegacyMigration(): Promise<LegacyMigrationState>
  /**
   * Copy supported non-secret legacy roots once in the Runtime-owned migration
   * transaction and durably record the result before releasing its retainer.
   * Concurrent accepts replay a committed success; collisions/failures retain
   * both roots and return redacted retry guidance.
   */
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable declined state, or an already committed import that decline cannot overwrite. */
  declineLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable result after retrying only an exact retryable collision/failure state. */
  retryLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns active work owned by this UI client only. */
  observeActiveWork(): Promise<ActiveWorkStatus>
  /**
   * @returns settlement after cancelling this UI client's exact admitted
   *   operations, preserving unrelated inbox entries, and waiting for their
   *   correlated `turn/end` records and Runtime-lease cleanup only.
   */
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
  /**
   * Release only this client attachment. Closed commits after release succeeds;
   * a transient rejection may be retried and concurrent closes share one flight.
   */
  close(): Promise<void>
}

/** Restricted discovery and racing-start owner used unchanged by Node applications. */
export interface RuntimeConnector {
  /**
   * @param options - whether absence may start the Runtime.
   * @returns one attached client.
   * @throws {@link RuntimeUnavailableError} without side effects when no-start discovery finds no Runtime.
   */
  connect(options: { readonly start: boolean }): Promise<RuntimeClient>
}

/** Injectable connector construction inputs; endpoint parsing remains private to the implementation. */
interface RuntimeConnectorOptions {
  /** Harness-home resolution inputs evaluated without writing. */
  readonly input?: HarnessHomeInput
  /** Process starter used after absence; production launches the matching source or built Runtime bin. */
  readonly startProcess?: (home: string) => Promise<void>
  /** Bounded endpoint discovery interval after a racing start. */
  readonly startTimeoutMs?: number
}

/** Runtime absence with one secret-free correlation id. */
export class RuntimeUnavailableError extends Error {
  /** Copyable diagnostic correlation identity. */
  readonly diagnosticId = diagnosticId()

  constructor() {
    super('The local Harness Runtime is not running.')
    this.name = 'RuntimeUnavailableError'
  }
}

/** Same-session writer rejection with recovery choices carried by the wire result. */
export class RuntimeBusyError extends Error {
  /** Copyable diagnostic correlation identity. */
  readonly diagnosticId = diagnosticId()

  constructor(public readonly sessionId: SessionId) {
    super('Another client is already writing this session.')
    this.name = 'RuntimeBusyError'
  }
}

/** Incompatible or malformed local Runtime protocol response. */
export class RuntimeProtocolError extends Error {
  /** Copyable diagnostic correlation identity. */
  readonly diagnosticId = diagnosticId()

  constructor(recoveryCode: 'runtime-version-mismatch' | 'runtime-start-failed' = 'runtime-version-mismatch') {
    super('The local Harness Runtime protocol is unavailable.')
    this.name = 'RuntimeProtocolError'
    protocolRecoveryCodes.set(this, recoveryCode)
  }
}

/**
 * Convert any failure into the one token-, path-, and secret-free diagnostic type.
 * @param error - typed Runtime failure or an unknown local failure.
 * @returns stable user-facing recovery fields without reflecting raw error text.
 */
export function normalizeRecoveryDiagnostic(error: unknown): RedactedRuntimeDiagnostic {
  if (error instanceof RuntimeBusyError) {
    return {
      code: 'runtime-unavailable',
      subject: 'Runtime',
      message: 'Another client is already writing this session.',
      correction: 'Observe the active session, open a new session, or wait for the current operation to finish.',
      diagnosticId: error.diagnosticId,
    }
  }
  if (error instanceof RuntimeUnavailableError) {
    return {
      code: 'runtime-unavailable',
      subject: 'Runtime',
      message: 'The local Harness Runtime is not running.',
      correction: 'Start Harness again, or retry after the existing Runtime becomes available.',
      diagnosticId: error.diagnosticId,
    }
  }
  if (error instanceof RuntimeProtocolError) {
    const recoveryCode = protocolRecoveryCodes.get(error) ?? 'runtime-version-mismatch'
    return {
      code: recoveryCode,
      subject: 'Runtime',
      message: recoveryCode === 'runtime-version-mismatch'
        ? 'The local Harness Runtime uses an incompatible protocol version.'
        : 'The local Harness Runtime could not be started.',
      correction: recoveryCode === 'runtime-version-mismatch'
        ? 'Update Harness so the client and Runtime versions match.'
        : 'Retry startup, then use the diagnostic identifier if the failure continues.',
      diagnosticId: error.diagnosticId,
    }
  }
  return {
    code: 'runtime-start-failed',
    subject: 'Runtime',
    message: 'The local Harness Runtime operation failed.',
    correction: 'Retry the operation, then use the diagnostic identifier if the failure continues.',
    diagnosticId: diagnosticId(),
  }
}

/**
 * Create the concrete connector that alone reads private endpoint records and
 * retains their tokens inside authenticated request closures.
 * @param options - optional home, starter, and bounded-wait dependencies.
 * @returns the public racing-start connector.
 */
export function createRuntimeConnector(options: RuntimeConnectorOptions = {}): RuntimeConnector {
  const resolution = resolveHarnessHome(options.input)
  const startProcess = options.startProcess ?? startMatchingRuntimeProcess
  const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
  return {
    async connect(connectOptions) {
      const clientId = randomUUID() as RuntimeClientId
      const endpoint = await discoverEndpoint(resolution.path)
      if (endpoint !== undefined) {
        try {
          return await attachRuntimeClient(new RuntimeWire(endpoint, resolution.path), clientId)
        } catch (error) {
          if (!connectOptions.start) throw error
        }
      } else if (!connectOptions.start) {
        throw new RuntimeUnavailableError()
      }

      let startFailed = false
      try {
        await startProcess(resolution.path)
      } catch {
        startFailed = true
      }
      const wire = await waitForHealthyWire(resolution.path, clientId, timeoutMs)
      if (wire === undefined) {
        if (startFailed) throw new RuntimeProtocolError('runtime-start-failed')
        throw new RuntimeUnavailableError()
      }
      return attachRuntimeClient(wire, clientId)
    },
  }
}

/**
 * Probe an existing Runtime without starting a process or creating its home.
 * This foundation-internal status operation returns the exact typed absence and
 * redacted failure variants used by native status commands.
 * @param options - optional Harness-home resolution inputs.
 * @returns redacted Runtime status or a typed no-start control result.
 */
export async function probeRuntimeStatus(options: Pick<RuntimeConnectorOptions, 'input'> = {}): Promise<RuntimeStatus | RuntimeControlResult> {
  const resolution = resolveHarnessHome(options.input)
  let endpoint: PrivateEndpointRecord | undefined
  try {
    endpoint = await discoverEndpoint(resolution.path)
  } catch (error) {
    return { kind: 'version-mismatch', diagnostic: normalizeRecoveryDiagnostic(error) }
  }
  if (endpoint === undefined) return { kind: 'not-running' }
  try {
    return await new RuntimeWire(endpoint, resolution.path).control(randomUUID() as RuntimeClientId, { operation: 'status' })
  } catch (error) {
    return { kind: 'unavailable', diagnostic: normalizeRecoveryDiagnostic(error) }
  }
}

class RuntimeClientConnection implements RuntimeClient {
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly wire: RuntimeWire, private readonly clientId: RuntimeClientId) {}

  async openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection> {
    this.ensureOpen()
    const terminalId = randomUUID() as RuntimeClientId
    await this.wire.internal<{ readonly kind: 'opened'; readonly sessionId: SessionId }>(this.clientId, {
      operation: 'open-terminal', terminalId, request,
    })
    return new TerminalConnectionImpl(this.wire, this.clientId, terminalId)
  }

  async attachDashboard(): Promise<DashboardAttachment> {
    this.ensureOpen()
    const attachmentId = randomUUID() as RuntimeClientId
    await this.wire.internal(this.clientId, { operation: 'attach-dashboard', attachmentId })
    let closed = false
    let closing: Promise<void> | undefined
    return {
      createBrowserHandoff: async () => {
        if (closed) throw new RuntimeProtocolError('runtime-start-failed')
        return this.wire.browserHandoff()
      },
      close: async () => {
        if (closed) return
        closing ??= this.wire.internal(this.clientId, { operation: 'release-client', attachmentId }).then(
          () => { closed = true },
          (error: unknown) => { closing = undefined; throw error },
        )
        await closing
      },
    }
  }

  acquireBackgroundLease(): Promise<RuntimeLease> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'acquire-background-lease', lease: 'web' })
  }

  status(): Promise<RuntimeStatus> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'status' })
  }

  releaseBackgroundLease(): Promise<RuntimeLeaseStatus> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'release-background-lease', lease: 'web' })
  }

  getLegacyMigration(): Promise<LegacyMigrationState> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'get-legacy-migration' })
  }

  acceptLegacyMigration(): Promise<LegacyMigrationState> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'accept-legacy-migration' })
  }

  declineLegacyMigration(): Promise<LegacyMigrationState> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'decline-legacy-migration' })
  }

  retryLegacyMigration(): Promise<LegacyMigrationState> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'retry-legacy-migration' })
  }

  observeActiveWork(): Promise<ActiveWorkStatus> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'observe-active-work' })
  }

  stopOwnUiWork(): Promise<OwnUiWorkStopResult> {
    this.ensureOpen()
    return this.wire.control(this.clientId, { operation: 'stop-own-ui-work' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing ??= this.wire.internal(this.clientId, {
      operation: 'release-client', attachmentId: this.clientId,
    }).then(
      () => { this.closed = true },
      (error: unknown) => { this.closing = undefined; throw error },
    )
    await this.closing
  }

  private ensureOpen(): void {
    if (this.closed) throw new RuntimeProtocolError('runtime-start-failed')
  }
}

class TerminalConnectionImpl implements TerminalConnection {
  private closed = false
  private closing: Promise<void> | undefined

  constructor(
    private readonly wire: RuntimeWire,
    private readonly owner: RuntimeClientId,
    private readonly terminalId: RuntimeClientId,
  ) {}

  async * events(): AsyncIterable<TerminalProtocolEvent> {
    let cursor = 0
    while (!this.closed) {
      const page = await this.wire.internal<{
        readonly events: readonly TerminalProtocolEvent[]
        readonly nextCursor: number
      }>(this.owner, { operation: 'read-terminal-events', terminalId: this.terminalId, cursor })
      cursor = page.nextCursor
      for (const event of page.events) yield event
      if (page.events.length === 0) await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  async submit(input: TerminalInput): Promise<void> {
    this.ensureOpen()
    await this.wire.internal(this.owner, { operation: 'submit-terminal', terminalId: this.terminalId, input })
  }

  async runControl(command: TerminalControlCommand): Promise<void> {
    this.ensureOpen()
    await this.wire.internal(this.owner, { operation: 'run-terminal-control', terminalId: this.terminalId, command })
    if (command.command === 'exit') await this.close()
  }

  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }> {
    this.ensureOpen()
    return this.wire.internal(this.owner, { operation: 'cancel-terminal', terminalId: this.terminalId })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing ??= this.wire.internal(this.owner, {
      operation: 'release-client', attachmentId: this.terminalId,
    }).then(
      () => { this.closed = true },
      (error: unknown) => { this.closing = undefined; throw error },
    )
    await this.closing
  }

  private ensureOpen(): void {
    if (this.closed) throw new RuntimeProtocolError('runtime-start-failed')
  }
}

type InternalControlRequest =
  | { readonly operation: 'attach-client' | 'attach-dashboard' | 'release-client'; readonly attachmentId: RuntimeClientId }
  | { readonly operation: 'open-terminal'; readonly terminalId: RuntimeClientId; readonly request: TerminalOpenRequest }
  | { readonly operation: 'submit-terminal'; readonly terminalId: RuntimeClientId; readonly input: TerminalInput }
  | { readonly operation: 'run-terminal-control'; readonly terminalId: RuntimeClientId; readonly command: TerminalControlCommand }
  | { readonly operation: 'cancel-terminal'; readonly terminalId: RuntimeClientId }
  | { readonly operation: 'read-terminal-events'; readonly terminalId: RuntimeClientId; readonly cursor: number }

class RuntimeWire {
  private readonly origin: string

  constructor(
    private readonly endpoint: PrivateEndpointRecord,
    private readonly harnessHome: string,
  ) {
    this.origin = `http://127.0.0.1:${String(endpoint.port)}`
  }

  control<T>(clientId: RuntimeClientId, request: RuntimeControlRequest): Promise<T> {
    return this.request(CONTROL_PATH, clientId, request, value => parseControlSuccess(request, value)) as Promise<T>
  }

  internal<T = undefined>(clientId: RuntimeClientId, request: InternalControlRequest): Promise<T> {
    return this.request(INTERNAL_CONTROL_PATH, clientId, request, value => parseInternalSuccess(request, value)) as Promise<T>
  }

  async browserHandoff(): Promise<DashboardNavigation> {
    let response: Response
    try {
      response = await fetch(`${this.origin}${HANDOFF_CONTROL_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.endpoint.accessToken}` },
      })
    } catch {
      throw new RuntimeUnavailableError()
    }
    if (!response.ok) throw new RuntimeUnavailableError()
    const value = await readBoundedRuntimeResponseJson(response)
    assertNoPrivateRuntimeValues(value, this.endpoint.accessToken, this.harnessHome)
    if (!isRecord(value) || !hasExactKeys(value, ['id', 'expiresAt'])
      || !isOpaqueId(value.id, 32) || !isSafeTimestamp(value.expiresAt)) throw new RuntimeProtocolError()
    return {
      origin: this.origin as DashboardOrigin,
      handoff: { id: value.id as BrowserHandoffId, expiresAt: value.expiresAt },
    }
  }

  private async request(
    path: string,
    clientId: RuntimeClientId,
    body: RuntimeControlRequest | InternalControlRequest,
    parseSuccess: (value: unknown) => unknown,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.endpoint.accessToken}`,
          'content-type': 'application/json',
          'x-harness-runtime-client': clientId,
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new RuntimeUnavailableError()
    }
    if (!response.ok) throw new RuntimeUnavailableError()
    const raw = await readBoundedRuntimeResponseJson(response)
    assertNoPrivateRuntimeValues(raw, this.endpoint.accessToken, this.harnessHome)
    const envelope = parseWireEnvelope(raw)
    if (envelope.ok) return parseSuccess(envelope.value)
    const result = parseRuntimeControlResult(envelope.result)
    if (result.kind === 'session-busy') throw new RuntimeBusyError(result.sessionId)
    if (result.kind === 'version-mismatch') throw new RuntimeProtocolError()
    throw new RuntimeUnavailableError()
  }
}

type ParsedWireEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: unknown }

function parseWireEnvelope(value: unknown): ParsedWireEnvelope {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new RuntimeProtocolError()
  if (value.ok) {
    if (hasExactKeys(value, ['ok'])) return { ok: true, value: undefined }
    if (hasExactKeys(value, ['ok', 'value'])) return { ok: true, value: value.value }
    throw new RuntimeProtocolError()
  }
  if (!hasExactKeys(value, ['ok', 'result'])) throw new RuntimeProtocolError()
  return { ok: false, result: value.result }
}

function parseControlSuccess(request: RuntimeControlRequest, value: unknown): unknown {
  switch (request.operation) {
    case 'status': return parseRuntimeStatus(value)
    case 'acquire-background-lease': return parseRuntimeLease(value)
    case 'release-background-lease': return parseRuntimeLeaseStatus(value)
    case 'get-legacy-migration':
    case 'accept-legacy-migration':
    case 'decline-legacy-migration':
    case 'retry-legacy-migration':
      return parseLegacyMigrationState(value)
    case 'observe-active-work': return parseActiveWorkStatus(value)
    case 'stop-own-ui-work': return parseOwnUiWorkStopResult(value)
  }
}

function parseInternalSuccess(request: InternalControlRequest, value: unknown): unknown {
  switch (request.operation) {
    case 'attach-client':
    case 'attach-dashboard':
    case 'release-client':
      if (value !== undefined) throw new RuntimeProtocolError()
      return undefined
    case 'open-terminal':
      if (!isRecord(value) || !hasExactKeys(value, ['kind', 'sessionId'])
        || value.kind !== 'opened' || !isSessionId(value.sessionId)) throw new RuntimeProtocolError()
      return { kind: 'opened', sessionId: value.sessionId as SessionId }
    case 'submit-terminal':
    case 'run-terminal-control':
      if (!isRecord(value) || !hasExactKeys(value, ['kind']) || value.kind !== 'accepted') {
        throw new RuntimeProtocolError()
      }
      return { kind: 'accepted' }
    case 'cancel-terminal':
      if (!isRecord(value) || !hasExactKeys(value, ['kind'])
        || (value.kind !== 'cancelled' && value.kind !== 'idle')) throw new RuntimeProtocolError()
      return { kind: value.kind }
    case 'read-terminal-events': return parseTerminalEventPage(value)
  }
}

function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value) || !hasExactKeys(value, ['state', 'runtimeId', 'dashboardOrigin', 'backgroundLease'])
    || (value.state !== 'running' && value.state !== 'stopping')
    || !isOpaqueId(value.runtimeId, 8)
    || !isLoopbackOrigin(value.dashboardOrigin)) throw new RuntimeProtocolError()
  return {
    state: value.state,
    runtimeId: value.runtimeId as RuntimeId,
    dashboardOrigin: value.dashboardOrigin as DashboardOrigin,
    backgroundLease: parseRuntimeLeaseStatus(value.backgroundLease),
  }
}

function parseRuntimeLease(value: unknown): RuntimeLease {
  if (!isRecord(value) || !hasExactKeys(value, ['id']) || value.id !== 'web') throw new RuntimeProtocolError()
  return { id: value.id as BackgroundLeaseId }
}

function parseRuntimeLeaseStatus(value: unknown): RuntimeLeaseStatus {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'state']) || value.id !== 'web'
    || (value.state !== 'present' && value.state !== 'absent')) throw new RuntimeProtocolError()
  return { id: value.id as BackgroundLeaseId, state: value.state }
}

function parseLegacyMigrationState(value: unknown): LegacyMigrationState {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new RuntimeProtocolError()
  switch (value.kind) {
    case 'not-needed':
    case 'declined':
      if (!hasExactKeys(value, ['kind'])) throw new RuntimeProtocolError()
      return { kind: value.kind }
    case 'decision-required':
      if (!hasExactKeys(value, ['kind', 'sourceLabel', 'retryable'])
        || value.sourceLabel !== 'DSH_HOME' || typeof value.retryable !== 'boolean') throw new RuntimeProtocolError()
      return { kind: value.kind, sourceLabel: 'DSH_HOME', retryable: value.retryable }
    case 'imported':
      if (!hasExactKeys(value, ['kind', 'copied']) || !isRootList(value.copied)) throw new RuntimeProtocolError()
      return { kind: value.kind, copied: value.copied }
    case 'target-not-empty':
    case 'failed':
      if (!hasExactKeys(value, ['kind', 'retryable', 'diagnostic']) || value.retryable !== true) {
        throw new RuntimeProtocolError()
      }
      return { kind: value.kind, retryable: true, diagnostic: parseDiagnostic(value.diagnostic) }
    default: throw new RuntimeProtocolError()
  }
}

function parseActiveWorkStatus(value: unknown): ActiveWorkStatus {
  if (!isRecord(value) || !hasExactKeys(value, ['ownUiWork']) || !Array.isArray(value.ownUiWork)
    || value.ownUiWork.some(id => !isUuid(id))) throw new RuntimeProtocolError()
  return { ownUiWork: value.ownUiWork as ActiveWorkId[] }
}

function parseOwnUiWorkStopResult(value: unknown): OwnUiWorkStopResult {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new RuntimeProtocolError()
  if (value.kind === 'none-active' && hasExactKeys(value, ['kind'])) return { kind: 'none-active' }
  if (value.kind === 'stopped' && hasExactKeys(value, ['kind', 'work']) && Array.isArray(value.work)
    && value.work.every(isUuid)) return { kind: 'stopped', work: value.work as ActiveWorkId[] }
  if (value.kind === 'failed' && hasExactKeys(value, ['kind', 'diagnostic'])) {
    return { kind: 'failed', diagnostic: parseDiagnostic(value.diagnostic) }
  }
  throw new RuntimeProtocolError()
}

function parseRuntimeControlResult(value: unknown): RuntimeControlResult {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new RuntimeProtocolError()
  switch (value.kind) {
    case 'not-running':
      if (!hasExactKeys(value, ['kind'])) throw new RuntimeProtocolError()
      return { kind: 'not-running' }
    case 'version-mismatch':
    case 'unavailable':
      if (!hasExactKeys(value, ['kind', 'diagnostic'])) throw new RuntimeProtocolError()
      return { kind: value.kind, diagnostic: parseDiagnostic(value.diagnostic) }
    case 'owned-by-live-runtime':
      if (!hasExactKeys(value, ['kind', 'runtimeId']) || !isOpaqueId(value.runtimeId, 8)) throw new RuntimeProtocolError()
      return { kind: value.kind, runtimeId: value.runtimeId as RuntimeId }
    case 'session-busy':
      if (!hasExactKeys(value, ['kind', 'sessionId', 'options']) || !isSessionId(value.sessionId)
        || !Array.isArray(value.options) || value.options.length !== 3
        || value.options[0] !== 'observe' || value.options[1] !== 'new-session' || value.options[2] !== 'wait') {
        throw new RuntimeProtocolError()
      }
      return { kind: value.kind, sessionId: value.sessionId as SessionId, options: ['observe', 'new-session', 'wait'] }
    default: throw new RuntimeProtocolError()
  }
}

function parseDiagnostic(value: unknown): RedactedRuntimeDiagnostic {
  if (!isRecord(value) || !hasExactKeys(value, ['code', 'subject', 'message', 'correction', 'diagnosticId'])
    || !['runtime-unavailable', 'runtime-version-mismatch', 'runtime-start-failed', 'dashboard-unavailable'].includes(String(value.code))
    || (value.subject !== 'Runtime' && value.subject !== 'Dashboard')
    || !isSafeDiagnosticText(value.message) || !isSafeDiagnosticText(value.correction)
    || !isUuid(value.diagnosticId)) throw new RuntimeProtocolError()
  return value as unknown as RedactedRuntimeDiagnostic
}

/**
 * Parse one byte- and item-bounded terminal event page from the wire.
 * @param value - untrusted decoded JSON value.
 * @returns the exact public event page.
 */
export function parseTerminalEventPage(value: unknown): { readonly events: readonly TerminalProtocolEvent[]; readonly nextCursor: number } {
  if (!isRecord(value) || !hasExactKeys(value, ['events', 'nextCursor']) || !Array.isArray(value.events)
    || value.events.length > MAX_TERMINAL_EVENT_PAGE_ITEMS
    || !Number.isSafeInteger(value.nextCursor) || (value.nextCursor as number) < value.events.length
    || encodedBytes(value.events) > MAX_TERMINAL_EVENT_PAGE_BYTES) throw new RuntimeProtocolError()
  return { events: value.events.map(parseTerminalEvent), nextCursor: value.nextCursor as number }
}

function parseTerminalEvent(value: unknown): TerminalProtocolEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new RuntimeProtocolError()
  switch (value.kind) {
    case 'session-opened':
      if (!hasExactKeys(value, ['kind', 'sessionId']) || !isSessionId(value.sessionId)) throw new RuntimeProtocolError()
      return { kind: value.kind, sessionId: value.sessionId as SessionId }
    case 'output':
      if (!hasExactKeys(value, ['kind', 'text']) || !isBoundedText(value.text)) throw new RuntimeProtocolError()
      return { kind: value.kind, text: value.text }
    case 'tool-activity':
      if (!hasExactKeys(value, ['kind', 'title']) || !isBoundedText(value.title)) throw new RuntimeProtocolError()
      return { kind: value.kind, title: value.title }
    case 'approval-requested':
      if (!hasExactKeys(value, ['kind', 'approvalId', 'prompt']) || !isUuid(value.approvalId)
        || !isBoundedText(value.prompt)) throw new RuntimeProtocolError()
      return { kind: value.kind, approvalId: value.approvalId as ApprovalId, prompt: value.prompt }
    case 'model-changed':
      if (!hasExactKeys(value, ['kind', 'model']) || !isBoundedText(value.model) || value.model.length === 0) {
        throw new RuntimeProtocolError()
      }
      return { kind: value.kind, model: value.model }
    case 'permission-changed':
      if (!hasExactKeys(value, ['kind', 'permission']) || !isBoundedText(value.permission)
        || value.permission.length === 0) throw new RuntimeProtocolError()
      return { kind: value.kind, permission: value.permission }
    case 'diagnostic':
      if (!hasExactKeys(value, ['kind', 'diagnostic'])) throw new RuntimeProtocolError()
      return { kind: value.kind, diagnostic: parseDiagnostic(value.diagnostic) }
    default: throw new RuntimeProtocolError()
  }
}

/**
 * Read one response through a byte-bounded stream before UTF-8 and JSON decoding.
 * @param response - authenticated Runtime response whose body remains untrusted.
 * @returns the decoded JSON value within the protocol byte budget.
 */
export async function readBoundedRuntimeResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new RuntimeProtocolError()
  const bytes = new Uint8Array(MAX_RUNTIME_CONTROL_RESPONSE_BYTES)
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_RUNTIME_CONTROL_RESPONSE_BYTES) {
        await reader.cancel()
        throw new RuntimeProtocolError()
      }
      bytes.set(result.value, total - result.value.byteLength)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))
    return JSON.parse(text) as unknown
  } catch {
    throw new RuntimeProtocolError()
  } finally {
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isOpaqueId(value: unknown, minimum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && encodedBytes(value) <= 256
    && !value.includes('/') && !value.includes('\\')
    && !hasControlOrSpace(value)
    && !/(?:access.?token|credential|secret)/i.test(value)
}

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 32) return true
  }
  return false
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || encodedBytes(value) > 256) return false
  try {
    const origin = new URL(value)
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1'
      && origin.port.length > 0 && origin.origin === value && origin.username === '' && origin.password === ''
      && origin.search === '' && origin.hash === ''
  } catch {
    return false
  }
}

function isRootList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(root => root === 'sessions' || root === 'settings.yaml' || root === 'projects')
    && new Set(value).size === value.length
}

function isSafeDiagnosticText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && encodedBytes(value) <= 1024
    && !/(?:access.?token|bearer|credential|secret|runtime-endpoint)/i.test(value)
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && encodedBytes(value) <= MAX_TERMINAL_EVENT_TEXT_BYTES
}

function encodedBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value)
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Reject the exact endpoint token or selected home found in an untrusted decoded value.
 * Windows matching folds case and separators; every platform requires a path-component boundary.
 * @param value - decoded response value to inspect recursively.
 * @param token - exact private endpoint token.
 * @param home - selected absolute Harness home.
 * @param platform - platform whose path spelling rules apply.
 */
export function assertNoPrivateRuntimeValues(
  value: unknown,
  token: string,
  home: string,
  platform: string = process.platform,
): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const candidate = pending.pop()
    if (typeof candidate === 'string') {
      if ((token.length > 0 && candidate.includes(token)) || containsSelectedHome(candidate, home, platform)) {
        throw new RuntimeProtocolError()
      }
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) pending.push(item)
    } else if (isRecord(candidate)) {
      for (const item of Object.values(candidate)) pending.push(item)
    }
  }
}

function containsSelectedHome(value: string, home: string, platform: string): boolean {
  if (home.length === 0) return false
  const windows = platform === 'win32'
  const normalize = (input: string): string => windows ? input.replaceAll('/', '\\').toLowerCase() : input
  const separator = windows ? '\\' : '/'
  const normalizedHome = trimTrailingSeparators(normalize(home), separator, windows)
  const normalizedValue = normalize(value)
  let offset = 0
  for (;;) {
    const index = normalizedValue.indexOf(normalizedHome, offset)
    if (index === -1) return false
    const before = normalizedValue[index - 1]
    const after = normalizedValue[index + normalizedHome.length]
    const beginsAtBoundary = before === undefined || !/[\p{L}\p{N}_.-]/u.test(before)
    const endsAtBoundary = after === undefined || after === separator || /[\s"'.,;:!?()[\]{}]/u.test(after)
    if (beginsAtBoundary && endsAtBoundary) return true
    offset = index + 1
  }
}

function trimTrailingSeparators(value: string, separator: string, windows: boolean): string {
  const rootLength = windows && /^[a-z]:\\/u.test(value) ? 3 : 1
  let end = value.length
  while (end > rootLength && value[end - 1] === separator) end -= 1
  return value.slice(0, end)
}

async function discoverEndpoint(home: Branded<'HarnessHome'>): Promise<PrivateEndpointRecord | undefined> {
  try {
    return await readPrivateEndpointRecord(home)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RuntimeProtocolError()
  }
}

async function waitForHealthyWire(
  home: Branded<'HarnessHome'>,
  clientId: RuntimeClientId,
  timeoutMs: number,
): Promise<RuntimeWire | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const endpoint = await discoverEndpoint(home)
    if (endpoint !== undefined) {
      const wire = new RuntimeWire(endpoint, home)
      try {
        await wire.control<RuntimeStatus>(clientId, { operation: 'status' })
        return wire
      } catch {
        // A racing owner may still be replacing an unreachable stale endpoint.
      }
    }
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function attachRuntimeClient(wire: RuntimeWire, clientId: RuntimeClientId): Promise<RuntimeClient> {
  await wire.control<RuntimeStatus>(clientId, { operation: 'status' })
  await wire.internal(clientId, { operation: 'attach-client', attachmentId: clientId })
  return new RuntimeClientConnection(wire, clientId)
}

async function startMatchingRuntimeProcess(home: string): Promise<void> {
  const source = fileURLToPath(import.meta.url).endsWith(`${process.platform === 'win32' ? '\\' : '/'}src${process.platform === 'win32' ? '\\' : '/'}runtime-client.ts`)
  const entry = fileURLToPath(new URL(source ? './bin.ts' : './bin.js', import.meta.url))
  const args = source ? ['--import', 'tsx/esm', entry] : [entry]
  const child = spawn(process.execPath, args, {
    env: { ...process.env, HARNESS_HOME: home },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

function diagnosticId(): RuntimeDiagnosticId {
  return randomUUID() as RuntimeDiagnosticId
}
