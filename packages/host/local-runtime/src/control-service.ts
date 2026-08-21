/** Runtime-owned control, real Agent operation, and attachment-ownership state. */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentRegistry } from '@harness-desktop/dsh-agent'
import type { Branded } from '@harness-desktop/dsh-brand'
import type CommandRuntime from '@harness-desktop/dsh-commands'
import type { ApiProxy, RpcId } from '@harness-desktop/dsh-host-apiproxy'
import type PermissionPresetService from '@harness-desktop/dsh-permission-presets'
import type { UserMessage } from '@harness-desktop/dsh-llm'
import type { Session, SessionEvent, SessionStore } from '@harness-desktop/dsh-session'
import {
  detectLegacyImport,
  recordLegacyImportDecision,
  type LegacyMigrationState as StoredLegacyMigrationState,
} from './legacy-import.ts'
import { RuntimeSessionBusyError, type BackgroundLease, type RuntimeHandle, type RuntimeWorkLease } from './runtime.ts'
import {
  MAX_TERMINAL_EVENT_PAGE_BYTES,
  MAX_TERMINAL_EVENT_PAGE_ITEMS,
  MAX_TERMINAL_EVENT_TEXT_BYTES,
} from './runtime-client.ts'
import type {
  ActiveWorkId,
  ActiveWorkStatus,
  ApprovalId,
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
  TerminalControlCommand,
  TerminalInput,
  TerminalOpenRequest,
  TerminalProtocolEvent,
} from './runtime-client.ts'
import type { HarnessHomeResolution } from './data-root.ts'

const WEB_LEASE_ID = 'web' as Branded<'BackgroundLeaseId'>
const BUSY_OPTIONS = ['observe', 'new-session', 'wait'] as const
const DASHBOARD_PROMPT_CORRELATION_TIMEOUT_MS = 1_000

interface ChildAttachment {
  readonly owner: RuntimeClientId
  readonly kind: 'dashboard' | 'terminal'
}

interface WorkRecord {
  readonly id: ActiveWorkId
  readonly owner: RuntimeClientId
  readonly terminalId?: RuntimeClientId
  readonly runtimeLease: RuntimeWorkLease
  readonly agent: Agent
  readonly rpcId: RpcId
  readonly finished: PromiseWithResolvers<void>
  readonly messageInserted?: PromiseWithResolvers<void>
  readonly admissionAbort?: AbortController
  messageId?: UserMessage['id']
  turn?: number
  settlement?: Promise<void>
}

interface TerminalRecord {
  readonly owner: RuntimeClientId
  agent: Agent
  readonly events: TerminalProtocolEvent[]
  model?: { readonly provider: string; readonly model: string }
  workId?: ActiveWorkId
}

interface PendingApproval {
  readonly owner: RuntimeClientId
  readonly terminalId: RuntimeClientId
  readonly resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
}

type RuntimeSessionsApi = Pick<ApiProxy['sessions'], 'create' | 'prompt' | 'models' | 'selectModel'>

/** Dependencies for one Runtime lifetime's control state. */
export interface RuntimeControlServiceOptions {
  readonly runtime: RuntimeHandle
  readonly sessions?: Pick<SessionStore, 'create' | 'get' | 'list'>
  readonly api?: { readonly sessions: RuntimeSessionsApi }
  readonly agents?: Pick<AgentRegistry, 'get'>
  readonly commands?: Pick<CommandRuntime, 'execute'>
  readonly permissionPresets?: Pick<PermissionPresetService, 'current' | 'set'>
  readonly resolution: HarnessHomeResolution
  readonly detectMigration?: typeof detectLegacyImport
  readonly recordMigration?: typeof recordLegacyImportDecision
}

