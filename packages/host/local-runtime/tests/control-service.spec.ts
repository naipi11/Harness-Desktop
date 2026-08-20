/** Runtime control ownership, durable migration, and session-write admission. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import type { Branded } from '@harness-desktop/dsh-brand'
import SessionStore, { SessionId as makeSessionId } from '@harness-desktop/dsh-session'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { createRuntimeControlService, type RuntimeControlService } from '../src/control-service.ts'
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

async function start(legacyDshHome?: string): Promise<{ sessions: SessionStore; home: string }> {
  root ??= await mkdtemp(join(tmpdir(), 'harness-runtime-control-service-'))
  const home = join(root, 'home')
  const provider = createLocalRuntimePlugin({ env: { HARNESS_HOME: home }, homeDir: root })
  let sessions!: SessionStore
  runtime = await startRuntime({
    harnessHome: provider,
    idleTimeoutMs: 60_000,
    async boot() {
      const ctx = new Context()
      await ctx.plugin(SessionStore).await()
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
      sessions = ctx.sessions
      return ctx
    },
  })
  control = createRuntimeControlService({
    runtime,
    sessions,
    resolution: {
      ...resolveHarnessHome({ env: { HARNESS_HOME: home, DSH_HOME: legacyDshHome }, homeDir: root }),
      legacyDshHome,
    },
  })
  return { sessions, home }
}

describe('Runtime control service', () => {
  it('rejects a second writer for one live session without creating another session record', async () => {
    const { sessions } = await start()
    const first = client('first-client')
    const second = client('second-client')
    const sessionId = makeSessionId('shared-session')
    sessions.create(sessionId)
    await control!.attachClient(first)
    await control!.attachClient(second)

    const admitted = await control!.beginOwnUiWork(first, sessionId)
    const busy = await control!.beginOwnUiWork(second, sessionId)

    expect(admitted.kind).toBe('started')
    expect(busy).toEqual({
      kind: 'session-busy',
      sessionId,
      options: ['observe', 'new-session', 'wait'],
    })
    expect(sessions.list().map(session => session.id)).toEqual([sessionId])
  })

  it('keeps one named Web lease while preserving clients and active work on idempotent release', async () => {
    const { sessions } = await start()
    const first = client('lease-first')
    const second = client('lease-second')
    const sessionId = makeSessionId('lease-session')
    sessions.create(sessionId)
    await control!.attachClient(first)
    await control!.attachClient(second)
    const work = await control!.beginOwnUiWork(first, sessionId)
    expect(work.kind).toBe('started')

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
    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [work.kind === 'started' ? work.workId : ''] })
    expect(runtime!.status().state).toBe('running')
  })

  it('observes and stops only the requesting client UI work', async () => {
    const { sessions } = await start()
    const first = client('ui-first')
    const second = client('ui-second')
    const firstSession = makeSessionId('ui-first-session')
    const secondSession = makeSessionId('ui-second-session')
    sessions.create(firstSession)
    sessions.create(secondSession)
    await control!.attachClient(first)
    await control!.attachClient(second)
    const firstWork = await control!.beginOwnUiWork(first, firstSession)
    const secondWork = await control!.beginOwnUiWork(second, secondSession)
    if (firstWork.kind !== 'started' || secondWork.kind !== 'started') throw new Error('expected distinct work admissions')

    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [firstWork.workId] })
    expect(await control!.stopOwnUiWork(first)).toEqual({ kind: 'stopped', work: [firstWork.workId] })
    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [] })
    expect(await control!.observeActiveWork(second)).toEqual({ ownUiWork: [secondWork.workId] })
  })

  it('releases one session writer when its durable turn ends', async () => {
    const { sessions } = await start()
    const first = client('event-first')
    const second = client('event-second')
    const sessionId = makeSessionId('event-session')
    sessions.create(sessionId)
    await control!.attachClient(first)
    await control!.attachClient(second)
    expect((await control!.beginOwnUiWork(first, sessionId)).kind).toBe('started')

    await control!.handleSessionEvent(sessionId, 'turn/end')

    expect(await control!.observeActiveWork(first)).toEqual({ ownUiWork: [] })
    expect((await control!.beginOwnUiWork(second, sessionId)).kind).toBe('started')
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

  it('projects a durable import failure and retries only after the retained state is corrected', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-failed-import-'))
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'projects'), { recursive: true })
    await writeFile(join(legacy, 'projects', 'one.json'), '{}\n')
    const { home } = await start(legacy)
    const owner = client('failed-import-client')
    await control!.attachClient(owner)
    await writeFile(join(home, 'legacy-migration.json'), JSON.stringify({
      kind: 'failed', retained: [], retryable: true, diagnosticId: 'failed-import-diagnostic',
    }) + '\n')

    const failed = await control!.handleDashboard({ operation: 'get-legacy-migration' })
    expect(failed).toMatchObject({ kind: 'failed', retryable: true })
    expect(JSON.stringify(failed)).not.toContain(legacy)
    expect(await control!.handleNative(owner, { operation: 'retry-legacy-migration' }))
      .toEqual({ kind: 'imported', copied: ['projects'] })
    expect(await readFile(join(legacy, 'projects', 'one.json'), 'utf8')).toBe('{}\n')
  })
})
