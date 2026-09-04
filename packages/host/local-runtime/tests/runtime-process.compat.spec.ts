/** Source and built Runtime processes share the public private-control protocol. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeConnector, type RuntimeClient } from '../src/runtime-client.ts'
import {
  cleanupRuntimeProcess, dashboardControl,
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

async function waitForTraceValue(process: RuntimeProcess, event: string): Promise<string | undefined> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const text = await readFile(process.tracePath, 'utf8').catch(() => '')
    const row = text.split(/\r?\n/u).filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; value?: string })
      .find(candidate => candidate.event === event)
    if (row !== undefined) return row.value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for Runtime trace ${event}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe.each([
  { label: 'source', mode: 'src' as const },
  { label: 'built', mode: 'lib' as const },
])('$label Runtime public-control compatibility', ({ mode }) => {
  it('consumes Electron Node mode before a descendant process inherits the Runtime environment', async () => {
    runtime = await startRuntimeProcess({
      mode,
      electronRunAsNode: '1',
      probeDescendantEnvironment: true,
    })
    await waitForEndpoint(runtime)

    expect(await waitForTraceValue(runtime, 'descendant-environment')).toBe('absent')
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 90_000)

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

  it('persists a selected update channel through the public Runtime client', async () => {
    runtime = await startRuntimeProcess(mode === 'src'
      ? { mode, entry: 'source-backend-fixture', denyWorkspaceLib: true }
      : { mode })
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })

    expect(await client.getDesktopUpdateChannel()).toBe('stable')
    expect(await client.setDesktopUpdateChannel('beta')).toBe('beta')
    await expect(client.recordDesktopUpdateOutcome({
      version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged',
    })).resolves.toBeUndefined()
    expect(await client.getDesktopUpdateLastOutcome()).toEqual({
      version: '1.2.3', channel: 'beta', kind: 'staged', code: 'staged',
    })
    expect(await client.getDesktopUpdateChannel()).toBe('beta')

    await client.close()
    client = undefined
    const result = await releaseRuntime(runtime)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain(endpoint.accessToken)
  }, 90_000)
})

describe('clean-source real terminal operation', () => {
  it('attributes browser prompt work to its authenticated Dashboard cookie and stops only that owner', async () => {
    const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${replayOverride}.missing`
    process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = replayOverride
    try {
      runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    } finally {
      if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
      else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
      if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
      else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
    }
    const endpoint = await waitForEndpoint(runtime)
    const ownerCookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken, 'runtime-process-browser-owner')
    const otherCookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken, 'runtime-process-browser-other')
    const workspace = await runtimeRpc<{ workspace: { workspaceId: string } }>(
      endpoint.port, ownerCookie, 'workspace.create', { path: runtime.cwd },
    )
    const sessionId = 'dashboard-owned-browser-prompt'
    await runtimeRpc(endpoint.port, ownerCookie, 'session.create', {
      workspaceId: workspace.workspace.workspaceId, sessionId, agentPreset: 'standard',
    })
    await runtimeRpc(endpoint.port, ownerCookie, 'session.prompt', {
      sessionId, mode: 'queue', content: [{ type: 'text', text: 'complete first' }],
    })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sessions = await runtimeRpc<{ items: Array<{ sessionId: string; running: boolean }> }>(
        endpoint.port, ownerCookie, 'session.list', {},
      )
      if (sessions.items.find(item => item.sessionId === sessionId)?.running === false) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    await runtimeRpc(endpoint.port, ownerCookie, 'session.prompt', {
      sessionId, mode: 'queue', content: [{ type: 'text', text: 'hang for owner stop' }],
    })
    let status: { ownUiWork: readonly string[] } = { ownUiWork: [] }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await dashboardControl(endpoint.port, ownerCookie, 'observe-active-work')
      if (status.ownUiWork.length === 1) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(status.ownUiWork).toHaveLength(1)
    expect(await dashboardControl(endpoint.port, otherCookie, 'observe-active-work'))
      .toEqual({ ownUiWork: [] })
    expect(await dashboardControl(endpoint.port, ownerCookie, 'stop-own-ui-work'))
      .toEqual({ kind: 'stopped', work: status.ownUiWork })
    expect(await dashboardControl(endpoint.port, ownerCookie, 'observe-active-work'))
      .toEqual({ ownUiWork: [] })
    expect(await dashboardControl(endpoint.port, otherCookie, 'stop-own-ui-work'))
      .toEqual({ kind: 'none-active' })
  }, 120_000)

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

describe('real no-turn command operation', () => {
  it('emits the ApiProxy command result and releases the exact work lease without a turn', async () => {
    const previous = process.env.DSH_RUNTIME_TEST_COMMAND
    process.env.DSH_RUNTIME_TEST_COMMAND = '1'
    try {
      runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    } finally {
      if (previous === undefined) delete process.env.DSH_RUNTIME_TEST_COMMAND
      else process.env.DSH_RUNTIME_TEST_COMMAND = previous
    }
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })
    const terminal = await client.openTerminal({ workspace: runtime.cwd })
    const events = terminal.events()[Symbol.asyncIterator]()
    const opened = await nextEvent(events, 'session-opened')
    if (opened.kind !== 'session-opened') throw new Error('expected session-opened')

    await terminal.submit({ kind: 'task', text: '/runtime_no_turn' })
    expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })
    expect(await nextEvent(events, 'output', 'command output'))
      .toEqual({ kind: 'output', text: 'REAL_COMMAND_OUTPUT' })
    expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const history = await runtimeRpc<{ events: Array<{ event: { type: string } }> }>(
      endpoint.port, cookie, 'session.history', { sessionId: opened.sessionId },
    )
    const types = history.events.map(entry => entry.event.type)
    expect(types).toContain('command/run')
    expect(types).toContain('command/done')
    expect(types).not.toContain('turn/start')
    expect(types).not.toContain('turn/end')

    await terminal.close()
    await client.close()
    client = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 90_000)
})