/** Runtime control operations retained behind authenticated routes. */
export interface RuntimeControlService {
  readonly sessions: RuntimeControlServiceOptions['sessions']
  attachClient(clientId: RuntimeClientId): Promise<void>
  attachDashboard(owner: RuntimeClientId, attachmentId: RuntimeClientId): Promise<void>
  releaseClient(owner: RuntimeClientId, attachmentId?: RuntimeClientId): Promise<void>
  handleNative(clientId: RuntimeClientId, request: RuntimeControlRequest): Promise<unknown>
  handleDashboard(
    owner: RuntimeClientId,
    request: DashboardControlRequest,
  ): Promise<LegacyMigrationState | ActiveWorkStatus | OwnUiWorkStopResult>
  /**
   * Reserve one Dashboard-authenticated prompt before ApiProxy admission.
   * @param owner - one-way identity of the authenticated browser session.
   * @param request - validated Session and RPC correlation.
   * @returns admission settlement owned by the physical request carrier.
   */
  ownDashboardPrompt(
    owner: RuntimeClientId,
    request: { readonly sessionId: SessionId; readonly rpcId: RpcId },
  ): Promise<DashboardPromptOwnership>
  observeActiveWork(owner: RuntimeClientId): Promise<ActiveWorkStatus>
  stopOwnUiWork(owner: RuntimeClientId): Promise<OwnUiWorkStopResult>
  openTerminal(owner: RuntimeClientId, terminalId: RuntimeClientId, request: TerminalOpenRequest): Promise<OpenTerminalResult>
  submitTerminal(owner: RuntimeClientId, terminalId: RuntimeClientId, input: TerminalInput): Promise<TerminalSubmitResult>
  cancelTerminal(owner: RuntimeClientId, terminalId: RuntimeClientId): Promise<{ readonly kind: 'cancelled' | 'idle' }>
  runTerminalControl(owner: RuntimeClientId, terminalId: RuntimeClientId, command: TerminalControlCommand): Promise<void>
  readTerminalEvents(owner: RuntimeClientId, terminalId: RuntimeClientId, cursor: number): Promise<TerminalEventPage>
  /**
   * @param agent - Agent receiving the message.
   * @param message - inserted message used to correlate an unclaimed operation.
   */
  handleAgentInboxInserted(agent: Agent, message: UserMessage): void
  handleAgentInboxClaimed(agent: Agent, message: UserMessage, turn: number): void
  handleSessionEvent(session: Session, event: SessionEvent): Promise<void>
  handleApprovalRequest(request: RuntimeApprovalRequest, next: () => Promise<RuntimeApprovalOutcome>): Promise<RuntimeApprovalOutcome>
  close(): Promise<void>
}

/** Carrier-side settlement for one Dashboard prompt admission. */
export interface DashboardPromptOwnership {
  /** Abort Dashboard prompt admission when ownership is cancelled before correlation. */
  readonly signal: AbortSignal
  /** Keep ownership after the accepted prompt published its correlated inbox message. */
  commit(): Promise<void>
  /** Release ownership after a rejected, command-only, or failed API request. */
  release(): Promise<void>
}

/** Minimal approval fields borrowed from the existing approval service. */
export interface RuntimeApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Closed outcomes returned to the existing approval service. */
export type RuntimeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Successful or busy result of opening one terminal attachment. */
export type OpenTerminalResult =
  | { readonly kind: 'opened'; readonly sessionId: SessionId }
  | Extract<RuntimeControlResult, { readonly kind: 'session-busy' }>

/** Terminal task admission or exact busy response. */
export type TerminalSubmitResult =
  | { readonly kind: 'accepted' }
  | Extract<RuntimeControlResult, { readonly kind: 'session-busy' }>

/** One bounded terminal event page. */
export interface TerminalEventPage {
  readonly events: readonly TerminalProtocolEvent[]
  readonly nextCursor: number
}

