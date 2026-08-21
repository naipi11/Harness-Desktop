/** Real source/built terminal and Web clients retaining one shared Runtime session. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@harness-desktop/dsh-loader-smoke'
import {
  createRuntimeConnector,
  type DashboardAttachment,
  type RuntimeClient,
  type RuntimeId,
  type SessionId,
  type TerminalConnection,
  type TerminalProtocolEvent,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const harnessSource = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const harnessBuilt = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const dshSource = fileURLToPath(new URL('../src/dsh-bin.ts', import.meta.url))
const dshBuilt = fileURLToPath(new URL('../lib/dsh-bin.js', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
let runtime: RuntimeProcess | undefined
let client: RuntimeClient | undefined
let terminal: TerminalConnection | undefined
let dashboard: DashboardAttachment | undefined
let replayRoot: string | undefined

afterEach(async () => {
  await dashboard?.close().catch(() => {})
  dashboard = undefined
  await terminal?.close().catch(() => {})
  terminal = undefined
  await client?.close().catch(() => {})
  client = undefined
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

async function startRuntimeWithReplay(): Promise<RuntimeProcess> {
  replayRoot = await mkdtemp(join(tmpdir(), 'harness-client-acceptance-'))
  const override = join(replayRoot, 'replay.override.json')
  await writeFile(override, `${JSON.stringify([success('CLI_SESSION_READY'), { kind: 'hang' }], undefined, 2)}\n`)
  const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
  const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
  process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${override}.missing`
  process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = override
  try {
    return await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
  } finally {
    if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
    if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
  }
}

async function runProduct(
  runtimeProcess: RuntimeProcess,
  commandName: 'harness' | 'dsh',
  args: readonly string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  const launch = resolveExampleLaunch({
    srcBin: commandName === 'harness' ? harnessSource : dshSource,
    libBin: commandName === 'harness' ? harnessBuilt : dshBuilt,
    mode: resolveExampleMode(),
    tsconfigPath: repoTsconfig,
    configArgs: args,
  })
  const result = await execa(launch.command, launch.args, {
    cwd: runtimeProcess.cwd,
    reject: false,
    timeout: 45_000,
    killSignal: 'SIGKILL',
    stripFinalNewline: false,
    env: {
      ...process.env,
      ...launch.env,
      HARNESS_HOME: runtimeProcess.harnessHome,
      DSH_HOME: runtimeProcess.legacyHome,
      HOME: runtimeProcess.platformHome,
      USERPROFILE: runtimeProcess.platformHome,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    },
  })
  if (result.timedOut) {
    throw new Error(`${commandName} ${args.join(' ')} timed out. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { code: result.exitCode ?? -1, stderr: result.stderr, stdout: result.stdout }
}

async function nextEvent(
  iterator: AsyncIterator<TerminalProtocolEvent>,
  kind: TerminalProtocolEvent['kind'],
): Promise<TerminalProtocolEvent> {
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) throw new Error(`terminal events ended before ${kind}`)
    if (next.value.kind === kind) return next.value
  }
}

async function listDashboardSessions(
  origin: string,
  cookie: string,
  rpcId: string,
): Promise<readonly { readonly sessionId: SessionId }[]> {
  const response = await fetch(`${origin}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }),
  })
  const body = await response.json() as {
    readonly result:
      | { readonly ok: true; readonly value: { readonly items: readonly { readonly sessionId: SessionId }[] } }
      | { readonly ok: false; readonly error: { readonly message: string } }
  }
  if (!response.ok) throw new Error(`Dashboard session.list failed with HTTP ${String(response.status)}`)
  if (!body.result.ok) throw new Error(`Dashboard session.list failed: ${body.result.error.message}`)
  return body.result.value.items
}

describe('shared Runtime client acceptance', () => {
  it.each(['harness', 'dsh'] as const)(
    'keeps %s terminal work active after releasing only the named Web lease',
    async (commandName) => {
      runtime = await startRuntimeWithReplay()
      const endpoint = await waitForEndpoint(runtime)
      const endpointPath = join(runtime.harnessHome, 'runtime-endpoint.json')
      const beforeEndpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as { runtimeId: RuntimeId; port: number }
      const connector = createRuntimeConnector({
        input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
      })
      const initial = await runProduct(runtime, commandName, ['run', `${commandName} opens shared session`, '--json'])
      expect(initial.code, initial.stderr).toBe(0)
      expect(initial.stderr).toBe('')
      const initialEvents = initial.stdout.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as {
        readonly kind: string
        readonly sessionId?: SessionId
        readonly text?: string
      })
      const sessionId = initialEvents.find(event => event.kind === 'session-opened')?.sessionId
      expect(sessionId).toBeDefined()
      expect(initialEvents).toContainEqual({ kind: 'output', text: 'CLI_SESSION_READY' })
      if (sessionId === undefined) throw new Error('terminal CLI did not open a session')

      client = await connector.connect({ start: false })
      terminal = await client.openTerminal({ workspace: runtime.cwd, sessionId })
      const events = terminal.events()[Symbol.asyncIterator]()
      const opened = await nextEvent(events, 'session-opened')
      if (opened.kind !== 'session-opened') throw new Error('expected session-opened')
      expect(opened.sessionId).toBe(sessionId)
      await terminal.submit({ kind: 'task', text: `${commandName} work survives Web stop` })
      let active = await client.observeActiveWork()
      for (let attempt = 0; attempt < 100 && active.ownUiWork.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
        active = await client.observeActiveWork()
      }
      expect(active.ownUiWork).toHaveLength(1)

      dashboard = await client.attachDashboard()
      const navigation = await dashboard.createBrowserHandoff()
      expect(navigation.origin).toBe(`http://127.0.0.1:${String(endpoint.port)}`)
      const exchanged = await fetch(`${navigation.origin}/_harness/handoff`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
        body: new URLSearchParams({ handoff: navigation.handoff.id }),
      })
      expect(exchanged.status).toBe(303)
      expect(exchanged.headers.get('location')).toBe('/')
      const setCookie = exchanged.headers.get('set-cookie')
      expect(setCookie).toContain('HttpOnly')
      const cookie = setCookie?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Dashboard handoff did not issue a cookie')
      const beforeStopSessions = await listDashboardSessions(
        navigation.origin,
        cookie,
        `${commandName}-before-web-stop`,
      )
      expect(beforeStopSessions.some(item => item.sessionId === sessionId)).toBe(true)

      const acquired = await runProduct(runtime, commandName, ['web', '--background', '--no-open'])
      expect(acquired).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web present\n' })
      const status = await runProduct(runtime, commandName, ['web', '--status'])
      expect(status.code, status.stderr).toBe(0)
      expect(status.stderr).toBe('')
      expect(status.stdout).toContain(`Runtime: running (${beforeEndpoint.runtimeId})`)
      expect(status.stdout).toContain(`Dashboard: ${navigation.origin}`)
      expect(status.stdout).toContain('Web lease: web present')

      const stopped = await runProduct(runtime, commandName, ['web', '--stop'])
      expect(stopped).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web absent\n' })
      expect(await client.observeActiveWork()).toEqual(active)
      const afterEndpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as unknown
      expect(afterEndpoint).toEqual(beforeEndpoint)
      const afterStopSessions = await listDashboardSessions(
        navigation.origin,
        cookie,
        `${commandName}-after-web-stop`,
      )
      expect(afterStopSessions.some(item => item.sessionId === sessionId)).toBe(true)

      expect(await terminal.cancel()).toEqual({ kind: 'cancelled' })
      expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })
      await dashboard.close()
      dashboard = undefined
      await terminal.close()
      terminal = undefined
      await client.close()
      client = undefined
      expect((await releaseRuntime(runtime)).exitCode).toBe(0)
      runtime = undefined
    },
    120_000,
  )
})
