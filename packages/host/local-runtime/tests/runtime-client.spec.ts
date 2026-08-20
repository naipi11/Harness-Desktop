/** Public Runtime connector/client discovery, ownership, and redaction behavior. */

import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import type { ApiProxy } from '@harness-desktop/dsh-host-apiproxy/api'
import WebServer from '@harness-desktop/dsh-host-webserver'
import type { Branded } from '@harness-desktop/dsh-brand'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  probeRuntimeStatus,
  RuntimeProtocolError,
  RuntimeUnavailableError,
  type DashboardAttachment,
  type RuntimeClient,
} from '../src/runtime-client.ts'
import { createLocalRuntimePlugin } from '../src/data-root.ts'
import { writePrivateEndpointRecord } from '../src/endpoint-record.ts'
import { currentProcessIdentity } from '../src/process-identity.ts'
import { startRuntime, type RuntimeHandle } from '../src/runtime.ts'

let root: string | undefined
let runtime: RuntimeHandle | undefined
let client: RuntimeClient | undefined
let dashboard: DashboardAttachment | undefined

afterEach(async () => {
  await dashboard?.close()
  dashboard = undefined
  await client?.close()
  client = undefined
  await runtime?.dispose()
  runtime = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function startControlledRuntime(home: string, lifecycle?: {
  callbacks: Set<() => Promise<void>>
}, legacyDshHome?: string): Promise<void> {
  const provider = createLocalRuntimePlugin({ env: { HARNESS_HOME: home }, homeDir: root! })
  runtime = await startRuntime({
    harnessHome: provider,
    idleTimeoutMs: lifecycle === undefined ? 60_000 : 1,
    mountPrivateControl: true,
    ...(legacyDshHome === undefined ? {} : { legacyDshHome }),
    ...(lifecycle === undefined ? {} : {
      scheduleIdle(callback: () => Promise<void>) {
        lifecycle.callbacks.add(callback)
        return callback as unknown as ReturnType<typeof setTimeout>
      },
      cancelIdle(handle: ReturnType<typeof setTimeout>) {
        lifecycle.callbacks.delete(handle as unknown as () => Promise<void>)
      },
    }),
    async boot() {
      const ctx = new Context()
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
      ctx.provide('apiProxy', {} as ApiProxy)
      return ctx
    },
  })
}

describe('public Runtime connector', () => {
  it('does not create a file, lock, endpoint, or process when no-start discovery finds no Runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-no-start-'))
    const home = join(root, 'missing-home')
    let starts = 0
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: home }, homeDir: root },
      startProcess: async () => { starts += 1 },
    })

    await expect(connector.connect({ start: false })).rejects.toBeInstanceOf(RuntimeUnavailableError)
    expect(starts).toBe(0)
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  it('returns not-running from a no-start status probe without creating the selected home', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-status-probe-'))
    const home = join(root, 'missing-home')

    expect(await probeRuntimeStatus({ input: { env: { HARNESS_HOME: home }, homeDir: root } }))
      .toEqual({ kind: 'not-running' })
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('attaches to one healthy Runtime and exposes only redacted status values', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-client-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })

    client = await connector.connect({ start: false })
    const status = await client.status()

    expect(status.state).toBe('running')
    expect(status.dashboardOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(status.backgroundLease).toEqual({ id: 'web', state: 'absent' })
    expect(JSON.stringify(status)).not.toMatch(/token|credential|runtime-endpoint|private/i)
  }, 20_000)

  it('waits for a racing starter to replace an unreachable endpoint before attaching', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-stale-endpoint-'))
    const home = join(root, 'home') as Branded<'HarnessHome'>
    await mkdir(home)
    await writePrivateEndpointRecord(home, {
      protocolVersion: 1,
      runtimeId: 'stale-runtime' as Branded<'RuntimeId'>,
      port: 9,
      process: await currentProcessIdentity(),
      accessToken: 'stale-private-token',
    })
    let started: Promise<void> | undefined
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: home }, homeDir: root },
      startProcess: async () => {
        started ??= new Promise(resolve => setTimeout(resolve, 50)).then(() => startControlledRuntime(home))
      },
    })

    client = await connector.connect({ start: true })
    await started
    expect((await client.status()).runtimeId).not.toBe('stale-runtime')
  }, 20_000)

  it('gives the client and each Dashboard attachment independent release ownership', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-client-ownership-'))
    const home = join(root, 'home')
    const callbacks = new Set<() => Promise<void>>()
    await startControlledRuntime(home, { callbacks })
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    dashboard = await client.attachDashboard()
    const navigation = await dashboard.createBrowserHandoff()

    expect(navigation.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(navigation.handoff.id).not.toContain('token')
    await client.close()
    client = undefined
    expect(callbacks.size).toBe(0)
    expect(runtime!.status().state).toBe('running')

    await dashboard.close()
    dashboard = undefined
    expect(callbacks.size).toBe(1)
  })

  it('shares one durable migration state through native and authenticated Dashboard control', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-dashboard-migration-'))
    const home = join(root, 'home')
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'sessions'), { recursive: true })
    await writeFile(join(legacy, 'sessions', 'one.jsonl'), '{}\n')
    await startControlledRuntime(home, undefined, legacy)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    dashboard = await client.attachDashboard()
    expect(await client.getLegacyMigration())
      .toEqual({ kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false })
    const navigation = await dashboard.createBrowserHandoff()
    const exchange = await fetch(`${navigation.origin}/_harness/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: navigation.handoff.id }),
    })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const response = await fetch(`${navigation.origin}/_harness/dashboard-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: navigation.origin },
      body: JSON.stringify({ operation: 'accept-legacy-migration' }),
    })
    const body = await response.json() as { ok: boolean; value: unknown }

    expect(body).toEqual({ ok: true, value: { kind: 'imported', copied: ['sessions'] } })
    expect(await client.getLegacyMigration()).toEqual(body.value)
  })

  it('normalizes unknown and unavailable failures without returning raw paths or secrets', async () => {
    const raw = new Error('token=private C:\\Users\\person\\Harness\\runtime-endpoint.json')
    const unknown = normalizeRecoveryDiagnostic(raw)
    const unavailable = normalizeRecoveryDiagnostic(new RuntimeUnavailableError())

    for (const diagnostic of [unknown, unavailable]) {
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|C:\\Users|runtime-endpoint|token=/)
      expect(diagnostic.subject).toBe('Runtime')
      expect(diagnostic.diagnosticId).toEqual(expect.any(String))
    }
  })

  it('rejects hostile public status and migration wire values before projection', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-hostile-wire-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    const originalFetch = globalThis.fetch
    let hostile: unknown = {
      state: 'running', runtimeId: 'runtime-id', dashboardOrigin: 'http://evil.invalid',
      backgroundLease: { id: 'web', state: 'absent' }, accessToken: 'private-token',
    }
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: string } : undefined
      if (body?.operation === 'status' || body?.operation === 'get-legacy-migration') {
        return new Response(JSON.stringify({ ok: true, value: hostile }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }
    try {
      await expect(client.status()).rejects.toBeInstanceOf(RuntimeProtocolError)
      hostile = { kind: 'imported', copied: ['C:\\Users\\person\\secret-token.txt'] }
      await expect(client.getLegacyMigration()).rejects.toBeInstanceOf(RuntimeProtocolError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a path-bearing busy response instead of exposing its session id', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-hostile-busy-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: string } : undefined
      if (body?.operation === 'open-terminal') {
        return new Response(JSON.stringify({
          ok: false,
          result: {
            kind: 'session-busy',
            sessionId: 'C:\\Users\\person\\secret-token.txt',
            options: ['observe', 'new-session', 'wait'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(input, init)
    }
    try {
      await expect(client.openTerminal({ workspace: root })).rejects.toBeInstanceOf(RuntimeProtocolError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