/** Create the single authenticated control-state owner for one Runtime lifetime. */
export function createRuntimeControlService(options: RuntimeControlServiceOptions): RuntimeControlService {
  const clients = new Set<RuntimeClientId>()
  const children = new Map<RuntimeClientId, ChildAttachment>()
  const work = new Map<ActiveWorkId, WorkRecord>()
  // A cancelled pre-correlation prompt stays denied until its late insertion
  // arrives or the physical carrier settles; WeakMap ownership follows Agent lifetime.
  const cancelledDashboardPrompts = new WeakMap<Agent, Set<RpcId>>()
  const terminals = new Map<RuntimeClientId, TerminalRecord>()
  const approvals = new Map<ApprovalId, PendingApproval>()
  const detectMigration = options.detectMigration ?? detectLegacyImport
  const recordMigration = options.recordMigration ?? recordLegacyImportDecision
  let webLease: BackgroundLease | undefined
  let backgroundQueue = Promise.resolve()
  let migrationQueue = Promise.resolve()

  const serializeBackground = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = backgroundQueue.then(operation, operation)
    backgroundQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const serializeMigration = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = migrationQueue.then(operation, operation)
    migrationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const markCancelledDashboardPrompt = (record: WorkRecord): void => {
    const cancelled = cancelledDashboardPrompts.get(record.agent) ?? new Set<RpcId>()
    cancelled.add(record.rpcId)
    cancelledDashboardPrompts.set(record.agent, cancelled)
  }
  const clearCancelledDashboardPrompt = (record: Pick<WorkRecord, 'agent' | 'rpcId'>): void => {
    const cancelled = cancelledDashboardPrompts.get(record.agent)
    if (cancelled === undefined) return
    cancelled.delete(record.rpcId)
    if (cancelled.size === 0) cancelledDashboardPrompts.delete(record.agent)
  }
  const retainRuntime = async <T>(operation: () => Promise<T>): Promise<T> => {
    const retainer = `control-${randomUUID()}` as RuntimeClientId
    await options.runtime.attachClient(retainer)
    const outcome = await operation().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const release = await options.runtime.releaseClient(retainer).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!outcome.ok && !release.ok) {
      throw new AggregateError([outcome.error, release.error], 'host-local-runtime: control transaction and retainer release failed')
    }
    if (!outcome.ok) throw outcome.error
    if (!release.ok) throw release.error
    return outcome.value
  }
  const migration = (
    operation: 'get-legacy-migration' | 'accept-legacy-migration' | 'decline-legacy-migration' | 'retry-legacy-migration',
  ): Promise<LegacyMigrationState> =>
    serializeMigration(() => retainRuntime(async () => {
      const current = await detectMigration(options.resolution)
      if (operation === 'get-legacy-migration' || current.kind === 'imported') return publicMigration(current)
      if (operation === 'decline-legacy-migration') {
        return publicMigration(await recordMigration({ decision: 'declined', resolution: options.resolution }))
      }
      if (operation === 'retry-legacy-migration' && current.kind !== 'failed' && current.kind !== 'target-not-empty') {
        return publicMigration(current)
      }
      return publicMigration(await recordMigration({ decision: 'accepted', resolution: options.resolution }))
    }))
  const requireTerminal = (owner: RuntimeClientId, terminalId: RuntimeClientId): TerminalRecord => {
    const attachment = children.get(terminalId)
    const terminal = terminals.get(terminalId)
    if (attachment?.owner !== owner || attachment.kind !== 'terminal' || terminal?.owner !== owner) {
      throw new Error('host-local-runtime: attachment owner mismatch')
    }
    return terminal
  }
  const finishWork = (record: WorkRecord): Promise<void> => {
    if (record.settlement !== undefined) return record.settlement
    record.settlement = (async () => {
      if (work.get(record.id) !== record) return
      await options.runtime.endAgentWork(record.runtimeLease)
      if (work.get(record.id) !== record) return
      work.delete(record.id)
      if (record.terminalId !== undefined) {
        const terminal = terminals.get(record.terminalId)
        if (terminal?.workId === record.id) delete terminal.workId
      }
    })()
    void record.settlement.then(record.finished.resolve, record.finished.reject)
    return record.settlement
  }
  const cancelWork = async (record: WorkRecord): Promise<void> => {
    if (record.messageInserted !== undefined && record.messageId === undefined) {
      markCancelledDashboardPrompt(record)
      record.admissionAbort?.abort()
      return finishWork(record)
    }
    if (record.turn === undefined && record.messageId !== undefined && record.agent.inbox.remove(record.messageId)) {
      return finishWork(record)
    }
    record.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const settlement = await Promise.race([
      record.finished.promise.then(() => 'finished' as const),
      record.agent.whenIdle().then(() => 'idle' as const),
    ])
    if (settlement === 'idle' && work.get(record.id) === record) await finishWork(record)
    await record.finished.promise
  }
  const waitForDashboardMessage = async (record: WorkRecord): Promise<void> => {
    if (record.messageId !== undefined || record.messageInserted === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DASHBOARD_PROMPT_CORRELATION_TIMEOUT_MS)
    })
    try {
      await Promise.race([record.messageInserted.promise, record.finished.promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const startTask = async (owner: RuntimeClientId, terminalId: RuntimeClientId, text: string): Promise<TerminalSubmitResult> => {
    const terminal = requireTerminal(owner, terminalId)
    if (text.trim().length === 0) throw new Error('host-local-runtime: terminal task must not be empty')
    if (terminal.workId !== undefined) {
      return { kind: 'session-busy', sessionId: terminal.agent.id, options: BUSY_OPTIONS }
    }
    let runtimeLease: RuntimeWorkLease
    try {
      runtimeLease = await options.runtime.beginAgentWork(terminal.agent.id)
    } catch (error) {
      if (error instanceof RuntimeSessionBusyError) {
        return { kind: 'session-busy', sessionId: error.sessionId, options: BUSY_OPTIONS }
      }
      throw error
    }
    const id = randomUUID() as ActiveWorkId
    const rpcId = randomUUID() as RpcId
    const finished = Promise.withResolvers<void>()
    void finished.promise.catch(() => {
      // finishWork's caller observes the same lease-cleanup rejection; this
      // branch prevents an unhandled rejection when no cancellation waits.
    })
    const record: WorkRecord = { id, owner, terminalId, runtimeLease, agent: terminal.agent, rpcId, finished }
    work.set(id, record)
    terminal.workId = id
    try {
      const response = await requireApi(options).sessions.prompt({
        rpcId,
        payload: { sessionId: terminal.agent.id, mode: 'queue', content: [{ type: 'text', text }] },
      })
      if (!response.result.ok) throw new Error('host-local-runtime: Agent rejected the terminal task')
      if (response.result.value.command !== undefined) {
        const commandText = response.result.value.command.text
        if (commandText !== undefined) terminal.events.push({ kind: 'output', text: commandText })
        await finishWork(record)
      }
      return { kind: 'accepted' }
    } catch (error) {
      await finishWork(record)
      throw error
    }
  }

  const service: RuntimeControlService = {
    sessions: options.sessions,
    async attachClient(clientId) {
      if (clients.has(clientId)) return
      await options.runtime.attachClient(clientId)
      clients.add(clientId)
    },
    async attachDashboard(owner, attachmentId) {
      requireBaseClient(clients, owner)
      if (children.has(attachmentId) || clients.has(attachmentId)) throw new Error('host-local-runtime: attachment id is already live')
      await options.runtime.attachClient(attachmentId)
      children.set(attachmentId, { owner, kind: 'dashboard' })
    },
    async releaseClient(owner, requestedId) {
      const attachmentId = requestedId ?? owner
      if (attachmentId === owner) {
        requireBaseClient(clients, owner)
        await options.runtime.releaseClient(owner)
        clients.delete(owner)
        return
      }
      const attachment = children.get(attachmentId)
      if (attachment?.owner !== owner) throw new Error('host-local-runtime: attachment owner mismatch')
      await options.runtime.releaseClient(attachmentId)
      children.delete(attachmentId)
      if (attachment.kind === 'terminal') terminals.delete(attachmentId)
    },
    async handleNative(clientId, request) {
      switch (request.operation) {
        case 'status': await backgroundQueue; return status(options.runtime, webLease !== undefined)
        case 'acquire-background-lease':
          requireBaseClient(clients, clientId)
          return serializeBackground(async () => {
            webLease ??= await options.runtime.acquireBackgroundLease(clientId)
            return { id: WEB_LEASE_ID } satisfies RuntimeLease
          })
        case 'release-background-lease':
          requireBaseClient(clients, clientId)
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
          requireBaseClient(clients, clientId)
          return migration(request.operation)
        case 'observe-active-work': requireBaseClient(clients, clientId); return service.observeActiveWork(clientId)
        case 'stop-own-ui-work': requireBaseClient(clients, clientId); return service.stopOwnUiWork(clientId)
      }
    },
    handleDashboard(owner, request) {
      switch (request.operation) {
        case 'get-legacy-migration':
        case 'accept-legacy-migration':
        case 'decline-legacy-migration':
        case 'retry-legacy-migration':
          return migration(request.operation)
        case 'observe-active-work':
          return service.observeActiveWork(owner)
        case 'stop-own-ui-work':
          return service.stopOwnUiWork(owner)
      }
    },
    async ownDashboardPrompt(owner, request) {
      const agent = requireAgents(options).get(request.sessionId)
      if (agent === undefined) throw new Error('host-local-runtime: Dashboard prompt session has no live Agent')
      const runtimeLease = await options.runtime.beginAgentWork(request.sessionId)
      const finished = Promise.withResolvers<void>()
      const admissionAbort = new AbortController()
      void finished.promise.catch(() => {
        // The carrier and stop operation observe the same settlement failure.
      })
      const record: WorkRecord = {
        id: randomUUID() as ActiveWorkId,
        owner,
        runtimeLease,
        agent,
        rpcId: request.rpcId,
        finished,
        messageInserted: Promise.withResolvers<void>(),
        admissionAbort,
      }
      work.set(record.id, record)
      return {
        signal: admissionAbort.signal,
        async commit() {
          if (work.get(record.id) !== record) {
            clearCancelledDashboardPrompt(record)
            return
          }
          await waitForDashboardMessage(record)
          if (work.get(record.id) !== record) return
          if (record.messageId !== undefined) return
          await finishWork(record)
          throw new Error('host-local-runtime: accepted Dashboard prompt published no correlated message')
        },
        async release() {
          await finishWork(record)
          clearCancelledDashboardPrompt(record)
        },
      }
    },
    observeActiveWork(owner) {
      return Promise.resolve({ ownUiWork: [...work.values()].filter(record => record.owner === owner).map(record => record.id) })
    },
    async stopOwnUiWork(owner) {
      const owned = [...work.values()].filter(record => record.owner === owner)
      if (owned.length === 0) return { kind: 'none-active' }
      const settled = await Promise.allSettled(owned.map(record => cancelWork(record)))
      if (settled.some(result => result.status === 'rejected')) return { kind: 'failed', diagnostic: operationDiagnostic() }
      return { kind: 'stopped', work: owned.map(record => record.id) }
    },
    async openTerminal(owner, terminalId, request) {
      requireBaseClient(clients, owner)
      if (children.has(terminalId) || clients.has(terminalId)) throw new Error('host-local-runtime: attachment id is already live')
      const requestedSessionId = request.sessionId ?? `session-${randomUUID()}` as SessionId
      const response = await requireApi(options).sessions.create({
        rpcId: randomUUID() as RpcId,
        payload: { cwd: request.workspace, sessionId: requestedSessionId },
      })
      if (!response.result.ok) throw new Error('host-local-runtime: terminal session could not be created or resumed')
      const agent = requireAgents(options).get(response.result.value.sessionId)
      if (agent === undefined) throw new Error('host-local-runtime: terminal session has no live Agent')
      await options.runtime.attachClient(terminalId)
      children.set(terminalId, { owner, kind: 'terminal' })
      terminals.set(terminalId, { owner, agent, events: [{ kind: 'session-opened', sessionId: agent.id }] })
      if (request.initialTask !== undefined) {
        try {
          const admitted = await startTask(owner, terminalId, request.initialTask)
          if (admitted.kind === 'session-busy') {
            await options.runtime.releaseClient(terminalId)
            children.delete(terminalId)
            terminals.delete(terminalId)
            return admitted
          }
        } catch (error) {
          await options.runtime.releaseClient(terminalId)
          children.delete(terminalId)
          terminals.delete(terminalId)
          throw error
        }
      }
      return { kind: 'opened', sessionId: agent.id }
    },
    async submitTerminal(owner, terminalId, input) {
      requireTerminal(owner, terminalId)
      if (input.kind === 'approval') {
        const pending = approvals.get(input.approvalId)
        if (pending?.owner !== owner || pending.terminalId !== terminalId) throw new Error('host-local-runtime: approval owner mismatch')
        approvals.delete(input.approvalId)
        pending.resolve(input.decision === 'approve' ? 'allowed-once' : 'rejected')
        return { kind: 'accepted' }
      }
      return startTask(owner, terminalId, input.text)
    },
    async cancelTerminal(owner, terminalId) {
      const terminal = requireTerminal(owner, terminalId)
      if (terminal.workId === undefined) return { kind: 'idle' }
      const record = work.get(terminal.workId)
      if (record === undefined || record.owner !== owner) return { kind: 'idle' }
      await cancelWork(record)
      return { kind: 'cancelled' }
    },
    runTerminalControl(owner, terminalId, command) {
      return retainRuntime(async () => {
        const terminal = requireTerminal(owner, terminalId)
        if (command.command === 'exit') return
        if (command.command === 'resume') {
          if (terminal.workId !== undefined) throw new Error('host-local-runtime: terminal session is busy')
          const cwd = terminal.agent.session.header.cwd
          if (cwd === undefined) throw new Error('host-local-runtime: terminal session has no workspace')
          const sessionId = command.sessionId ?? terminal.agent.id
          const response = await requireApi(options).sessions.create({
            rpcId: randomUUID() as RpcId, payload: { cwd, sessionId },
          })
          if (!response.result.ok) throw new Error('host-local-runtime: terminal session could not be resumed')
          const agent = requireAgents(options).get(response.result.value.sessionId)
          if (agent === undefined) throw new Error('host-local-runtime: resumed session has no live Agent')
          terminal.agent = agent
          delete terminal.model
          terminal.events.push({ kind: 'session-opened', sessionId: agent.id })
          return
        }
        if (command.command === 'model') {
          const api = requireApi(options)
          const current = terminal.model ?? currentModel(terminal.agent)
          const model = command.model ?? current.model
          if (command.model !== undefined) {
            const selected = await api.sessions.selectModel({
              rpcId: randomUUID() as RpcId,
              payload: { sessionId: terminal.agent.id, provider: current.provider, model },
            })
            if (!selected.result.ok) throw new Error('host-local-runtime: model selection failed')
          }
          terminal.model = { provider: current.provider, model }
          terminal.events.push({ kind: 'model-changed', model })
          return
        }
        if (command.command === 'permissions') {
          if (options.permissionPresets === undefined) throw new Error('host-local-runtime: permission presets are unavailable')
          if (command.permission === undefined) {
            terminal.events.push({
              kind: 'permission-changed',
              permission: options.permissionPresets.current(terminal.agent.session.events),
            })
            return
          }
          options.permissionPresets.set(terminal.agent.session, command.permission)
          return
        }
        const line = controlCommandLine(command)
        const commands = commandRuntime(options, terminal.agent)
        if (line === undefined || commands === undefined) throw new Error('host-local-runtime: terminal control is unavailable')
        const execution = await commands.execute(terminal.agent, line, new AbortController().signal)
        if (execution === undefined || execution.result.kind === 'error') throw new Error('host-local-runtime: terminal control was rejected')
        if (execution.result.text !== undefined) terminal.events.push({ kind: 'output', text: execution.result.text })
      })
    },
    readTerminalEvents(owner, terminalId, cursor) {
      const terminal = requireTerminal(owner, terminalId)
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > terminal.events.length) throw new Error('host-local-runtime: terminal event cursor is invalid')
      const events: TerminalProtocolEvent[] = []
      let bytes = 2
      for (let index = cursor; index < terminal.events.length && events.length < MAX_TERMINAL_EVENT_PAGE_ITEMS; index += 1) {
        const event = terminal.events[index]
        if (event === undefined) break
        const eventBytes = Buffer.byteLength(JSON.stringify(event))
        if (terminalEventTextBytes(event) > MAX_TERMINAL_EVENT_TEXT_BYTES || eventBytes + 2 > MAX_TERMINAL_EVENT_PAGE_BYTES) {
          throw new Error('host-local-runtime: terminal event exceeds the protocol byte limit')
        }
        const separator = events.length === 0 ? 0 : 1
        if (bytes + separator + eventBytes > MAX_TERMINAL_EVENT_PAGE_BYTES) break
        bytes += separator + eventBytes
        events.push(event)
      }
      return Promise.resolve({ events, nextCursor: cursor + events.length })
    },
    handleAgentInboxInserted(agent, message) {
      const rpcId = messageRpcId(message)
      if (rpcId === undefined) return
      if (cancelledDashboardPrompts.get(agent)?.has(rpcId) === true) {
        agent.inbox.remove(message.id)
        clearCancelledDashboardPrompt({ agent, rpcId })
        return
      }
      for (const record of work.values()) {
        if (record.agent === agent && record.rpcId === rpcId && record.messageId === undefined) {
          record.messageId = message.id
          record.messageInserted?.resolve()
          return
        }
      }
    },
    handleAgentInboxClaimed(agent, message, turn) {
      const rpcId = messageRpcId(message)
      if (rpcId === undefined) return
      for (const record of work.values()) {
        if (record.agent === agent && record.rpcId === rpcId && record.turn === undefined) {
          record.turn = turn
          return
        }
      }
    },
    async handleSessionEvent(session, event) {
      for (const terminal of terminals.values()) publishSessionEvent(terminal, session, event)
      if (event.type !== 'turn/end') return
      const matching = [...work.values()].filter(record => record.agent.session === session && record.turn === event.data.turn)
      await Promise.all(matching.map(record => finishWork(record)))
    },
    handleApprovalRequest(request, next) {
      const record = [...work.values()].find(candidate => candidate.agent === request.agent)
      if (record === undefined) return next()
      const terminalId = record.terminalId
      if (terminalId === undefined) return next()
      const terminal = terminals.get(terminalId)
      if (terminal === undefined || terminal.owner !== record.owner) return next()
      const approvalId = randomUUID() as ApprovalId
      terminal.events.push({ kind: 'approval-requested', approvalId, prompt: request.reason ?? `Approve ${request.toolName}?` })
      return new Promise<RuntimeApprovalOutcome>((resolve) => {
        const settle = (outcome: 'allowed-once' | 'rejected' | 'cancelled') => {
          request.signal?.removeEventListener('abort', onAbort)
          approvals.delete(approvalId)
          resolve(outcome)
        }
        const onAbort = () => { settle('cancelled') }
        approvals.set(approvalId, { owner: record.owner, terminalId, resolve: settle })
        request.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    async close() {
      await Promise.all([backgroundQueue, migrationQueue])
      for (const pending of approvals.values()) pending.resolve('cancelled')
      approvals.clear()
      const records = [...work.values()]
      const operations: Promise<unknown>[] = records.map(record => cancelWork(record))
      if (webLease !== undefined) operations.push(options.runtime.releaseBackgroundLease(webLease))
      for (const childId of children.keys()) operations.push(options.runtime.releaseClient(childId))
      for (const clientId of clients) operations.push(options.runtime.releaseClient(clientId))
      const settled = await Promise.allSettled(operations)
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'host-local-runtime: control service cleanup failed')
      webLease = undefined
      children.clear()
      clients.clear()
      terminals.clear()
    },
  }
  return service
}

function currentModel(agent: Agent): { readonly provider: string; readonly model: string } {
  const header = agent.session.events.findLast(event => event.type === 'request/header')
  const provider = header?.data.header.config.provider ?? agent.options.provider
  const model = header?.data.header.config.model ?? agent.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('host-local-runtime: model selection is unavailable')
  }
  return { provider, model }
}

function requireApi(options: RuntimeControlServiceOptions): { readonly sessions: RuntimeSessionsApi } {
  if (options.api === undefined) throw new Error('host-local-runtime: composed Agent API is unavailable')
  return options.api
}

function commandRuntime(
  options: RuntimeControlServiceOptions,
  agent: Agent,
): Pick<CommandRuntime, 'execute'> | undefined {
  const scoped = agent.ctx.get('commands') as Pick<CommandRuntime, 'execute'> | undefined
  if (scoped !== undefined) return scoped
  try {
    return agent.ctx.commands
  } catch {
    return options.commands
  }
}

function requireAgents(options: RuntimeControlServiceOptions): Pick<AgentRegistry, 'get'> {
  if (options.agents === undefined) throw new Error('host-local-runtime: composed Agent registry is unavailable')
  return options.agents
}

function requireBaseClient(clients: ReadonlySet<RuntimeClientId>, clientId: RuntimeClientId): void {
  if (!clients.has(clientId)) throw new Error('host-local-runtime: client attachment is unavailable')
}

function messageRpcId(message: UserMessage): RpcId | undefined {
  const source = message.source as { kind?: unknown; rpcId?: unknown }
  return source.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId as RpcId : undefined
}

function publishSessionEvent(terminal: TerminalRecord, session: Session, event: SessionEvent): void {
  if (terminal.agent.session !== session) return
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
    terminal.events.push({ kind: 'output', text: event.data.chunk.text })
  } else if (event.type === 'tool/call') {
    terminal.events.push({ kind: 'tool-activity', title: event.data.name })
  } else if (event.type === 'permission/preset') {
    terminal.events.push({ kind: 'permission-changed', permission: event.data.preset })
  } else if (event.type === 'request/header') {
    terminal.model = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    }
    terminal.events.push({ kind: 'model-changed', model: event.data.header.config.model })
  }
}

