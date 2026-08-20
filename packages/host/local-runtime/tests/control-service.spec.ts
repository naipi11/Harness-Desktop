/** Runtime control ownership, durable migration, and session-write admission. */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import type { Branded } from '@harness-desktop/dsh-brand'
import SessionStore, { SessionId as makeSessionId } from '@harness-desktop/dsh-session'
import type { Agent } from '@harness-desktop/dsh-agent'
import type { UserMessage } from '@harness-desktop/dsh-llm'
import WebServer from '@harness-desktop/dsh-host-webserver'
import {
  createRuntimeControlService,
  type RuntimeControlService,
  type RuntimeControlServiceOptions,
} from '../src/control-service.ts'
import { createLocalRuntimePlugin, resolveHarnessHome } from '../src/data-root.ts'
import { startRuntime, type RuntimeHandle } from '../src/runtime.ts'

let root: string | undefined
let runtime: RuntimeHandle | undefined
let control: RuntimeControlService | undefined

afterEach(async () => {
  if (control !== undefined) await control.close()
  control = undefined
  await runtime?.dispose()
  runtime = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function client(id: string): Branded<'RuntimeClientId'> {
  return id as Branded<'RuntimeClientId'>
}

async function start(
  legacyDshHome?: string,
  overrides: Partial<RuntimeControlServiceOptions> = {},
  lifecycle: {
    readonly scheduleIdle?: (callback: () => Promise<void>) => ReturnType<typeof setTimeout>
    readonly cancelIdle?: (handle: ReturnType<typeof setTimeout>) => void
  } = {},
): Promise<{ sessions: SessionStore; home: string; agents: Map<string, Agent> }> {
  root ??= await mkdtemp(join(tmpdir(), 'harness-runtime-control-service-'))
  const home = join(root, 'home')
  const provider = createLocalRuntimePlugin({ env: { HARNESS_HOME: home }, homeDir: root })
  let sessions!: SessionStore
  runtime = await startRuntime({
    harnessHome: provider,
    idleTimeoutMs: 60_000,
    ...lifecycle,
    async boot() {
      const ctx = new Context()
      await ctx.plugin(SessionStore).await()
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
      sessions = ctx.sessions
      return ctx
    },
  })
  const fakeAgents = new Map<string, Agent>()
  const fakeApi: NonNullable<RuntimeControlServiceOptions['api']> = {
    sessions: {
      async create(request) {
        const sessionId = request.payload.sessionId
        const cwd = request.payload.cwd
        if (sessionId === undefined || cwd === undefined) throw new Error('test Runtime requires an explicit session and cwd')
        let session = sessions.get(sessionId)
        if (session === undefined) session = sessions.create(sessionId, { meta: { cwd } })
        if (!fakeAgents.has(session.id)) {
          const nextTurn: UserMessage[] = []
          const nextStep: UserMessage[] = []
          fakeAgents.set(session.id, {
            id: session.id,
            session,
            status: 'running',
            options: {},
            inbox: {
              nextTurn,
              nextStep,
              remove(messageId: UserMessage['id']) {
                for (const queue of [nextTurn, nextStep]) {
                  const index = queue.findIndex(message => message.id === messageId)
                  if (index !== -1) {
                    queue.splice(index, 1)
                    return true
                  }
                }
                return false
              },
            } as never,
            ctx: {} as never,
            cancel() {},
            whenIdle: () => Promise.resolve(),
            runMaintenance: () => Promise.reject(new Error('not used')),
            send() {},
            followup() {},
            steer() {},
            inject() {},
          })
        }
        return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId: session.id } } }
      },
      async prompt(request) {
        const agent = fakeAgents.get(request.payload.sessionId)
        if (agent === undefined) throw new Error('test Runtime requires a live Agent')
        const message = {
          id: `message-${String(request.rpcId)}`,
          role: 'user',
          content: request.payload.content,
          source: { kind: 'user', rpcId: request.rpcId },
        } as UserMessage
        ;(agent.inbox.nextTurn as UserMessage[]).push(message)
        control?.handleAgentInboxInserted(agent, message)
        return { rpcId: request.rpcId, result: { ok: true as const, value: { accepted: true as const } } }
      },
      async models(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true as const,
            value: { current: { provider: 'test', model: 'test' }, routable: true, groups: [], failures: [] },
          },
        }
      },
      async selectModel(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true as const,
            value: { selected: { provider: request.payload.provider, model: request.payload.model } },
          },
        }
      },
    },
  }
  const fakeAgentRegistry: NonNullable<RuntimeControlServiceOptions['agents']> = {
    get: id => fakeAgents.get(id),
  }
  control = createRuntimeControlService({
    runtime,
    sessions,
    api: fakeApi,
    agents: fakeAgentRegistry,
    resolution: {
      ...resolveHarnessHome({ env: { HARNESS_HOME: home, DSH_HOME: legacyDshHome }, homeDir: root }),
      legacyDshHome,
    },
    ...overrides,
  })
  return { sessions, home, agents: fakeAgents }
}

