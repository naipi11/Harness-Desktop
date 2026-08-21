/** Real Runtime and Electron ownership for Desktop end-to-end acceptance. */

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type Request,
  type Response,
} from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const runtimeEntry = fileURLToPath(new URL('./runtime-live-entry.mjs', import.meta.url))
const runtimeLockHolder = fileURLToPath(new URL('./runtime-lock-holder.mjs', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const runtimeModuleHook = fileURLToPath(new URL('./runtime-module-hook.mjs', import.meta.url))
const runtimeSeed = fileURLToPath(new URL('./runtime-seed.mjs', import.meta.url))
const browseHost = fileURLToPath(new URL(
  '../../../../packages/host/directory-picker-browse/src/index.ts', import.meta.url,
))
const browseClient = fileURLToPath(new URL(
  '../../../../packages/client/ui-directory-picker-browse/src/index.ts', import.meta.url,
))
const cordisModule = fileURLToPath(new URL('../../../../vendor/cordis/lib/index.js', import.meta.url))
const sessionModule = fileURLToPath(new URL('../../../../packages/core/session/lib/index.js', import.meta.url))
const persistenceModule = fileURLToPath(new URL(
  '../../../../packages/session/session-persistence-jsonl/lib/index.js', import.meta.url,
))
const llmModule = fileURLToPath(new URL('../../../../packages/llm/llm/lib/index.js', import.meta.url))
const processTimeoutMs = 45_000

/** Canonical Runtime process roots and captured diagnostics owned by this fixture. */
export interface RuntimeProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly cwd: string
  readonly harnessHome: string
  readonly platformHome: string
  readonly workspace: string
  readonly stderr: () => string
}

interface RuntimeWorld {
  readonly cwd: string
  readonly harnessHome: string
  readonly platformHome: string
  readonly workspace: string
}

/** One captured browser request with post data retained only inside the test process. */
export interface DesktopRequestCapture {
  readonly url: string
  readonly method: string
  readonly referrer: string | undefined
  readonly headers: Record<string, string>
  readonly body: string | null
}

/** One captured HTTP response used to inspect browser-enforced headers. */
export interface DesktopResponseCapture {
  readonly url: string
  readonly status: number
  readonly headers: Record<string, string>
}

/** Running canonical Runtime plus the Electron Desktop attached to it. */
export interface DesktopRuntimeFixture {
  readonly application: ElectronApplication
  readonly page: Page
  readonly runtime: RuntimeProcess
  readonly origin: string
  readonly requests: DesktopRequestCapture[]
  readonly responses: DesktopResponseCapture[]
  readonly rendererErrors: string[]
  readonly desktopOutput: () => string
  close(): Promise<void>
}

/** Desktop launched while another live process owns its selected Runtime home. */
export interface DesktopFailureFixture {
  readonly application: ElectronApplication
  readonly page: Page
  readonly requests: DesktopRequestCapture[]
  releaseStartLock(): Promise<void>
  startRuntime(): Promise<string>
  close(): Promise<void>
}



/** Start the built canonical Runtime and real built Electron application. */
export async function launchDesktopRuntimeFixture(): Promise<DesktopRuntimeFixture> {
  const runtime = await startCanonicalRuntimeProcess()
  let application: ElectronApplication | undefined
  try {
    const endpoint = await waitForEndpoint(runtime)
    application = await electron.launch({
      args: [mainEntry, '--lang=en-US'],
      env: {
        ...process.env,
        HARNESS_HOME: runtime.harnessHome,
        HOME: runtime.platformHome,
        USERPROFILE: runtime.platformHome,
        APPDATA: join(runtime.platformHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(runtime.platformHome, 'AppData', 'Local'),
      },
    })
    const requests: DesktopRequestCapture[] = []
    const responses: DesktopResponseCapture[] = []
    let desktopOutput = ''
    application.process().stdout?.setEncoding('utf8').on('data', (chunk: string) => { desktopOutput += chunk })
    application.context().on('request', (request: Request) => {
      requests.push({
        url: request.url(),
        method: request.method(),
        referrer: request.headers()['referer'],
        headers: request.headers(),
        body: request.postData(),
      })
    })
    application.context().on('response', async (response: Response) => {
      responses.push({ url: response.url(), status: response.status(), headers: await response.allHeaders() })
    })
    const page = await application.firstWindow()
    const rendererErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') rendererErrors.push(message.text())
    })
    page.on('pageerror', (error) => { rendererErrors.push(String(error)) })
    return {
      application,
      page,
      runtime,
      origin: `http://127.0.0.1:${String(endpoint.port)}`,
      requests,
      responses,
      rendererErrors,
      desktopOutput: () => desktopOutput,
      async close() {
        const failures: unknown[] = []
        await application?.close().catch((error: unknown) => failures.push(error))
        await releaseRuntime(runtime).catch((error: unknown) => failures.push(error))
        await cleanupRuntimeProcess(runtime).catch((error: unknown) => failures.push(error))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Desktop fixture cleanup failed')
      },
    }
  } catch (error) {
    await application?.close().catch(() => {})
    await cleanupRuntimeProcess(runtime)
    throw error
  }
}

