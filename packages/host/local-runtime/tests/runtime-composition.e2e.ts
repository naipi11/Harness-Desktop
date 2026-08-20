/** Canonical Runtime composition against one real loopback listener. */

import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { createLocalRuntimePlugin } from '../src/data-root.ts'
import { readPrivateEndpointRecord } from '../src/endpoint-record.ts'
import { startCanonicalRuntime, startRuntime, type RuntimeHandle } from '../src/runtime.ts'

let root: string | undefined
let runtime: RuntimeHandle | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('canonical local Runtime composition', () => {
  it('boots the shipped base and Web composition through one injected provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-shipped-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })

    runtime = await startCanonicalRuntime({ harnessHome, idleTimeoutMs: 60_000 })

    const record = await readPrivateEndpointRecord(harnessHome.home)
    expect(runtime.status().port).toBe(record.port)
    expect(record.port).toBeGreaterThan(0)
  }, 30_000)

  it('publishes one healthy loopback endpoint over one injected Harness home', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-composition-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })
    let receivedHome: typeof harnessHome | undefined

    runtime = await startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async boot(provider) {
        receivedHome = provider
        const ctx = new Context()
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
        return ctx
      },
    })

    const record = await readPrivateEndpointRecord(harnessHome.home)
    expect(receivedHome).toBe(harnessHome)
    expect(record.port).toBe(runtime.status().port)
    expect(runtime.status()).toMatchObject({ state: 'running', backgroundLeaseCount: 0 })
    expect(record.port).toBeGreaterThan(0)
  })

  it('does not publish an endpoint when the composed Runtime never becomes healthy', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-unhealthy-'))
    const harnessHome = createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root })

    await expect(startRuntime({
      harnessHome,
      idleTimeoutMs: 60_000,
      async boot() { throw new Error('web composition did not start') },
    })).rejects.toThrow('web composition did not start')

    await expect(access(join(root, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