describe('Runtime control service', () => {
  it('rejects a second writer for one live session without creating another session record', async () => {
    const { sessions } = await start()
    const first = client('first-client')
    const second = client('second-client')
    const sessionId = makeSessionId('shared-session')
    await control!.attachClient(first)
    await control!.attachClient(second)
    const firstTerminal = client('first-terminal')
    const secondTerminal = client('second-terminal')
    const admitted = await control!.openTerminal(first, firstTerminal, {
      workspace: root!, sessionId, initialTask: 'first task',
    })
    const busy = await control!.openTerminal(second, secondTerminal, {
      workspace: root!, sessionId, initialTask: 'second task',
    })

    expect(admitted).toEqual({ kind: 'opened', sessionId })
    expect(busy).toEqual({
      kind: 'session-busy',
      sessionId,
      options: ['observe', 'new-session', 'wait'],
    })
    await expect(control!.releaseClient(second, secondTerminal)).rejects.toThrow('attachment owner')
    expect(sessions.list().map(session => session.id)).toEqual([sessionId])
  })

  it('keeps one named Web lease while preserving clients and active work on idempotent release', async () => {
    await start()
    const first = client('lease-first')
    const second = client('lease-second')
    const sessionId = makeSessionId('lease-session')
    await control!.attachClient(first)
    await control!.attachClient(second)
    await control!.openTerminal(first, client('lease-terminal'), {
      workspace: root!, sessionId, initialTask: 'retained work',
    })

    const [firstLease, secondLease] = await Promise.all([
      control!.handleNative(first, { operation: 'acquire-background-lease', lease: 'web' }),
      control!.handleNative(second, { operation: 'acquire-background-lease', lease: 'web' }),
    ])
    expect(firstLease).toEqual({ id: 'web' })
    expect(secondLease).toEqual(firstLease)

    expect(await control!.handleNative(second, { operation: 'release-background-lease', lease: 'web' }))
      .toEqual({ id: 'web', state: 'absent' })
    expect(runtime!.status().backgroundLeaseCount).toBe(0)
    expect(await control!.handleNative(second, { operation: 'release-background-lease', lease: 'web' }))
      .toEqual({ id: 'web', state: 'absent' })
    expect((await control!.observeActiveWork(first)).ownUiWork).toHaveLength(1)
    expect(runtime!.status().state).toBe('running')
  })

  it('observes and stops only the requesting client UI work', async () => {
    await start()
    const first = client('ui-first')
    const second = client('ui-second')
    const firstSession = makeSessionId('ui-first-session')
    const secondSession = makeSessionId('ui-second-session')
    await control!.attachClient(first)
    await control!.attachClient(second)
    await control!.openTerminal(first, client('ui-first-terminal'), {
      workspace: root!, sessionId: firstSession, initialTask: 'first work',
    })
    await control!.openTerminal(second, client('ui-second-terminal'), {
      workspace: root!, sessionId: secondSession, initialTask: 'second work',
    })
    const [firstWork] = (await control!.observeActiveWork(first)).ownUiWork
    const [secondWork] = (await control!.observeActiveWork(second)).ownUiWork
    if (firstWork === undefined || secondWork === undefined) throw new Error('expected distinct work admissions')

    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [firstWork] })
    expect(await control!.stopOwnUiWork(first)).toEqual({ kind: 'stopped', work: [firstWork] })
    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [] })
    expect(await control!.observeActiveWork(second)).toEqual({ ownUiWork: [secondWork] })
  })

  it('rejects cross-owner child attachment operations without releasing the victim', async () => {
    await start()
    const owner = client('attachment-owner')
    const attacker = client('attachment-attacker')
    const dashboard = client('owned-dashboard')
    const terminal = client('owned-terminal')
    await control!.attachClient(owner)
    await control!.attachClient(attacker)
    await control!.attachDashboard(owner, dashboard)
    await control!.openTerminal(owner, terminal, { workspace: root! })

    await expect(control!.releaseClient(attacker, dashboard)).rejects.toThrow('attachment owner')
    await expect(control!.releaseClient(attacker, terminal)).rejects.toThrow('attachment owner')
    await expect(control!.submitTerminal(attacker, terminal, { kind: 'task', text: 'hijack' }))
      .rejects.toThrow('attachment owner')
    await expect(control!.cancelTerminal(attacker, terminal)).rejects.toThrow('attachment owner')

    await control!.releaseClient(owner, dashboard)
    await control!.releaseClient(owner, terminal)
  })

  it('routes approval only to the terminal that owns the exact active Agent operation', async () => {
    const { agents } = await start()
    const owner = client('approval-owner')
    const attacker = client('approval-attacker')
    const terminal = client('approval-terminal')
    const sessionId = makeSessionId('approval-session')
    await control!.attachClient(owner)
    await control!.attachClient(attacker)
    await control!.openTerminal(owner, terminal, {
      workspace: root!, sessionId, initialTask: 'operation that asks approval',
    })
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error('expected live approval Agent')

    let delegated = 0
    const outcome = control!.handleApprovalRequest({
      agent, toolName: 'write', reason: 'approve exact write',
    }, () => { delegated += 1; return Promise.resolve('unavailable') })
    const page = await control!.readTerminalEvents(owner, terminal, 0)
    const approval = page.events.find(event => event.kind === 'approval-requested')
    if (approval?.kind !== 'approval-requested') throw new Error('expected approval request event')
    await expect(control!.submitTerminal(attacker, terminal, {
      kind: 'approval', approvalId: approval.approvalId, decision: 'approve',
    })).rejects.toThrow('attachment owner')
    await control!.submitTerminal(owner, terminal, {
      kind: 'approval', approvalId: approval.approvalId, decision: 'approve',
    })

    await expect(outcome).resolves.toBe('allowed-once')
    expect(delegated).toBe(0)
  })

  it('cancels with no-clear semantics and preserves unrelated queued and steering work', async () => {
    const { agents } = await start()
    const owner = client('cancel-owner')
    const terminal = client('cancel-terminal')
    const sessionId = makeSessionId('cancel-session')
    await control!.attachClient(owner)
    await control!.openTerminal(owner, terminal, {
      workspace: root!, sessionId, initialTask: 'exact active operation',
    })
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error('expected live cancel Agent')
    const ownedMessage = agent.inbox.nextTurn[0]
    if (ownedMessage === undefined) throw new Error('expected the owned pending message')
    expect(agent.inbox.remove(ownedMessage.id)).toBe(true)
    control!.handleAgentInboxClaimed(agent, ownedMessage, 1)
    const foreignTurn = { id: 'foreign-turn' }
    const foreignStep = { id: 'foreign-step' }
    const inbox = agent.inbox as unknown as { nextTurn: unknown[]; nextStep: unknown[] }
    inbox.nextTurn = [foreignTurn]
    inbox.nextStep = [foreignStep]
    let keepInbox: boolean | undefined
    ;(agent as unknown as { cancel: (_cause: unknown, options?: { keepInbox?: boolean }) => void }).cancel = (_cause, options) => {
      keepInbox = options?.keepInbox
      if (keepInbox !== true) {
        inbox.nextTurn.length = 0
        inbox.nextStep.length = 0
      }
    }

    const cancellation = control!.cancelTerminal(owner, terminal)
    await control!.handleSessionEvent(agent.session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    } as never)
    expect(await cancellation).toEqual({ kind: 'cancelled' })
    expect(keepInbox).toBe(true)
    expect(inbox.nextTurn).toEqual([foreignTurn])
    expect(inbox.nextStep).toEqual([foreignStep])
  })

  it('releases a confirmed unclaimed message without waiting for whole-Agent idle', async () => {
    const { agents } = await start()
    const owner = client('unclaimed-cancel-owner')
    const terminal = client('unclaimed-cancel-terminal')
    const sessionId = makeSessionId('unclaimed-cancel-session')
    await control!.attachClient(owner)
    await control!.openTerminal(owner, terminal, {
      workspace: root!, sessionId, initialTask: 'remove this pending message',
    })
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error('expected live unclaimed Agent')
    const wholeAgentIdle = Promise.withResolvers<undefined>()
    let cancelCalls = 0
    ;(agent as unknown as { whenIdle: () => Promise<void>; cancel: () => void }).whenIdle = () => wholeAgentIdle.promise
    ;(agent as unknown as { cancel: () => void }).cancel = () => { cancelCalls += 1 }

    const cancellation = control!.cancelTerminal(owner, terminal)
    try {
      await expect(Promise.race([
        cancellation,
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
      ])).resolves.toEqual({ kind: 'cancelled' })
      expect(cancelCalls).toBe(0)
      expect(agent.inbox.nextTurn).toEqual([])
      const replacement = await runtime!.beginAgentWork(sessionId)
      await runtime!.endAgentWork(replacement)
    } finally {
      wholeAgentIdle.resolve(undefined)
      await cancellation
    }
  })

  it('settles the exact cancelled turn while a foreign replacement remains hanging', async () => {
    const wholeAgentIdle = Promise.withResolvers<undefined>()
    let capturedRpcId: string | undefined
    const liveAgent: { current: Agent | undefined } = { current: undefined }
    const api: NonNullable<RuntimeControlServiceOptions['api']> = {
      sessions: {
        async create(request) {
          const sessionId = request.payload.sessionId
          if (sessionId === undefined) throw new Error('test Runtime requires an explicit session')
          return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId } } }
        },
        async prompt(request) {
          capturedRpcId = request.rpcId
          return { rpcId: request.rpcId, result: { ok: true as const, value: { accepted: true as const } } }
        },
        async models(request) {
          return {
            rpcId: request.rpcId,
            result: {
              ok: true as const,
              value: { current: { provider: 'test', model: 'test' }, routable: true, groups: [], failures: [] },
            },
          }
        },
        async selectModel(request) {
          return {
            rpcId: request.rpcId,
            result: {
              ok: true as const,
              value: { selected: { provider: request.payload.provider, model: request.payload.model } },
            },
          }
        },
      },
    }
    const agents: NonNullable<RuntimeControlServiceOptions['agents']> = { get: () => liveAgent.current }
    const started = await start(undefined, { api, agents })
    const session = started.sessions.create(makeSessionId('foreign-replacement-session'), { meta: { cwd: root! } })
    const foreignTurn = { id: 'foreign-next-turn' }
    const foreignStep = { id: 'foreign-next-step' }
    const inbox = {
      nextTurn: [foreignTurn],
      nextStep: [foreignStep],
      remove: () => false,
    }
    let keepInbox: boolean | undefined
    liveAgent.current = {
      id: session.id,
      session,
      status: 'running',
      options: {},
      inbox: inbox as never,
      ctx: {} as never,
      cancel(_cause, options) { keepInbox = options?.keepInbox },
      whenIdle: () => wholeAgentIdle.promise,
      runMaintenance: () => Promise.reject(new Error('not used')),
      send() {},
      followup() {},
      steer() {},
      inject() {},
    }
    const owner = client('foreign-replacement-owner')
    const terminal = client('foreign-replacement-terminal')
    await control!.attachClient(owner)
    await control!.openTerminal(owner, terminal, {
      workspace: root!, sessionId: session.id, initialTask: 'owned turn to cancel',
    })
    if (capturedRpcId === undefined) throw new Error('expected the owned rpc id')
    control!.handleAgentInboxClaimed(liveAgent.current, {
      source: { kind: 'user', rpcId: capturedRpcId },
    } as never, 1)

    const cancellation = control!.cancelTerminal(owner, terminal)
    const exactEnd = control!.handleSessionEvent(session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    } as never)
    let foreignLease: Awaited<ReturnType<RuntimeHandle['beginAgentWork']>> | undefined
    try {
      const exactEndOutcome = await Promise.race([
        exactEnd.then(() => 'settled' as const),
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
      ])
      expect(exactEndOutcome).toBe('settled')
      foreignLease = await runtime!.beginAgentWork(session.id)
      session.append('turn/start', { turn: 2 })
      await expect(Promise.race([
        cancellation,
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 50)),
      ])).resolves.toEqual({ kind: 'cancelled' })
      expect(keepInbox).toBe(true)
      expect(inbox.nextTurn).toEqual([foreignTurn])
      expect(inbox.nextStep).toEqual([foreignStep])
      expect(session.events.at(-1)).toMatchObject({ type: 'turn/start', data: { turn: 2 } })
      expect(() => runtime!.beginAgentWork(session.id)).toThrow('active writer')
      expect(await control!.observeActiveWork(owner)).toEqual({ ownUiWork: [] })
    } finally {
      wholeAgentIdle.resolve(undefined)
      await Promise.allSettled([exactEnd, cancellation])
      if (foreignLease !== undefined) await runtime!.endAgentWork(foreignLease)
    }
  })

  it('ignores a stale prior turn completion after a replacement operation is admitted', async () => {
    let capturedRpcId: string | undefined
    const liveAgent: { current: Agent | undefined } = { current: undefined }
    const api: NonNullable<RuntimeControlServiceOptions['api']> = {
      sessions: {
        async create(request) {
          const sessionId = request.payload.sessionId
          if (sessionId === undefined) throw new Error('test Runtime requires an explicit session')
          return { rpcId: request.rpcId, result: { ok: true as const, value: { sessionId } } }
        },
        async prompt(request) {
          capturedRpcId = request.rpcId
          return { rpcId: request.rpcId, result: { ok: true as const, value: { accepted: true as const } } }
        },
        async models(request) {
          return {
            rpcId: request.rpcId,
            result: {
              ok: true as const,
              value: { current: { provider: 'test', model: 'test' }, routable: true, groups: [], failures: [] },
            },
          }
        },
        async selectModel(request) {
          return {
            rpcId: request.rpcId,
            result: {
              ok: true as const,
              value: { selected: { provider: request.payload.provider, model: request.payload.model } },
            },
          }
        },
      },
    }
    const agents: NonNullable<RuntimeControlServiceOptions['agents']> = { get: () => liveAgent.current }
    const started = await start(undefined, { api, agents })
    const session = started.sessions.create(makeSessionId('correlated-session'), { meta: { cwd: root! } })
    liveAgent.current = {
      id: session.id,
      session,
      status: 'running',
      options: {},
      inbox: {} as never,
      ctx: {} as never,
      cancel() {},
      whenIdle: () => Promise.resolve(),
      runMaintenance: () => Promise.reject(new Error('not used')),
      send() {},
      followup() {},
      steer() {},
      inject() {},
    }
    const owner = client('correlation-owner')
    const terminal = client('correlation-terminal')
    await control!.attachClient(owner)
    await control!.openTerminal(owner, terminal, {
      workspace: root!, sessionId: session.id, initialTask: 'first exact operation',
    })
    expect(capturedRpcId).toBeDefined()
    control!.handleAgentInboxClaimed(liveAgent.current, {
      source: { kind: 'user', rpcId: capturedRpcId! },
    } as never, 1)
    const firstEnd = control!.handleSessionEvent(session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    await firstEnd
    expect(await control!.observeActiveWork(owner)).toEqual({ ownUiWork: [] })

    capturedRpcId = undefined
    await control!.submitTerminal(owner, terminal, { kind: 'task', text: 'replacement exact operation' })
    expect(capturedRpcId).toBeDefined()
    control!.handleAgentInboxClaimed(liveAgent.current, {
      source: { kind: 'user', rpcId: capturedRpcId! },
    } as never, 2)

    await control!.handleSessionEvent(session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    expect((await control!.observeActiveWork(owner)).ownUiWork).toHaveLength(1)
    await control!.handleSessionEvent(session, {
      type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } },
    } as never)
    expect(await control!.observeActiveWork(owner)).toEqual({ ownUiWork: [] })
  })

  it('persists accepted, declined, collision, and corrected retry migration results without legacy paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-migration-'))
    const legacy = join(root, 'legacy-private-root')
    await mkdir(join(legacy, 'sessions'), { recursive: true })
    await writeFile(join(legacy, 'sessions', 'one.jsonl'), '{"session":1}\n')
    const { home } = await start(legacy)
    const first = client('migration-client')
    await control!.attachClient(first)

    expect(await control!.handleNative(first, { operation: 'get-legacy-migration' }))
      .toEqual({ kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false })
    const imported = await control!.handleNative(first, { operation: 'accept-legacy-migration' })
    expect(imported).toEqual({ kind: 'imported', copied: ['sessions'] })
    expect(await control!.handleDashboard({ operation: 'accept-legacy-migration' })).toEqual(imported)
    expect(await readFile(join(home, 'legacy-migration.json'), 'utf8')).not.toContain(legacy)
    expect(await readFile(join(legacy, 'sessions', 'one.jsonl'), 'utf8')).toBe('{"session":1}\n')

    await control!.close()
    control = undefined
    await runtime!.dispose()
    runtime = undefined
    await rm(home, { recursive: true, force: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'collision.txt'), 'user-owned')
    await start(legacy)
    await control!.attachClient(first)
    const collision = await control!.handleDashboard({ operation: 'accept-legacy-migration' })
    expect(collision).toMatchObject({ kind: 'target-not-empty', retryable: true })
    expect(JSON.stringify(collision)).not.toContain(legacy)
    await rm(join(home, 'collision.txt'))
    expect(await control!.handleNative(first, { operation: 'retry-legacy-migration' }))
      .toEqual({ kind: 'imported', copied: ['sessions'] })
  })

  it('persists a decline for both native and authenticated Dashboard queries', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-decline-'))
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'projects'), { recursive: true })
    await start(legacy)
    const owner = client('decline-client')
    await control!.attachClient(owner)

    expect(await control!.handleNative(owner, { operation: 'decline-legacy-migration' })).toEqual({ kind: 'declined' })
    expect(await control!.handleDashboard({ operation: 'get-legacy-migration' })).toEqual({ kind: 'declined' })
  })

  it('serializes concurrent native and Dashboard migration decisions onto one imported result', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-migration-race-'))
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'projects'), { recursive: true })
    await writeFile(join(legacy, 'projects', 'one.json'), '{"source":true}\n')
    const { home } = await start(legacy)
    const owner = client('migration-race-client')
    await control!.attachClient(owner)

    const results = await Promise.all([
      control!.handleNative(owner, { operation: 'accept-legacy-migration' }),
      control!.handleDashboard({ operation: 'accept-legacy-migration' }),
      control!.handleDashboard({ operation: 'decline-legacy-migration' }),
    ])

    expect(results).toEqual([
      { kind: 'imported', copied: ['projects'] },
      { kind: 'imported', copied: ['projects'] },
      { kind: 'imported', copied: ['projects'] },
    ])
    expect(await control!.handleNative(owner, { operation: 'get-legacy-migration' }))
      .toEqual({ kind: 'imported', copied: ['projects'] })
    expect(await readFile(join(home, 'projects', 'one.json'), 'utf8')).toBe('{"source":true}\n')
    expect(await readFile(join(legacy, 'projects', 'one.json'), 'utf8')).toBe('{"source":true}\n')
  })

  it('retains Runtime ownership while a Dashboard migration transaction is pending', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-pending-migration-'))
    const legacy = join(root, 'legacy')
    await mkdir(legacy)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const idleCallbacks = new Set<() => Promise<void>>()
    const { home } = await start(legacy, {
      async recordMigration() {
        entered.resolve(undefined)
        await release.promise
        return { kind: 'imported', copied: [] }
      },
    }, {
      scheduleIdle(callback) {
        idleCallbacks.add(callback)
        return callback as unknown as ReturnType<typeof setTimeout>
      },
      cancelIdle(handle) {
        idleCallbacks.delete(handle as unknown as () => Promise<void>)
      },
    })

    const pending = control!.handleDashboard({ operation: 'accept-legacy-migration' })
    await entered.promise
    try {
      expect(idleCallbacks.size).toBe(0)
      await expect(readFile(join(home, 'runtime-endpoint.json'), 'utf8')).resolves.toContain('runtimeId')
    } finally {
      release.resolve(undefined)
    }
    await expect(pending).resolves.toEqual({ kind: 'imported', copied: [] })
    expect(idleCallbacks.size).toBe(1)
  })

  it('projects a durable import failure and retries only after the retained state is corrected', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-failed-import-'))
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'projects'), { recursive: true })
    await writeFile(join(legacy, 'projects', 'one.json'), '{}\n')
    const { home } = await start(legacy)
    const owner = client('failed-import-client')
    await control!.attachClient(owner)
    await writeFile(join(home, 'legacy-migration.json'), JSON.stringify({
      kind: 'failed', retained: [], retryable: true, diagnosticId: randomUUID(),
    }) + '\n')

    const failed = await control!.handleDashboard({ operation: 'get-legacy-migration' })
    expect(failed).toMatchObject({ kind: 'failed', retryable: true })
    expect(JSON.stringify(failed)).not.toContain(legacy)
    expect(await control!.handleNative(owner, { operation: 'retry-legacy-migration' }))
      .toEqual({ kind: 'imported', copied: ['projects'] })
    expect(await readFile(join(legacy, 'projects', 'one.json'), 'utf8')).toBe('{}\n')
  })
})
