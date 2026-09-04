/** Real PTY coverage for Ink scrollback, controls, approvals, resize, color, and cancellation. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@harness-desktop/dsh-loader-smoke'
import { createRuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import type { RuntimeClient, TerminalConnection } from '@harness-desktop/dsh-host-local-runtime'
import {
  cleanupRuntimeProcess,
  mintBrowserCookie,
  runtimeRpc,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliSource = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const cliBuilt = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
let runtime: RuntimeProcess | undefined
let replayRoot: string | undefined
let livePty: pty.IPty | undefined
let runtimeProbe: RuntimeClient | undefined
let busyClient: RuntimeClient | undefined
let busyTerminal: TerminalConnection | undefined

afterEach(async () => {
  livePty?.kill()
  livePty = undefined
  await runtimeProbe?.close()
  runtimeProbe = undefined
  await busyTerminal?.cancel()
  await busyTerminal?.close()
  busyTerminal = undefined
  await busyClient?.close()
  busyClient = undefined
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
  if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
  replayRoot = undefined
})

function success(text: string): object {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

function approvalToolCall(): object {
  const toolName = 'runtime_approval'
  const argumentsText = '{}'
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'pty-approval-call', name: toolName, argumentsDelta: argumentsText },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'pty-approval-call', name: toolName, arguments: argumentsText } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

async function startRuntimeWithReplay(
  entries: readonly object[],
  options: {
    readonly legacySession?: boolean
    readonly terminalUnavailable?: boolean
    readonly fixedTerminalSessionId?: string
  } = {},
): Promise<RuntimeProcess> {
  replayRoot = await mkdtemp(join(tmpdir(), 'harness-cli-pty-replay-'))
  const override = join(replayRoot, 'replay.override.json')
  await writeFile(override, `${JSON.stringify(entries, undefined, 2)}\n`)
  const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
  const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
  process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${override}.missing`
  process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = override
  try {
    return await startRuntimeProcess({
      mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true, terminalApprovalPreset: true,
      ...(options.legacySession === true ? { legacySession: true } : {}),
      ...(options.terminalUnavailable === true ? { terminalUnavailable: true } : {}),
      ...(options.fixedTerminalSessionId === undefined
        ? {}
        : { fixedTerminalSessionId: options.fixedTerminalSessionId }),
    })
  } finally {
    if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
    if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
  }
}

interface PtyRun {
  readonly terminal: pty.IPty
  readonly output: () => string
  readonly exited: Promise<{ exitCode: number; signal?: number }>
}

function startCliPty(runtimeProcess: RuntimeProcess, args: readonly string[] = []): PtyRun {
  const launch = resolveExampleLaunch({
    srcBin: cliSource,
    libBin: cliBuilt,
    mode: resolveExampleMode(),
    tsconfigPath: repoTsconfig,
    configArgs: args,
  })
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    ...launch.env,
    HARNESS_HOME: runtimeProcess.harnessHome,
    DSH_HOME: runtimeProcess.legacyHome,
    HOME: runtimeProcess.platformHome,
    USERPROFILE: runtimeProcess.platformHome,
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const terminal = pty.spawn(launch.command, launch.args, {
    cwd: runtimeProcess.cwd,
    env,
    cols: 100,
    rows: 30,
    name: 'xterm-256color',
  })
  livePty = terminal
  let text = ''
  terminal.onData((data) => { text += data })
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    terminal.onExit(resolve)
  })
  return { terminal, output: () => text, exited }
}

async function waitForOutput(run: PtyRun, text: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!run.output().includes(text)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${JSON.stringify(text)}. output:\n${run.output()}\nRuntime exit: ${String(runtime?.child.exitCode)} / ${String(runtime?.child.signalCode)}\nRuntime stderr:\n${runtime?.stderr() ?? ''}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function sendLine(run: PtyRun, line: string): Promise<void> {
  for (const character of line) {
    run.terminal.write(character)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  run.terminal.write('\r')
  await new Promise(resolve => setTimeout(resolve, 75))
}

async function waitForExit(run: PtyRun, timeoutMs = 20_000): Promise<{ exitCode: number; signal?: number }> {
  return Promise.race([
    run.exited,
    new Promise<never>((_resolve, reject) => setTimeout(() => {
      reject(new Error(`PTY did not exit. output:\n${run.output()}\nRuntime stderr:\n${runtime?.stderr() ?? ''}`))
    }, timeoutMs)),
  ])
}

describe('interactive terminal real PTY', () => {
  it('keeps ordinary scrollback through tool approval, all slash controls, resize, and first cancellation', async () => {
    runtime = await startRuntimeWithReplay([approvalToolCall(), success('PTY_APPROVED'), { kind: 'hang' }])
    const endpoint = await waitForEndpoint(runtime)
    runtimeProbe = await createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    }).connect({ start: false })
    expect((await runtimeProbe.status()).state).toBe('running')
    const run = startCliPty(runtime)
    await waitForOutput(run, 'Harness>')

    await sendLine(run, '/model')
    await waitForOutput(run, 'Model: deepseek-v4-flash')
    await sendLine(run, 'exercise approval')
    await waitForOutput(run, 'approve/reject')
    await sendLine(run, 'approve')
    await waitForOutput(run, 'PTY_APPROVED')
    const match = run.output().match(/Session (session-[0-9a-f-]+)/u)
    if (match?.[1] === undefined) throw new Error('missing session id')
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const history = await runtimeRpc<{ events: Array<{ event: { type: string; data: unknown } }> }>(
      endpoint.port, cookie, 'session.history', { sessionId: match[1] },
    )
    expect(history.events.map(entry => entry.event.type), JSON.stringify(history.events, undefined, 2)).toContain('approval/asked')

    for (const command of [
      '/model', '/permissions danger-full-access', '/plan', '/compact', '/resume', '/diff', '/terminal', '/doctor',
    ]) await sendLine(run, command)
    run.terminal.resize(42, 18)
    await sendLine(run, '/doctor')

    await sendLine(run, 'cancel the hanging replay')
    await waitForOutput(run, 'partial')
    run.terminal.write('\u0003')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(run.output()).toContain('Harness>')
    await sendLine(run, '/exit')
    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(0)
    expect(run.output()).toContain('Tool: runtime_approval')
    expect(run.output()).toContain('PTY_APPROVED')
    expect(run.output()).toContain('Model: deepseek-v4-flash')
    for (const command of ['PLAN', 'COMPACT', 'DIFF', 'TERMINAL', 'DOCTOR']) {
      expect(run.output()).toContain(`RUNTIME_CONTROL_${command}`)
    }
    expect(run.output()).not.toContain('The local Harness Runtime is not running.')
    expect(run.output()).not.toMatch(/\u001b\[\?(?:47|1047|1049)[hl]/u)
    expect(run.output()).not.toMatch(/\u001b\[(?:3[0-7]|9[0-7])m/u)
    livePty = undefined
  }, 120_000)

  it('exits 131 on a second Ctrl+C while Runtime cancellation is pending', async () => {
    runtime = await startRuntimeWithReplay([{ kind: 'hang' }])
    await waitForEndpoint(runtime)
    const run = startCliPty(runtime)
    await waitForOutput(run, 'Harness>')
    await sendLine(run, '/model')
    await waitForOutput(run, 'Model: deepseek-v4-flash')
    await sendLine(run, 'force cancellation')
    await waitForOutput(run, 'partial')

    run.terminal.write('\u0003\u0003')
    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(131)
    expect(run.output()).not.toMatch(/\u001b\[\?(?:47|1047|1049)[hl]/u)
    livePty = undefined
  }, 120_000)

  it('returns 130 after a non-interactive Runtime cancellation completes', async () => {
    runtime = await startRuntimeWithReplay([{ kind: 'hang' }])
    await waitForEndpoint(runtime)
    const run = startCliPty(runtime, ['run', 'cancel from JSON mode', '--json'])
    await waitForOutput(run, 'partial')

    run.terminal.write('\u0003')
    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(130)
    const records = run.output().split(/\r?\n/u)
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as { kind: string; text?: string })
    expect(records).toContainEqual({ kind: 'output', text: 'partial' })
    livePty = undefined
  }, 120_000)

  it('returns argument code 2 through the real PTY entry without starting another Runtime', async () => {
    runtime = await startRuntimeWithReplay([])
    await waitForEndpoint(runtime)
    const run = startCliPty(runtime, ['run', '--json'])

    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(2)
    expect(run.output()).toContain('run needs exactly one task')
    livePty = undefined
  }, 120_000)

  it('returns code 5 for non-interactive first-start migration without copying legacy data', async () => {
    runtime = await startRuntimeWithReplay([], { legacySession: true })
    await waitForEndpoint(runtime)
    const source = join(runtime.legacyHome, 'sessions', 'legacy.jsonl')
    const run = startCliPty(runtime, ['run', 'must wait for migration', '--json'])

    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(5)
    expect(run.output()).toContain('migration-decision-required')
    expect(await readFile(source, 'utf8')).toBe('{"legacy":true}\n')
    livePty = undefined
  }, 120_000)

  it('continues after the user explicitly declines first-start migration', async () => {
    runtime = await startRuntimeWithReplay([], { legacySession: true })
    await waitForEndpoint(runtime)
    const run = startCliPty(runtime)
    await waitForOutput(run, 'Type import or decline')

    await sendLine(run, 'decline')
    await waitForOutput(run, 'Legacy data import declined')
    await sendLine(run, '/exit')
    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(0)
    expect(await readFile(join(runtime.legacyHome, 'sessions', 'legacy.jsonl'), 'utf8')).toBe('{"legacy":true}\n')
    livePty = undefined
  }, 120_000)

  it('returns code 3 when the real Runtime terminal owner is unavailable', async () => {
    runtime = await startRuntimeWithReplay([], { terminalUnavailable: true })
    await waitForEndpoint(runtime)
    const run = startCliPty(runtime, ['run', 'unavailable Runtime operation', '--json'])

    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(3)
    expect(run.output()).toContain('runtime-unavailable')
    livePty = undefined
  }, 120_000)

  it('returns code 4 when a real connector owns the fixed Runtime session', async () => {
    const fixedSessionId = 'fixed-terminal-busy-session'
    runtime = await startRuntimeWithReplay([{ kind: 'hang' }], { fixedTerminalSessionId: fixedSessionId })
    await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    busyClient = await connector.connect({ start: false })
    busyTerminal = await busyClient.openTerminal({
      workspace: runtime.cwd,
      initialTask: 'hold the fixed session writer',
    })
    expect((await busyClient.observeActiveWork()).ownUiWork).toHaveLength(1)
    const run = startCliPty(runtime, ['run', 'must be rejected as busy', '--json'])

    const outcome = await waitForExit(run)

    expect(outcome.exitCode).toBe(4)
    expect(run.output()).toContain('Another client is already writing this session.')
    livePty = undefined
  }, 120_000)
})
