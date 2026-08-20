/** Keyless real-Agent transcript for Runtime terminal output, busy recovery, and cancellation. */

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  RuntimeBusyError,
  type RuntimeClient,
  type TerminalConnection,
  type TerminalProtocolEvent,
} from '../src/runtime-client.ts'
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
let firstClient: RuntimeClient | undefined
let secondClient: RuntimeClient | undefined
let terminal: TerminalConnection | undefined
const replayOverride = fileURLToPath(new URL('./fixtures/runtime-control-replay.override.json', import.meta.url))

afterEach(async () => {
  await terminal?.cancel()
  await terminal?.close()
  terminal = undefined
  await firstClient?.close()
  firstClient = undefined
  await secondClient?.close()
  secondClient = undefined
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

async function nextKind(iterator: AsyncIterator<TerminalProtocolEvent>, kind: TerminalProtocolEvent['kind']): Promise<TerminalProtocolEvent> {
  for (;;) {
    const event = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error(`timed out waiting for ${kind}`)) }, 5_000)),
    ])
    if (event.done === true) throw new Error(`terminal closed before ${kind}`)
    if (event.value.kind === kind) return event.value
  }
}

function normalizeProtocol(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (key === 'sessionId') return '<session-id>'
    if (key === 'diagnosticId') return '<diagnostic-id>'
    return item
  })) as unknown
}

describe('Runtime real control transcript', () => {
  it('snapshots a recognized slash command with no Agent turn or active work', async () => {
    const previous = process.env.DSH_RUNTIME_TEST_COMMAND
    process.env.DSH_RUNTIME_TEST_COMMAND = '1'
    try {
      runtime = await startRuntimeProcess({
        mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true,
      })
    } finally {
      if (previous === undefined) delete process.env.DSH_RUNTIME_TEST_COMMAND
      else process.env.DSH_RUNTIME_TEST_COMMAND = previous
    }
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    firstClient = await connector.connect({ start: false })
    terminal = await firstClient.openTerminal({ workspace: runtime.cwd })
    const iterator = terminal.events()[Symbol.asyncIterator]()
    const opened = await nextKind(iterator, 'session-opened')
    if (opened.kind !== 'session-opened') throw new Error('expected session-opened')

    await terminal.submit({ kind: 'task', text: '/runtime_no_turn' })
    const output = await nextKind(iterator, 'output')
    const active = await firstClient.observeActiveWork()
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const history = await runtimeRpc<{ events: Array<{ event: { type: string } }> }>(
      endpoint.port, cookie, 'session.history', { sessionId: opened.sessionId },
    )
    const durableTypes = history.events.map(entry => entry.event.type)
    const transcript = normalizeProtocol({
      events: [opened, output],
      active,
      commandTypes: durableTypes.filter(type => type === 'command/run' || type === 'command/done'),
      turnTypes: durableTypes.filter(type => type === 'turn/start' || type === 'turn/end'),
    })
    expect(JSON.stringify(transcript)).not.toContain(endpoint.accessToken)
    expect(JSON.stringify(transcript)).not.toContain(runtime.harnessHome)
    expect(transcript).toMatchInlineSnapshot(`
      {
        "active": {
          "ownUiWork": [],
        },
        "commandTypes": [
          "command/run",
          "command/done",
        ],
        "events": [
          {
            "kind": "session-opened",
            "sessionId": "<session-id>",
          },
          {
            "kind": "output",
            "text": "REAL_COMMAND_OUTPUT",
          },
        ],
        "turnTypes": [],
      }
    `)

    await terminal.close()
    terminal = undefined
    await firstClient.close()
    firstClient = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 120_000)

  it('streams a logged task, reports exact busy recovery, and cancels a real operation', async () => {
    const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${replayOverride}.missing`
    process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = replayOverride
    try {
      runtime = await startRuntimeProcess({
        mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true,
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
    firstClient = await connector.connect({ start: false })
    secondClient = await connector.connect({ start: false })
    terminal = await firstClient.openTerminal({
      workspace: runtime.cwd,
      initialTask: 'snapshot a real Runtime task',
    })
    const iterator = terminal.events()[Symbol.asyncIterator]()
    const opened = await nextKind(iterator, 'session-opened')
    if (opened.kind !== 'session-opened') throw new Error('expected session-opened')
    const completedOutput = await nextKind(iterator, 'output')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await firstClient.observeActiveWork()).ownUiWork.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    await terminal.submit({ kind: 'task', text: 'snapshot exact cancellation' })
    const partialOutput = await nextKind(iterator, 'output')
    let busy: unknown
    try {
      await secondClient.openTerminal({
        workspace: runtime.cwd,
        sessionId: opened.sessionId,
        initialTask: 'must be rejected as busy',
      })
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBusyError)
      busy = normalizeRecoveryDiagnostic(error)
    }
    const cancelled = await terminal.cancel()
    const active = await firstClient.observeActiveWork()
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const history = await runtimeRpc<{ events: Array<{ event: { type: string; data: unknown } }> }>(
      endpoint.port, cookie, 'session.history', { sessionId: opened.sessionId },
    )
    const durableTypes = history.events.map(entry => entry.event.type)
    expect(durableTypes).toContain('user/message')
    expect(durableTypes).toContain('assistant/message')
    expect(durableTypes.filter(type => type === 'turn/end')).toHaveLength(2)

    const transcript = normalizeProtocol({
      events: [opened, completedOutput, partialOutput],
      busy,
      cancelled,
      active,
      durableTypes: durableTypes.filter(type =>
        type === 'user/message' || type === 'assistant/message' || type === 'turn/end'),
    })
    expect(JSON.stringify(transcript)).not.toContain(endpoint.accessToken)
    expect(JSON.stringify(transcript)).not.toContain(runtime.harnessHome)
    expect(transcript).toMatchInlineSnapshot(`
      {
        "active": {
          "ownUiWork": [],
        },
        "busy": {
          "code": "runtime-unavailable",
          "correction": "Observe the active session, open a new session, or wait for the current operation to finish.",
          "diagnosticId": "<diagnostic-id>",
          "message": "Another client is already writing this session.",
          "subject": "Runtime",
        },
        "cancelled": {
          "kind": "cancelled",
        },
        "durableTypes": [
          "user/message",
          "user/message",
          "assistant/message",
          "turn/end",
          "user/message",
          "turn/end",
        ],
        "events": [
          {
            "kind": "session-opened",
            "sessionId": "<session-id>",
          },
          {
            "kind": "output",
            "text": "REAL_RUNTIME_OUTPUT",
          },
          {
            "kind": "output",
            "text": "partial",
          },
        ],
      }
    `)

    await terminal.close()
    terminal = undefined
    await firstClient.close()
    firstClient = undefined
    await secondClient.close()
    secondClient = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 120_000)
})