/** Launch Desktop through initial and explicit-retry failures held by a real Runtime lock. */
export async function launchDesktopFailureFixture(): Promise<DesktopFailureFixture> {
  const world = await prepareRuntimeWorld(false)
  const holder = spawn(process.execPath, [runtimeLockHolder], {
    cwd: world.cwd,
    windowsHide: true,
    env: runtimeEnvironment(world),
  })
  let holderStderr = ''
  holder.stderr.setEncoding('utf8').on('data', (chunk: string) => { holderStderr += chunk })
  await waitForProcessMarker(holder, () => holderStderr, 'desktop-runtime-lock-holder: ready')
  let application: ElectronApplication | undefined
  let runtime: RuntimeProcess | undefined
  let holderReleased = false
  const releaseHolder = async (): Promise<void> => {
    if (holderReleased) return
    holderReleased = true
    holder.stdin.end()
    const exitCode = await waitForChildExit(holder, () => holderStderr)
    if (exitCode !== 0) throw new Error(`Desktop Runtime lock holder exited with ${String(exitCode)}: ${holderStderr}`)
  }
  try {
    application = await electron.launch({
      args: [mainEntry, '--lang=en-US'],
      env: runtimeEnvironment(world),
    })
    const requests: DesktopRequestCapture[] = []
    application.context().on('request', (request: Request) => {
      requests.push({
        url: request.url(), method: request.method(), referrer: request.headers()['referer'],
        headers: request.headers(), body: request.postData(),
      })
    })
    const page = await application.firstWindow()
    return {
      application,
      page,
      requests,
      releaseStartLock: releaseHolder,
      async startRuntime() {
        runtime ??= startCanonicalRuntimeInWorld(world)
        const endpoint = await waitForEndpoint(runtime)
        return `http://127.0.0.1:${String(endpoint.port)}`
      },
      async close() {
        const failures: unknown[] = []
        await application?.close().catch((error: unknown) => failures.push(error))
        await releaseHolder().catch((error: unknown) => failures.push(error))
        if (runtime === undefined) {
          await rm(world.cwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
        } else {
          await releaseRuntime(runtime).catch((error: unknown) => failures.push(error))
          await cleanupRuntimeProcess(runtime).catch((error: unknown) => failures.push(error))
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Desktop failure fixture cleanup failed')
      },
    }
  } catch (error) {
    await application?.close().catch(() => {})
    await releaseHolder().catch(() => {})
    if (runtime === undefined) await rm(world.cwd, { recursive: true, force: true })
    else await cleanupRuntimeProcess(runtime)
    throw error
  }
}

function runtimeEnvironment(world: RuntimeWorld): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    )),
    HARNESS_HOME: world.harnessHome,
    HOME: world.platformHome,
    USERPROFILE: world.platformHome,
    APPDATA: join(world.platformHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(world.platformHome, 'AppData', 'Local'),
  }
}