function terminalEventTextBytes(event: TerminalProtocolEvent): number {
  switch (event.kind) {
    case 'output': return Buffer.byteLength(event.text)
    case 'tool-activity': return Buffer.byteLength(event.title)
    case 'approval-requested': return Buffer.byteLength(event.prompt)
    case 'model-changed': return Buffer.byteLength(event.model)
    case 'permission-changed': return Buffer.byteLength(event.permission)
    case 'session-opened':
    case 'diagnostic': return 0
  }
}

function controlCommandLine(command: TerminalControlCommand): string | undefined {
  switch (command.command) {
    case 'plan': return '/plan'
    case 'compact': return '/compact'
    case 'diff': return '/diff'
    case 'terminal': return '/terminal'
    case 'doctor': return '/doctor'
    case 'model':
    case 'permissions':
    case 'resume':
    case 'exit': return undefined
  }
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
    case 'declined': return state
    case 'decision-required': return { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: state.retryable }
    case 'imported': return { kind: 'imported', copied: state.copied }
    case 'target-not-empty': return { kind: 'target-not-empty', retryable: true, diagnostic: migrationDiagnostic('target-not-empty', state.diagnosticId) }
    case 'failed': return { kind: 'failed', retryable: true, diagnostic: migrationDiagnostic('failed', state.diagnosticId) }
  }
}

function migrationDiagnostic(kind: 'target-not-empty' | 'failed', diagnosticId: Branded<'RuntimeDiagnosticId'>): RedactedRuntimeDiagnostic {
  if (kind === 'target-not-empty') {
    return {
      code: 'runtime-start-failed', subject: 'Runtime',
      message: 'Legacy data could not be imported because the Harness home is not empty.',
      correction: 'Move the colliding target data aside, then retry the import.', diagnosticId,
    }
  }
  return {
    code: 'runtime-start-failed', subject: 'Runtime', message: 'Legacy data could not be imported.',
    correction: 'Correct the reported local storage problem, then retry the import.', diagnosticId,
  }
}

function operationDiagnostic(): RedactedRuntimeDiagnostic {
  return {
    code: 'runtime-unavailable', subject: 'Runtime',
    message: 'The requested Runtime operation did not finish.',
    correction: 'Retry the operation. Other clients and work remain attached.',
    diagnosticId: randomUUID() as Branded<'RuntimeDiagnosticId'>,
  }
}
