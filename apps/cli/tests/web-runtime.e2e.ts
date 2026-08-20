/** Real source/built Web CLI processes sharing one Runtime and named lease. */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@harness-desktop/dsh-loader-smoke'
import {
  createRuntimeConnector,
  type DashboardAttachment,
  type RuntimeClient,
  type TerminalConnection,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'
import { createBrowserHandoffTransport } from '../src/browser.ts'
import type { TerminalIO } from '../src/terminal-client.ts'

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

type BuiltRunCli = (
  commandName: 'harness' | 'dsh',
  argv: readonly string[],
  dependencies: { readonly connector: ReturnType<typeof createRuntimeConnector>; readonly io: TerminalIO },
) => Promise<number>

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

async function loadBuiltRunCli(): Promise<BuiltRunCli> {
  const bin = await readFile(harnessBuilt, 'utf8')
  const binding = /import \{ ([A-Za-z_$][\w$]*) as runCli \} from "([^"]+)";/u.exec(bin)
  if (binding === null) throw new Error('built harness bin does not reference its CLI bundle')
  const module = await import(new URL(binding[2]!, pathToFileURL(harnessBuilt)).href) as Record<string, unknown>
  const runCli = module[binding[1]!]
  if (typeof runCli !== 'function') throw new Error('built harness CLI bundle does not export its runner binding')
  return runCli as BuiltRunCli
}

function terminalIO(workspace: string): TerminalIO {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    workspace,
    columns: 80,
    colorDepth: 1,
  }
}

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

