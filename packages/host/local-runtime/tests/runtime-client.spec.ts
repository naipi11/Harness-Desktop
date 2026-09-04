/** Public Runtime connector/client discovery, ownership, and redaction behavior. */

import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import type { ApiProxy } from '@harness-desktop/dsh-host-apiproxy/api'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { SettingsProvider } from '@harness-desktop/dsh-settings'
import type { SettingsNamespace } from '@harness-desktop/dsh-settings'
import type { Branded } from '@harness-desktop/dsh-brand'
import {
  createRuntimeConnector,
  consumeElectronRunAsNodeEnvironment,
  normalizeRecoveryDiagnostic,
  probeRuntimeStatus,
  runtimeChildEnvironment,
  RuntimeProtocolError,
  RuntimeUnavailableError,
  type DashboardAttachment,
  type RuntimeClient,
} from '../src/runtime-client.ts'
import { createLocalRuntimePlugin } from '../src/data-root.ts'
import { readPrivateEndpointRecord, writePrivateEndpointRecord } from '../src/endpoint-record.ts'
import { currentProcessIdentity } from '../src/process-identity.ts'
import { startRuntime, type RuntimeHandle } from '../src/runtime.ts'

let root: string | undefined
let runtime: RuntimeHandle | undefined
let client: RuntimeClient | undefined
let dashboard: DashboardAttachment | undefined

/** Small settings provider keeping the private-control Runtime fixture self-contained. */
class MemorySettings extends SettingsProvider {
  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(_namespace: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

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
}, legacyDshHome?: string, options: { readonly settings?: boolean } = {}): Promise<void> {
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
      if (options.settings !== false) await ctx.plugin(MemorySettings).await()
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
      ctx.provide('apiProxy', {} as ApiProxy)
      return ctx
    },
  })
}

