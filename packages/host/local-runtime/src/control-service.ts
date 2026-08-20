/** Runtime-owned control state shared by native clients and authenticated Dashboard requests. */

import { randomUUID } from 'node:crypto'
import type { SessionStore } from '@harness-desktop/dsh-session'
import type { Branded } from '@harness-desktop/dsh-brand'
import {
  detectLegacyImport,
  recordLegacyImportDecision,
  type LegacyMigrationState as StoredLegacyMigrationState,
} from './legacy-import.ts'
import { RuntimeSessionBusyError, type BackgroundLease, type RuntimeHandle, type RuntimeWorkLease } from './runtime.ts'
import type {
  ActiveWorkId,
  ActiveWorkStatus,
  DashboardControlRequest,
  LegacyMigrationState,
  OwnUiWorkStopResult,
  RedactedRuntimeDiagnostic,
  RuntimeClientId,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeLease,
  RuntimeLeaseStatus,
  RuntimeStatus,
  SessionId,
  TerminalInput,
  TerminalOpenRequest,
} from './runtime-client.ts'
import type { HarnessHomeResolution } from './data-root.ts'

const WEB_LEASE_ID = 'web' as Branded<'BackgroundLeaseId'>
const BUSY_OPTIONS = ['observe', 'new-session', 'wait'] as const

interface WorkRecord {
  readonly id: ActiveWorkId
  readonly owner: RuntimeClientId
  readonly runtimeLease: RuntimeWorkLease
  readonly terminalId?: RuntimeClientId
}

interface TerminalRecord {
  readonly owner: RuntimeClientId
  readonly sessionId: SessionId
  workId?: ActiveWorkId
}

/** Dependencies for one Runtime lifetime's control state. */
export interface RuntimeControlServiceOptions {
  /** Internal Runtime lifecycle and retainer owner. */
  readonly runtime: RuntimeHandle
  /** Canonical session store used to create or resume one shared session record. */
  readonly sessions?: Pick<SessionStore, 'create' | 'get' | 'list'>
  /** Resolved writable home and optional legacy import candidate. */
  readonly resolution: HarnessHomeResolution
  /** Optional durable-state detector used to inject filesystem failures in tests. */
  readonly detectMigration?: typeof detectLegacyImport
  /** Optional durable decision operation used to inject filesystem failures in tests. */
  readonly recordMigration?: typeof recordLegacyImportDecision
}

/** Runtime control operations retained behind authenticated routes. */
export interface RuntimeControlService {
  /** Session store used by the control service, when the composition provides it. */
  readonly sessions: RuntimeControlServiceOptions['sessions']
  /** @param clientId - exact attachment identity. @returns settlement after attaching it once. */
  attachClient(clientId: RuntimeClientId): Promise<void>
  /** @param clientId - exact attachment identity. @returns settlement after releasing only that attachment. */
  releaseClient(clientId: RuntimeClientId): Promise<void>
  /** @param clientId - native caller identity. @param request - exact public native-control request. @returns redacted operation value. */
  handleNative(clientId: RuntimeClientId, request: RuntimeControlRequest): Promise<unknown>
  /** @param request - exact authenticated Dashboard migration request. @returns shared durable migration state. */
  handleDashboard(request: DashboardControlRequest): Promise<LegacyMigrationState>
  /**
   * @param owner - UI owner.
   * @param sessionId - session receiving write work.
   * @param terminalId - optional terminal attachment.
   * @returns work identity or typed busy response.
   */
  beginOwnUiWork(owner: RuntimeClientId, sessionId: SessionId, terminalId?: RuntimeClientId): Promise<BeginUiWorkResult>
  /** @param owner - requesting UI owner. @returns only that owner's active work ids. */
  observeActiveWork(owner: RuntimeClientId): Promise<ActiveWorkStatus>
  /** @param owner - requesting UI owner. @returns settlement for only that owner's work. */
  stopOwnUiWork(owner: RuntimeClientId): Promise<OwnUiWorkStopResult>
  /**
   * Settle the write admission when the authoritative session log closes a turn.
   * @param sessionId - session that published the event.
   * @param eventType - durable event discriminant.
   */
  handleSessionEvent(sessionId: SessionId, eventType: string): Promise<void>
  /**
   * @param owner - parent client.
   * @param terminalId - independently retained terminal attachment.
   * @param request - terminal open fields.
   * @returns shared session identity or busy response.
   */
  openTerminal(owner: RuntimeClientId, terminalId: RuntimeClientId, request: TerminalOpenRequest): Promise<OpenTerminalResult>
  /** @param terminalId - terminal attachment. @param input - task or approval input. @returns task admission or acknowledgement. */
  submitTerminal(terminalId: RuntimeClientId, input: TerminalInput): Promise<RuntimeControlResult | { readonly kind: 'accepted' }>
  /** @param terminalId - terminal attachment. @returns whether its active operation was cancelled. */
  cancelTerminal(terminalId: RuntimeClientId): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  /** Release every service-owned retainer after all releases settle. */
  close(): Promise<void>
}

