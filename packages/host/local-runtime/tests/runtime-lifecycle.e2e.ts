/** Runtime lease accounting and ordered final teardown. */

import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import type { Branded } from '@harness-desktop/dsh-brand'
import { createLocalRuntimePlugin } from '../src/data-root.ts'
import { startRuntime, type RuntimeHandle } from '../src/runtime.ts'

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