async function waitForProcessMarker(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + processTimeoutMs
  while (!stderr().includes(marker)) {
    if (child.exitCode !== null) throw new Error(`Process exited before ${marker}: ${stderr()}`)
    if (Date.now() >= deadline) throw new Error(`Process did not report ${marker}: ${stderr()}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise((resolve, reject) => {
    const onExit = (exitCode: number | null): void => {
      clearTimeout(timer)
      resolve(exitCode)
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      child.kill('SIGKILL')
      reject(new Error(`Process did not exit: ${stderr()}`))
    }, processTimeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null) {
      child.removeListener('exit', onExit)
      clearTimeout(timer)
      resolve(child.exitCode)
    }
  })
}

async function startCanonicalRuntimeProcess(): Promise<RuntimeProcess> {
  return startCanonicalRuntimeInWorld(await prepareRuntimeWorld(true))
}

async function prepareRuntimeWorld(seedHistory: boolean): Promise<RuntimeWorld> {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-desktop-runtime-'))
  const harnessHome = join(cwd, 'harness-home')
  const platformHome = join(cwd, 'platform-home')
  const workspace = join(cwd, 'desktop-workspace')
  await mkdir(join(harnessHome, '.agent-presets', 'standard'), { recursive: true })
  await writeFile(join(harnessHome, '.agent-presets', 'standard', 'agent.cordis.yml'), '[]\n')
  const replayOverride = join(harnessHome, 'desktop-live-replay.override.json')
  await writeFile(replayOverride, `${JSON.stringify(liveReplayScript(), undefined, 2)}\n`)
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.ts'), 'export const desktopFixture = true\n')
  if (seedHistory) await runHistorySeeder(harnessHome, workspace)
  return { cwd, harnessHome, platformHome, workspace }
}

function liveReplayScript(): unknown[] {
  const callId = 'desktop-live-approval-call'
  return [
    {
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Preparing live approval' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Preparing live approval' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id: callId, name: 'runtime_approval', argumentsDelta: '{}' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'runtime_approval', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    },
    {
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'LIVE_' },
        { type: 'text-delta', index: 0, text: 'STREAM_' },
        { type: 'text-delta', index: 0, text: 'COMPLETE' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'LIVE_STREAM_COMPLETE' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ]
}

function startCanonicalRuntimeInWorld(world: RuntimeWorld): RuntimeProcess {
  const { cwd, harnessHome, platformHome, workspace } = world
  const child = spawn(process.execPath, [
    '--import', tsxLoader,
    '--import', pathToFileURL(runtimeModuleHook).href,
    runtimeEntry,
  ], {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_HOME: harnessHome,
      HOME: platformHome,
      USERPROFILE: platformHome,
      APPDATA: join(platformHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(platformHome, 'AppData', 'Local'),
      HARNESS_RUNTIME_TEST_MODE: 'stdin-lifetime',
      TSX_TSCONFIG_PATH: repoTsconfig,
      SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22',
      HARNESS_DESKTOP_BROWSE_HOST: browseHost,
      HARNESS_DESKTOP_BROWSE_CLIENT: browseClient,
      HARNESS_DESKTOP_REPLAY_OVERRIDE: join(harnessHome, 'desktop-live-replay.override.json'),
      DEEPSEEK_API_KEY: '',
    },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  return { child, cwd, harnessHome, platformHome, workspace, stderr: () => stderr }
}

async function runHistorySeeder(harnessHome: string, workspace: string): Promise<void> {
  const child = spawn(process.execPath, [runtimeSeed], {
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_DESKTOP_CORDIS_MODULE: cordisModule,
      HARNESS_DESKTOP_SESSION_MODULE: sessionModule,
      HARNESS_DESKTOP_PERSISTENCE_MODULE: persistenceModule,
      HARNESS_DESKTOP_LLM_MODULE: llmModule,
      HARNESS_DESKTOP_SESSIONS_ROOT: join(harnessHome, 'sessions'),
      HARNESS_DESKTOP_WORKSPACE: workspace,
    },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (exitCode !== 0) throw new Error(`Desktop history seeder exited with ${String(exitCode)}: ${stderr}`)
}

async function waitForEndpoint(runtime: RuntimeProcess): Promise<{ readonly port: number }> {
  const path = join(runtime.harnessHome, 'runtime-endpoint.json')
  const deadline = Date.now() + processTimeoutMs
  for (;;) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { port: number }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (runtime.child.exitCode !== null) {
        throw new Error(`Runtime exited before readiness: ${runtime.stderr()}`)
      }
      if (Date.now() >= deadline) throw new Error(`Runtime readiness timed out: ${runtime.stderr()}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

async function releaseRuntime(runtime: RuntimeProcess): Promise<void> {
  runtime.child.stdin.end()
  const result = await waitForExit(runtime)
  if (result.exitCode !== 0) throw new Error(`Runtime exited with ${String(result.exitCode)}: ${runtime.stderr()}`)
}

async function waitForExit(runtime: RuntimeProcess): Promise<{ readonly exitCode: number | null }> {
  if (runtime.child.exitCode !== null) return { exitCode: runtime.child.exitCode }
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { readonly exitCode: number | null }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      runtime.child.removeListener('exit', onExit)
      resolve(result)
    }
    const onExit = (exitCode: number | null): void => { finish({ exitCode }) }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      runtime.child.removeListener('exit', onExit)
      runtime.child.kill('SIGKILL')
      reject(new Error(`Runtime did not exit: ${runtime.stderr()}`))
    }, processTimeoutMs)
    runtime.child.once('exit', onExit)
    if (runtime.child.exitCode !== null) finish({ exitCode: runtime.child.exitCode })
  })
}

async function cleanupRuntimeProcess(runtime: RuntimeProcess): Promise<void> {
  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGKILL')
    await new Promise(resolve => runtime.child.once('exit', resolve))
  }
  await rm(runtime.cwd, { recursive: true, force: true })
}

/** Seed a physical workspace used by the Dashboard's real native picker. */
export async function seedDesktopWorkspace(runtime: RuntimeProcess): Promise<string> {
  const workspace = join(runtime.cwd, 'picked-workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'picked.ts'), 'export const picked = true\n')
  return workspace
}