/** Successful or busy result of starting owner-scoped UI work. */
export type BeginUiWorkResult =
  | { readonly kind: 'started'; readonly workId: ActiveWorkId }
  | Extract<RuntimeControlResult, { readonly kind: 'session-busy' }>

/** Successful or busy result of opening one terminal attachment. */
export type OpenTerminalResult =
  | { readonly kind: 'opened'; readonly sessionId: SessionId }
  | Extract<RuntimeControlResult, { readonly kind: 'session-busy' }>

/**
 * Create the single control-state owner for one Runtime lifetime.
 * @param options - Runtime, session, and durable migration dependencies.
 * @returns authenticated-route operations and ordered cleanup.
 */
export function createRuntimeControlService(options: RuntimeControlServiceOptions): RuntimeControlService {
  const clients = new Set<RuntimeClientId>()
  const work = new Map<ActiveWorkId, WorkRecord>()
  const terminals = new Map<RuntimeClientId, TerminalRecord>()
  const detectMigration = options.detectMigration ?? detectLegacyImport
  const recordMigration = options.recordMigration ?? recordLegacyImportDecision
  let webLease: BackgroundLease | undefined
  let backgroundQueue = Promise.resolve()

  const serializeBackground = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = backgroundQueue.then(operation, operation)
    backgroundQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const migration = async (operation: DashboardControlRequest['operation']): Promise<LegacyMigrationState> => {
    const current = await detectMigration(options.resolution)
    if (operation === 'get-legacy-migration') return publicMigration(current)
    if (operation === 'decline-legacy-migration') {
      return publicMigration(await recordMigration({ decision: 'declined', resolution: options.resolution }))
    }
    if (operation === 'retry-legacy-migration' && current.kind !== 'failed' && current.kind !== 'target-not-empty') {
      return publicMigration(current)
    }
    return publicMigration(await recordMigration({ decision: 'accepted', resolution: options.resolution }))
  }

  const service: RuntimeControlService = {
    sessions: options.sessions,
    async attachClient(clientId) {
      if (clients.has(clientId)) return
      await options.runtime.attachClient(clientId)
      clients.add(clientId)
    },
    async releaseClient(clientId) {
      if (!clients.delete(clientId)) return
      terminals.delete(clientId)
      await options.runtime.releaseClient(clientId)
    },
    async handleNative(clientId, request) {
      switch (request.operation) {
        case 'status':
          await backgroundQueue
          return status(options.runtime, webLease !== undefined)
        case 'acquire-background-lease':
          requireAttached(clients, clientId)
          return serializeBackground(async () => {
            webLease ??= await options.runtime.acquireBackgroundLease(clientId)
            return { id: WEB_LEASE_ID } satisfies RuntimeLease
          })
        case 'release-background-lease':
          requireAttached(clients, clientId)
          return serializeBackground(async () => {
            if (webLease !== undefined) {
              const lease = webLease
              webLease = undefined
              await options.runtime.releaseBackgroundLease(lease)
            }
            return { id: WEB_LEASE_ID, state: 'absent' } satisfies RuntimeLeaseStatus
          })
        case 'get-legacy-migration':
        case 'accept-legacy-migration':
        case 'decline-legacy-migration':
        case 'retry-legacy-migration':
          requireAttached(clients, clientId)
          return migration(request.operation)
        case 'observe-active-work':
          requireAttached(clients, clientId)
          return service.observeActiveWork(clientId)
        case 'stop-own-ui-work':
          requireAttached(clients, clientId)
          return service.stopOwnUiWork(clientId)
      }
    },
    async handleDashboard(request) {
      return migration(request.operation)
    },
    async beginOwnUiWork(owner, sessionId, terminalId) {
      requireAttached(clients, owner)
      try {
        const runtimeLease = await options.runtime.beginAgentWork(sessionId)
        const id = randomUUID() as ActiveWorkId
        work.set(id, { id, owner, runtimeLease, ...(terminalId === undefined ? {} : { terminalId }) })
        return { kind: 'started', workId: id }
      } catch (error) {
        if (error instanceof RuntimeSessionBusyError) {
          return { kind: 'session-busy', sessionId: error.sessionId, options: BUSY_OPTIONS }
        }
        throw error
      }
    },
    observeActiveWork(owner) {
      return Promise.resolve({
        ownUiWork: [...work.values()].filter(record => record.owner === owner).map(record => record.id),
      })
    },
    async stopOwnUiWork(owner) {
      const owned = [...work.values()].filter(record => record.owner === owner)
      if (owned.length === 0) return { kind: 'none-active' }
      const settled = await Promise.allSettled(owned.map(record => options.runtime.endAgentWork(record.runtimeLease)))
      const failed = settled.find(result => result.status === 'rejected')
      if (failed !== undefined) return { kind: 'failed', diagnostic: operationDiagnostic() }
      for (const record of owned) {
        work.delete(record.id)
        if (record.terminalId !== undefined) {
          const terminal = terminals.get(record.terminalId)
          if (terminal?.workId === record.id) delete terminal.workId
        }
      }
      return { kind: 'stopped', work: owned.map(record => record.id) }
    },
    async handleSessionEvent(sessionId, eventType) {
      if (eventType !== 'turn/end') return
      const completed = [...work.values()].filter(record => record.runtimeLease.session === sessionId)
      const settled = await Promise.allSettled(completed.map(record => options.runtime.endAgentWork(record.runtimeLease)))
      const errors: unknown[] = []
      for (const [index, result] of settled.entries()) {
        const record = completed[index]
        if (record === undefined) continue
        if (result.status === 'rejected') {
          errors.push(result.reason as unknown)
          continue
        }
        work.delete(record.id)
        if (record.terminalId !== undefined) {
          const terminal = terminals.get(record.terminalId)
          if (terminal?.workId === record.id) delete terminal.workId
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'host-local-runtime: session work settlement failed')
      }
    },
    async openTerminal(owner, terminalId, request) {
      requireAttached(clients, owner)
      await service.attachClient(terminalId)
      const sessionId = ensureSession(options.sessions, request)
      const terminal: TerminalRecord = { owner, sessionId }
      terminals.set(terminalId, terminal)
      if (request.initialTask !== undefined) {
        const started = await service.beginOwnUiWork(owner, sessionId, terminalId)
        if (started.kind === 'session-busy') {
          terminals.delete(terminalId)
          await service.releaseClient(terminalId)
          return started
        }
        terminal.workId = started.workId
      }
      return { kind: 'opened', sessionId }
    },
    async submitTerminal(terminalId, input) {
      const terminal = terminals.get(terminalId)
      if (terminal === undefined) throw new Error('host-local-runtime: terminal attachment is unavailable')
      if (input.kind === 'approval' || terminal.workId !== undefined) return { kind: 'accepted' }
      const started = await service.beginOwnUiWork(terminal.owner, terminal.sessionId, terminalId)
      if (started.kind === 'session-busy') return started
      terminal.workId = started.workId
      return { kind: 'accepted' }
    },
    async cancelTerminal(terminalId) {
      const terminal = terminals.get(terminalId)
      if (terminal?.workId === undefined) return { kind: 'idle' }
      const record = work.get(terminal.workId)
      delete terminal.workId
      if (record === undefined) return { kind: 'idle' }
      work.delete(record.id)
      await options.runtime.endAgentWork(record.runtimeLease)
      return { kind: 'cancelled' }
    },
    async close() {
      await backgroundQueue
      const operations: Promise<unknown>[] = []
      for (const record of work.values()) operations.push(options.runtime.endAgentWork(record.runtimeLease))
      work.clear()
      if (webLease !== undefined) operations.push(options.runtime.releaseBackgroundLease(webLease))
      webLease = undefined
      for (const clientId of clients) operations.push(options.runtime.releaseClient(clientId))
      clients.clear()
      terminals.clear()
      const settled = await Promise.allSettled(operations)
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'host-local-runtime: control service cleanup failed')
    },
  }
  return service
}

