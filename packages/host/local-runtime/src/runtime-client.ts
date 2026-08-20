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
  /** @returns this attachment's ordered protocol events until close. */
  events(): AsyncIterable<TerminalProtocolEvent>
  /** @param input - task or approval submitted through the Runtime. @returns settlement after admission. */
  submit(input: TerminalInput): Promise<void>
  /** @param command - terminal control command. @returns settlement after dispatch. */
  runControl(command: TerminalControlCommand): Promise<void>
  /** @returns whether this attachment had active work to cancel. */
  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  /** Release only this terminal attachment; active work continues unless cancelled separately. */
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
  /** Release only this Dashboard attachment. */
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
  /** @param request - workspace, optional task, and optional shared session. @returns an independently retained terminal connection. */
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  /** @returns an independently retained Dashboard attachment. */
  attachDashboard(): Promise<DashboardAttachment>
  /** @returns the idempotently acquired named Web lease. */
  acquireBackgroundLease(): Promise<RuntimeLease>
  /** @returns redacted Runtime health and Web lease state. */
  status(): Promise<RuntimeStatus>
  /** @returns the now-absent named Web lease without stopping work or clients. */
  releaseBackgroundLease(): Promise<RuntimeLeaseStatus>
  /** @returns the shared durable legacy-import state. */
  getLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable result after explicitly accepting import. */
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable declined state. */
  declineLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable result after retrying a retryable import. */
  retryLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns active work owned by this UI client only. */
  observeActiveWork(): Promise<ActiveWorkStatus>
  /** @returns settlement after stopping this UI client's work only. */
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
  /** Release only this client attachment. */
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
export interface RuntimeConnectorOptions {
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
          return await attachRuntimeClient(new RuntimeWire(endpoint), clientId)
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
    return await new RuntimeWire(endpoint).control(randomUUID() as RuntimeClientId, { operation: 'status' })
  } catch (error) {
    return { kind: 'unavailable', diagnostic: normalizeRecoveryDiagnostic(error) }
  }
}

class RuntimeClientConnection implements RuntimeClient {
  private closed = false

  constructor(private readonly wire: RuntimeWire, private readonly clientId: RuntimeClientId) {}

  async openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection> {
    this.ensureOpen()
    const terminalId = randomUUID() as RuntimeClientId
    const opened = await this.wire.internal<{ readonly kind: 'opened'; readonly sessionId: SessionId }>(this.clientId, {
      operation: 'open-terminal', terminalId, request,
    })
    return new TerminalConnectionImpl(this.wire, this.clientId, terminalId, opened.sessionId)
  }

  async attachDashboard(): Promise<DashboardAttachment> {
    this.ensureOpen()
    const attachmentId = randomUUID() as RuntimeClientId
    await this.wire.internal(this.clientId, { operation: 'attach-client', attachmentId })
    let closed = false
    return {
      createBrowserHandoff: async () => {
        if (closed) throw new RuntimeProtocolError('runtime-start-failed')
        return this.wire.browserHandoff()
      },
      close: async () => {
        if (closed) return
        closed = true
        await this.wire.internal(this.clientId, { operation: 'release-client', attachmentId })
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
    this.closed = true
    await this.wire.internal(this.clientId, { operation: 'release-client', attachmentId: this.clientId })
  }

  private ensureOpen(): void {
    if (this.closed) throw new RuntimeProtocolError('runtime-start-failed')
  }
}

class TerminalConnectionImpl implements TerminalConnection {
  private closed = false
  private readonly closure = Promise.withResolvers<void>()

  constructor(
    private readonly wire: RuntimeWire,
    private readonly owner: RuntimeClientId,
    private readonly terminalId: RuntimeClientId,
    private readonly sessionId: SessionId,
  ) {}

  async * events(): AsyncIterable<TerminalProtocolEvent> {
    yield { kind: 'session-opened', sessionId: this.sessionId }
    await this.closure.promise
  }

  async submit(input: TerminalInput): Promise<void> {
    this.ensureOpen()
    await this.wire.internal(this.owner, { operation: 'submit-terminal', terminalId: this.terminalId, input })
  }

  async runControl(command: TerminalControlCommand): Promise<void> {
    this.ensureOpen()
    await this.wire.internal(this.owner, { operation: 'run-terminal-control', terminalId: this.terminalId, command })
  }

  cancel(): Promise<{ readonly kind: 'cancelled' | 'idle' }> {
    this.ensureOpen()
    return this.wire.internal(this.owner, { operation: 'cancel-terminal', terminalId: this.terminalId })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closure.resolve()
    await this.wire.internal(this.owner, { operation: 'release-client', attachmentId: this.terminalId })
  }

  private ensureOpen(): void {
    if (this.closed) throw new RuntimeProtocolError('runtime-start-failed')
  }
}

type InternalControlRequest =
  | { readonly operation: 'attach-client' | 'release-client'; readonly attachmentId: RuntimeClientId }
  | { readonly operation: 'open-terminal'; readonly terminalId: RuntimeClientId; readonly request: TerminalOpenRequest }
  | { readonly operation: 'submit-terminal'; readonly terminalId: RuntimeClientId; readonly input: TerminalInput }
  | { readonly operation: 'run-terminal-control'; readonly terminalId: RuntimeClientId; readonly command: TerminalControlCommand }
  | { readonly operation: 'cancel-terminal'; readonly terminalId: RuntimeClientId }

interface WireResponse<T> {
  readonly ok: boolean
  readonly value?: T
  readonly result?: RuntimeControlResult
}

class RuntimeWire {
  private readonly origin: string

  constructor(private readonly endpoint: PrivateEndpointRecord) {
    this.origin = `http://127.0.0.1:${String(endpoint.port)}`
  }

  control<T>(clientId: RuntimeClientId, request: RuntimeControlRequest): Promise<T> {
    return this.request<T>(CONTROL_PATH, clientId, request)
  }

  internal<T = undefined>(clientId: RuntimeClientId, request: InternalControlRequest): Promise<T> {
    return this.request<T>(INTERNAL_CONTROL_PATH, clientId, request)
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
    const value = await response.json() as Record<string, unknown>
    if (typeof value.id !== 'string' || !Number.isSafeInteger(value.expiresAt)) throw new RuntimeProtocolError()
    return {
      origin: this.origin as DashboardOrigin,
      handoff: { id: value.id as BrowserHandoffId, expiresAt: value.expiresAt as number },
    }
  }

  private async request<T>(path: string, clientId: RuntimeClientId, body: RuntimeControlRequest | InternalControlRequest): Promise<T> {
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
    const envelope = await response.json() as WireResponse<T>
    if (envelope.ok && 'value' in envelope) return envelope.value
    if (envelope.ok) return envelope.value as T
    if (envelope.result?.kind === 'session-busy') throw new RuntimeBusyError(envelope.result.sessionId)
    if (envelope.result?.kind === 'version-mismatch') throw new RuntimeProtocolError()
    throw new RuntimeUnavailableError()
  }
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
      const wire = new RuntimeWire(endpoint)
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
