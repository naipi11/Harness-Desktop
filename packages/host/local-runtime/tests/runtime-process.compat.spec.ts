/** Source and built Runtime processes share the public private-control protocol. */

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeConnector, type RuntimeClient } from '../src/runtime-client.ts'
import {
  cleanupRuntimeProcess,
  mintBrowserCookie,
  releaseRuntime,
  runtimeRpc,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from './runtime-process-harness.ts'

let runtime: RuntimeProcess | undefined
let client: RuntimeClient | undefined
const replayOverride = fileURLToPath(new URL('./fixtures/runtime-control-replay.override.json', import.meta.url))

afterEach(async () => {
  await client?.close()
  client = undefined
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

async function nextEvent(
  iterator: AsyncIterator<import('../src/runtime-client.ts').TerminalProtocolEvent>,
  kind: import('../src/runtime-client.ts').TerminalProtocolEvent['kind'],
  label: string = kind,
): Promise<import('../src/runtime-client.ts').TerminalProtocolEvent> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error(`timed out waiting for ${label}`)) }, 2_000)),
    ])
    if (next.done === true) throw new Error(`terminal events closed before ${label}`)
    if (next.value.kind === kind) return next.value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
  }
}

describe.each([
  { label: 'source', mode: 'src' as const },
  { label: 'built', mode: 'lib' as const },
])('$label Runtime public-control compatibility', ({ mode }) => {
  it('discovers status and releases the one named Web lease through the public client', async () => {
    runtime = await startRuntimeProcess(mode === 'src'
      ? { mode, entry: 'source-backend-fixture', denyWorkspaceLib: true }
      : { mode })
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })

    expect((await client.status()).runtimeId).toBeDefined()
    expect(await client.acquireBackgroundLease()).toEqual({ id: 'web' })
    expect(await client.releaseBackgroundLease()).toEqual({ id: 'web', state: 'absent' })
    await client.close()
    client = undefined
    const result = await releaseRuntime(runtime)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain(endpoint.accessToken)
  }, 90_000)
})

describe('clean-source real terminal operation', () => {
  it('logs and streams a real task, then cancels the exact hanging Agent operation to quiescence', async () => {
    const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${replayOverride}.missing`
    process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = replayOverride
    try {
      runtime = await startRuntimeProcess({
        mode: 'src',
        entry: 'source-backend-fixture',
        denyWorkspaceLib: true,
      })
    } finally {
      if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
      else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
      if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
      else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
    }
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })
    const terminal = await client.openTerminal({
      workspace: runtime.cwd,
      initialTask: 'persist this exact real task',
    })
    const events = terminal.events()[Symbol.asyncIterator]()
    const opened = await nextEvent(events, 'session-opened')
    if (opened.kind !== 'session-opened') throw new Error('expected session-opened')
    expect(await nextEvent(events, 'output', 'initial output')).toEqual({ kind: 'output', text: 'REAL_RUNTIME_OUTPUT' })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await client.observeActiveWork()).ownUiWork.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const history = await runtimeRpc<{ events: Array<{ event: { type: string; data: unknown } }> }>(
      endpoint.port,
      cookie,
      'session.history',
      { sessionId: opened.sessionId },
    )
    expect(history.events.some(({ event }) => event.type === 'user/message'
      && JSON.stringify(event.data).includes('persist this exact real task'))).toBe(true)
    expect(history.events.some(({ event }) => event.type === 'assistant/message'
      && JSON.stringify(event.data).includes('REAL_RUNTIME_OUTPUT'))).toBe(true)

    await terminal.submit({ kind: 'task', text: 'hang until exact cancellation' })
    expect(await nextEvent(events, 'output', 'cancel output')).toEqual({ kind: 'output', text: 'partial' })
    expect(await terminal.cancel()).toEqual({ kind: 'cancelled' })
    expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })
    const cancelled = await runtimeRpc<{ events: Array<{ event: { type: string; data: unknown } }> }>(
      endpoint.port,
      cookie,
      'session.history',
      { sessionId: opened.sessionId },
    )
    expect(cancelled.events.some(({ event }) => event.type === 'turn/end'
      && JSON.stringify(event.data).includes('aborted'))).toBe(true)

    await terminal.close()
    await client.close()
    client = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 120_000)
})

describe('public attachment close retry', () => {
  it('retries transient release failures for terminal, Dashboard, and client without double release', async () => {
    runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })
    const dashboard = await client.attachDashboard()
    const terminal = await client.openTerminal({ workspace: runtime.cwd })
    const originalFetch = globalThis.fetch

    const expectRetry = async (close: () => Promise<void>): Promise<void> => {
      let failNext = true
      let releases = 0
      globalThis.fetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: string } : undefined
        if (body?.operation === 'release-client') {
          releases += 1
          if (failNext) {
            failNext = false
            throw new Error('transient release failure')
          }
        }
        return originalFetch(input, init)
      }
      await expect(close()).rejects.toBeInstanceOf(Error)
      await expect(close()).resolves.toBeUndefined()
      expect(releases).toBe(2)
      globalThis.fetch = originalFetch
    }

    try {
      await expectRetry(() => terminal.close())
      await expectRetry(() => dashboard.close())
      await expectRetry(() => client!.close())
      client = undefined
    } finally {
      globalThis.fetch = originalFetch
    }
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 90_000)
})