async function startRuntimeWithHangingReplay(): Promise<RuntimeProcess> {
  replayRoot = await mkdtemp(join(tmpdir(), 'harness-web-runtime-replay-'))
  const override = join(replayRoot, 'replay.override.json')
  await writeFile(override, '[{"kind":"hang"}]\n')
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

describe('Runtime Web client real entry', () => {
  it('shares one Runtime, one Web lease, and a body-only browser handoff across both CLI names', async () => {
    runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    const endpoint = await waitForEndpoint(runtime)
    const endpointPath = join(runtime.harnessHome, 'runtime-endpoint.json')
    const before = JSON.parse(await readFile(endpointPath, 'utf8')) as { runtimeId: string; port: number }
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })
    terminal = await client.openTerminal({ workspace: runtime.cwd })
    expect(await terminal.cancel()).toEqual({ kind: 'idle' })

    dashboard = await client.attachDashboard()
    const navigation = await dashboard.createBrowserHandoff()
    let exchangedBody = ''
    let browserDocumentPath = ''
    const transport = createBrowserHandoffTransport({
      parent: tmpdir(),
      dispatch: async (fileUrl) => {
        expect(fileUrl).not.toContain(navigation.handoff.id)
        browserDocumentPath = fileURLToPath(fileUrl)
        const html = await readFile(browserDocumentPath, 'utf8')
        const action = html.match(/action="([^"]+)"/u)?.[1]
        const handoff = html.match(/name="handoff" value="([^"]+)"/u)?.[1]
        expect(action).toBe(`http://127.0.0.1:${String(endpoint.port)}/_harness/handoff`)
        expect(handoff).toBe(navigation.handoff.id)
        exchangedBody = new URLSearchParams({ handoff: handoff! }).toString()
        const response = await fetch(action!, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
          body: exchangedBody,
        })
        expect(response.status).toBe(303)
        expect(response.headers.get('location')).toBe('/')
        expect(response.headers.get('access-control-allow-origin')).toBeNull()
      },
    })
    await transport.open(navigation)
    await rm(dirname(browserDocumentPath), { recursive: true, force: true })
    expect(exchangedBody).toBe(`handoff=${encodeURIComponent(navigation.handoff.id)}`)
    const replay = await fetch(`${navigation.origin}/_harness/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({ handoff: navigation.handoff.id }),
    })
    expect(replay.status).toBe(403)
    expect(replay.headers.get('access-control-allow-origin')).toBeNull()
    const wrong = await fetch(`${navigation.origin}/_harness/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({ handoff: 'abcdefghijklmnopqrstuvwxyzABCDEF' }),
    })
    expect(wrong.status).toBe(403)
    expect(wrong.headers.get('access-control-allow-origin')).toBeNull()
    await dashboard.close()
    dashboard = undefined

    const daemon = await runProduct(runtime, 'harness', ['web', '--daemon', '--no-open'])
    const background = await runProduct(runtime, 'dsh', ['web', '--background', '--no-open'])
    expect(daemon).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web present\n' })
    expect(background).toEqual(daemon)
    const present = await runProduct(runtime, 'harness', ['web', '--status'])
    expect(present.code, present.stderr).toBe(0)
    expect(present.stderr).toBe('')
    expect(present.stdout).toContain(`Runtime: running (${before.runtimeId})`)
    expect(present.stdout).toContain('Web lease: web present')

    const stopped = await runProduct(runtime, 'dsh', ['web', '--stop'])
    const duplicate = await runProduct(runtime, 'harness', ['web', '--stop'])
    expect(stopped).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web absent\n' })
    expect(duplicate).toEqual(stopped)
    expect((await client.status()).state).toBe('running')
    expect(await terminal.cancel()).toEqual({ kind: 'idle' })
    const after = JSON.parse(await readFile(endpointPath, 'utf8')) as { runtimeId: string; port: number }
    expect(after).toEqual(before)

    await terminal.close()
    terminal = undefined
    await client.close()
    client = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)

  it('releases the Web lease without cancelling active terminal work', async () => {
    runtime = await startRuntimeWithHangingReplay()
    await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })
    terminal = await client.openTerminal({ workspace: runtime.cwd })
    await terminal.submit({ kind: 'task', text: 'remain active across Web lease stop' })
    let before = await client.observeActiveWork()
    for (let attempt = 0; attempt < 100 && before.ownUiWork.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      before = await client.observeActiveWork()
    }
    expect(before.ownUiWork).toHaveLength(1)

    const acquired = await runProduct(runtime, 'harness', ['web', '--daemon', '--no-open'])
    expect(acquired).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web present\n' })
    const stopped = await runProduct(runtime, 'dsh', ['web', '--stop'])
    expect(stopped).toEqual({ code: 0, stderr: '', stdout: 'Web lease: web absent\n' })
    expect(await client.observeActiveWork()).toEqual(before)
    expect(await terminal.cancel()).toEqual({ kind: 'cancelled' })
    expect(await client.observeActiveWork()).toEqual({ ownUiWork: [] })

    await terminal.close()
    terminal = undefined
    await client.close()
    client = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)

  it.runIf(resolveExampleMode() === 'lib')('keeps the bundled browser bootstrap readable after OS dispatch', async () => {
    runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    await waitForEndpoint(runtime)
    let dispatchedUrl = ''
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFile: (...args: unknown[]) => {
          const commandArgs = args[1] as string[]
          const options = args[2] as { readonly env?: NodeJS.ProcessEnv }
          dispatchedUrl = process.platform === 'win32'
            ? options.env?.HARNESS_BROWSER_BOOTSTRAP_URL ?? ''
            : commandArgs[0] ?? ''
          const callback = args.at(-1)
          if (typeof callback !== 'function') throw new Error('built browser dispatch did not supply an execFile callback')
          const complete = callback as ExecFileCallback
          complete(null, '', '')
        },
      }
    })
    let documentPath = ''
    try {
      const runCli = await loadBuiltRunCli()
      const connector = createRuntimeConnector({
        input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
      })
      expect(await runCli('harness', ['web'], { connector, io: terminalIO(runtime.cwd) })).toBe(0)
      expect(dispatchedUrl).toMatch(/^file:/u)
      documentPath = fileURLToPath(dispatchedUrl)
      await expect(readFile(documentPath, 'utf8')).resolves.toContain('name="handoff"')
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
      if (documentPath !== '') await rm(dirname(documentPath), { recursive: true, force: true })
    }
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)

  it('does not create a Runtime endpoint or home for status discovery', async () => {
    runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    await waitForEndpoint(runtime)
    const root = await mkdtemp(join(tmpdir(), 'harness-web-no-start-'))
    const missingHome = join(root, 'missing-home')
    const detachedRuntime = { ...runtime, harnessHome: missingHome }
    try {
      const status = await runProduct(detachedRuntime, 'dsh', ['web', '--status'])
      expect(status.code).toBe(3)
      expect(status.stdout).toBe('')
      expect(status.stderr).toContain('The local Harness Runtime is not running.')
      await expect(access(missingHome)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)
})