function ensureSession(sessions: RuntimeControlServiceOptions['sessions'], request: TerminalOpenRequest): SessionId {
  const requested = request.sessionId
  if (requested !== undefined) {
    if (sessions?.get(requested) === undefined) sessions?.create(requested, { meta: { cwd: request.workspace } })
    return requested
  }
  if (sessions === undefined) return `session-${randomUUID()}` as SessionId
  return sessions.create(undefined, { meta: { cwd: request.workspace } }).id
}

function requireAttached(clients: ReadonlySet<RuntimeClientId>, clientId: RuntimeClientId): void {
  if (!clients.has(clientId)) throw new Error('host-local-runtime: client attachment is unavailable')
}

function status(runtime: RuntimeHandle, hasWebLease: boolean): RuntimeStatus {
  const value = runtime.status()
  return {
    state: value.state,
    runtimeId: value.runtimeId,
    dashboardOrigin: `http://127.0.0.1:${String(value.port)}` as Branded<'DashboardOrigin'>,
    backgroundLease: { id: WEB_LEASE_ID, state: hasWebLease ? 'present' : 'absent' },
  }
}

function publicMigration(state: StoredLegacyMigrationState): LegacyMigrationState {
  switch (state.kind) {
    case 'not-needed':
    case 'declined':
      return state
    case 'decision-required':
      return { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: state.retryable }
    case 'imported':
      return { kind: 'imported', copied: state.copied }
    case 'target-not-empty':
      return { kind: 'target-not-empty', retryable: true, diagnostic: migrationDiagnostic('target-not-empty', state.diagnosticId) }
    case 'failed':
      return { kind: 'failed', retryable: true, diagnostic: migrationDiagnostic('failed', state.diagnosticId) }
  }
}

function migrationDiagnostic(
  kind: 'target-not-empty' | 'failed',
  diagnosticId: Branded<'RuntimeDiagnosticId'>,
): RedactedRuntimeDiagnostic {
  if (kind === 'target-not-empty') {
    return {
      code: 'runtime-start-failed',
      subject: 'Runtime',
      message: 'Legacy data could not be imported because the Harness home is not empty.',
      correction: 'Move the colliding target data aside, then retry the import.',
      diagnosticId,
    }
  }
  return {
    code: 'runtime-start-failed',
    subject: 'Runtime',
    message: 'Legacy data could not be imported.',
    correction: 'Correct the reported local storage problem, then retry the import.',
    diagnosticId,
  }
}

function operationDiagnostic(): RedactedRuntimeDiagnostic {
  return {
    code: 'runtime-unavailable',
    subject: 'Runtime',
    message: 'The requested Runtime operation did not finish.',
    correction: 'Retry the operation. Other clients and work remain attached.',
    diagnosticId: randomUUID() as Branded<'RuntimeDiagnosticId'>,
  }
}
