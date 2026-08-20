/** Runtime lease accounting and ordered final teardown. */

import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import type { Branded } from '@harness-desktop/dsh-brand'
import { createLocalRuntimePlugin } from '../src/data-root.ts'
import { flushCanonicalSessions, startRuntime, type RuntimeHandle } from '../src/runtime.ts'

let root: string | undefined
let runtime: RuntimeHandle | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function client(value: string) {
  return value as Branded<'RuntimeClientId'>
}

function session(value: string) {
  return value as Branded<'SessionId'>
}

describe('Runtime lifecycle accounting', () => {
  it('refuses ordinary disposal while any client, work, or background owner remains', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-retained-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        return ctx
      },
    })

    await runtime.attachClient(client('retained'))
    await expect(runtime.dispose()).rejects.toThrow('active owners')
    await runtime.releaseClient(client('retained'))
    await runtime.dispose()
    runtime = undefined
  })

  it('continues endpoint, lock, and Cordis cleanup after a durable flush failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-flush-failure-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    let cordisDisposed = false
    let flushObservedPublishedOwner = false
    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async flush() {
        await access(join(root!, 'runtime-endpoint.json'))
        await access(join(root!, 'runtime.lock'))
        flushObservedPublishedOwner = true
        throw new Error('flush failed')
      },
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        ctx.effect(() => () => { cordisDisposed = true }, 'runtime lifecycle disposal probe')
        return ctx
      },
    })

    await expect(runtime.dispose()).rejects.toThrow('flush failed')
    runtime = undefined
    expect(flushObservedPublishedOwner).toBe(true)
    expect(cordisDisposed).toBe(true)
    await expect(access(join(root, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues owner retirement after control cleanup fails and permits a replacement Runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-control-cleanup-failure-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    let cordisDisposed = false
    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        ctx.effect(() => () => { cordisDisposed = true }, 'control cleanup disposal probe')
        return ctx
      },
    })
    runtime.bindControlCleanup(async () => { throw new Error('injected control cleanup failure') })

    await expect(runtime.dispose()).rejects.toThrow('injected control cleanup failure')
    runtime = undefined
    expect(cordisDisposed).toBe(true)
    await expect(access(join(root, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })

    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        return ctx
      },
    })
    await runtime.dispose()
    runtime = undefined
  }, 15_000)

  it('settles every canonical session flush before retiring the Runtime owner', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-flush-settlement-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    const fastFailure = new Error('first session flush failed')
    const slowFailure = new Error('second session flush failed')
    const slowStarted = Promise.withResolvers<undefined>()
    const slow = Promise.withResolvers<undefined>()
    let canonicalFlush: Promise<void> | undefined
    let cordisDisposed = false

    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      flush(ctx) {
        canonicalFlush = flushCanonicalSessions(ctx)
        return canonicalFlush
      },
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        const first = { id: 'first' }
        const second = { id: 'second' }
        ctx.provide('sessions', {
          list: () => [first, second],
          flush(candidate: unknown) {
            if (candidate === first) return Promise.reject(fastFailure)
            slowStarted.resolve(undefined)
            return slow.promise.then(() => Promise.reject(slowFailure))
          },
        } as never)
        ctx.effect(() => () => { cordisDisposed = true }, 'runtime canonical flush disposal probe')
        return ctx
      },
    })

    const disposal = runtime.dispose()
    await slowStarted.promise
    await Promise.resolve()
    const early = await Promise.race([
      canonicalFlush!.then(
        () => 'flush completed early',
        () => 'flush rejected early',
      ),
      Promise.resolve('flush is pending'),
    ])
    expect(early).toBe('flush is pending')
    await access(join(root, 'runtime-endpoint.json'))
    await access(join(root, 'runtime.lock'))
    expect(cordisDisposed).toBe(false)

    slow.resolve(undefined)
    const error: unknown = await disposal.then(() => undefined, (reason: unknown) => reason)
    runtime = undefined
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([fastFailure, slowFailure])
    expect(cordisDisposed).toBe(true)
    await expect(access(join(root, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for the final attachment, active work, and background lease before idle shutdown', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-lifecycle-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    const idleCallbacks = new Set<() => Promise<void>>()

    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 1,
      scheduleIdle(callback) {
        idleCallbacks.add(callback)
        return callback as unknown as ReturnType<typeof setTimeout>
      },
      cancelIdle(handle) {
        idleCallbacks.delete(handle as unknown as () => Promise<void>)
      },
      async boot() {
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        return ctx
      },
    })

    expect(idleCallbacks.size).toBe(1)
    await runtime.attachClient(client('first'))
    await runtime.attachClient(client('second'))
    const work = await runtime.beginAgentWork(session('shared-session'))
    const background = await runtime.acquireBackgroundLease(client('first'))
    await runtime.releaseClient(client('first'))
    await runtime.releaseClient(client('second'))
    expect(idleCallbacks.size).toBe(0)

    await runtime.endAgentWork(work)
    expect(idleCallbacks.size).toBe(0)

    await runtime.releaseBackgroundLease(background)
    expect(idleCallbacks.size).toBe(1)
    await [...idleCallbacks][0]!()
    runtime = undefined

    await expect(access(join(root, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