describe('public Runtime connector', () => {
  it('sets Electron child launches to Node mode without changing Node caller environments', () => {
    const nodeEnvironment = { EXISTING: 'value', ELECTRON_RUN_AS_NODE: 'preserved' }

    expect(runtimeChildEnvironment(nodeEnvironment, undefined)).toEqual(nodeEnvironment)
    const electronChild = runtimeChildEnvironment(nodeEnvironment, '43.4.0')
    expect(electronChild).toEqual({
      EXISTING: 'value',
      ELECTRON_RUN_AS_NODE: '1',
    })
    consumeElectronRunAsNodeEnvironment(electronChild)
    expect(electronChild).toEqual({ EXISTING: 'value' })
  })

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

  it('shares the selected update channel while keeping update outcome reads and writes native-only', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-dashboard-update-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    dashboard = await client.attachDashboard()

    expect(await client.getDesktopUpdateChannel()).toBe('stable')
    expect(await client.setDesktopUpdateChannel('nightly')).toBe('nightly')
    await expect(client.recordDesktopUpdateOutcome({
      version: '1.2.3', channel: 'nightly', kind: 'staged', code: 'staged',
    })).resolves.toBeUndefined()
    expect(await client.getDesktopUpdateLastOutcome()).toEqual({
      version: '1.2.3', channel: 'nightly', kind: 'staged', code: 'staged',
    })

    const navigation = await dashboard.createBrowserHandoff()
    const exchange = await fetch(`${navigation.origin}/_harness/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: navigation.handoff.id }),
    })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const request = (body: unknown) => fetch(`${navigation.origin}/_harness/dashboard-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: navigation.origin },
      body: JSON.stringify(body),
    })

    await expect(request({ operation: 'get-desktop-update-channel' }).then(response => response.json()))
      .resolves.toEqual({ ok: true, value: 'nightly' })
    await expect(request({ operation: 'set-desktop-update-channel', channel: 'beta' }).then(response => response.json()))
      .resolves.toEqual({ ok: true, value: 'beta' })
    expect((await request({
      operation: 'record-desktop-update-outcome',
      outcome: { version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged' },
    })).status).toBe(400)
    expect((await request({ operation: 'get-desktop-update-last-outcome' })).status).toBe(400)
    expect(await client.getDesktopUpdateChannel()).toBe('beta')
  }, 20_000)

  it('rejects malformed update controls before they reach an authenticated service owner', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-malformed-update-control-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const endpoint = await readPrivateEndpointRecord(home as Branded<'HarnessHome'>)
    const control = (body: unknown) => fetch(`http://127.0.0.1:${String(endpoint.port)}/_harness/control`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.accessToken}`,
        'content-type': 'application/json',
        'x-harness-runtime-client': 'malformed-update-control-client',
      },
      body: JSON.stringify(body),
    })

    const responses = await Promise.all([
      control({ operation: 'set-desktop-update-channel', channel: 'preview' }),
      control({ operation: 'set-desktop-update-channel', channel: 'stable', unexpected: true }),
      control({
        operation: 'record-desktop-update-outcome',
        outcome: { version: '1.2.3', channel: 'stable', kind: 'failed', code: 'network-detail' },
      }),
      control({
        operation: 'record-desktop-update-outcome',
        outcome: {
          version: '1.2.3', channel: 'stable', kind: 'failed', code: 'manifest-rejected',
          url: 'https://updates.example.test/manifest.json',
        },
      }),
    ])

    expect(responses.map(response => response.status)).toEqual([400, 400, 400, 400])
  }, 20_000)

  it('fails update control through the redacted Runtime path when a reduced composition has no settings provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-update-without-settings-'))
    const home = join(root, 'home')
    await startControlledRuntime(home, undefined, undefined, { settings: false })
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })

    await expect(client.getDesktopUpdateChannel()).rejects.toBeInstanceOf(RuntimeUnavailableError)
  }, 20_000)

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
      if (body?.operation === 'status' || body?.operation === 'get-legacy-migration'
        || body?.operation === 'get-desktop-update-last-outcome') {
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
      hostile = {
        version: '1.2.3', channel: 'stable', kind: 'failed', code: 'manifest-rejected',
        url: 'https://updates.example.test/manifest.json',
      }
      await expect(client.getDesktopUpdateLastOutcome()).rejects.toBeInstanceOf(RuntimeProtocolError)
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

  it('accepts an unrelated absolute path inside a redacted diagnostic', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-unrelated-diagnostic-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: string } : undefined
      if (body?.operation === 'status') {
        return new Response(JSON.stringify({
          ok: false,
          result: {
            kind: 'unavailable',
            diagnostic: {
              code: 'runtime-unavailable',
              subject: 'Runtime',
              message: 'Failure at C:\\unrelated-workspace\\ordinary-output.txt.',
              correction: 'Inspect C:\\unrelated-workspace\\ordinary-output.txt and retry.',
              diagnosticId: '11111111-1111-4111-8111-111111111111',
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(input, init)
    }
    try {
      await expect(client.status()).rejects.toBeInstanceOf(RuntimeUnavailableError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects the exact endpoint token and selected Harness home in otherwise valid terminal output', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-exact-private-wire-'))
    const home = join(root, 'home')
    await startControlledRuntime(home)
    const endpoint = await readPrivateEndpointRecord(home as Branded<'HarnessHome'>)
    const connector = createRuntimeConnector({ input: { env: { HARNESS_HOME: home }, homeDir: root } })
    client = await connector.connect({ start: false })
    const originalFetch = globalThis.fetch
    let privateValue = endpoint.accessToken
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: string } : undefined
      if (body?.operation === 'open-terminal') {
        return new Response(JSON.stringify({
          ok: true, value: { kind: 'opened', sessionId: 'private-output-session' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (body?.operation === 'read-terminal-events') {
        return new Response(JSON.stringify({
          ok: true,
          value: { events: [{ kind: 'output', text: privateValue }], nextCursor: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(input, init)
    }
    try {
      const tokenTerminal = await client.openTerminal({ workspace: root })
      await expect(tokenTerminal.events()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(RuntimeProtocolError)
      privateValue = home
      const homeTerminal = await client.openTerminal({ workspace: root })
      await expect(homeTerminal.events()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(RuntimeProtocolError)
      privateValue = 'C:\\unrelated-workspace\\ordinary-output.txt'
      const ordinaryTerminal = await client.openTerminal({ workspace: root })
      await expect(ordinaryTerminal.events()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        value: { kind: 'output', text: privateValue },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
