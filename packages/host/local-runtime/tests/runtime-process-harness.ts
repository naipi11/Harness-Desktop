/** Shared real-process harness for source and built Runtime-bin acceptance. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  resolveExampleLaunch,
  type ExampleMode,
} from '../../../test-support/loader-smoke/src/index.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const sourceBin = join(packageRoot, 'src', 'bin.ts')
const sourceBackendFixture = fileURLToPath(new URL('./fixtures/runtime-source-backend.ts', import.meta.url))
const sourceToolSkill = new URL('../../../skill/tool-skill/src/index.ts', import.meta.url).href
const sourceUserSkillFixture = new URL('./fixtures/runtime-user-skill.ts', import.meta.url).href
const sourceApprovalToolFixture = new URL('./fixtures/runtime-approval-tool.ts', import.meta.url).href
const sourceRacingSkillConsumer = new URL('./fixtures/runtime-racing-skill-consumer.ts', import.meta.url).href
const processHook = fileURLToPath(new URL('./fixtures/runtime-process-hooks.mjs', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const PROCESS_TIMEOUT_MS = 45_000

interface PackageManifest {
  bin: Record<string, string>
}

/** One externally observed process trace row. */
export interface RuntimeTraceEvent {
  readonly event: string
  readonly address?: string
  readonly port?: number
  readonly code?: number
  readonly url?: string
  readonly plane?: 'src' | 'lib' | 'other'
  readonly value?: string
}

/** Running Runtime bin plus its isolated writable roots and captured streams. */
export interface RuntimeProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly cwd: string
  readonly harnessHome: string
  readonly legacyHome: string
  readonly platformHome: string
  readonly tracePath: string
  readonly stdout: () => string
  readonly stderr: () => string
}

/** Completed Runtime process observation. */
export interface RuntimeProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly trace: RuntimeTraceEvent[]
}

/** Options for one source or built Runtime-bin process. */
export interface StartRuntimeProcessOptions {
  readonly mode: ExampleMode
  readonly entry?: 'runtime-bin' | 'source-backend-fixture'
  readonly denyWorkspaceLib?: boolean
  readonly observeWorkspaceModules?: boolean
  readonly harnessHomeEnv?: string
  readonly failImport?: string
  readonly failureMessage?: string
  /** Mount the deterministic user-only skill with or without its real pre-step consumer. */
  readonly userSkillPreset?: 'consumer-mounted' | 'consumer-missing'
  /** Mount the deterministic tool that asks the real approval service once. */
  readonly terminalApprovalPreset?: boolean
  /** Mount a scoped skill consumer that revokes itself during catalog discovery. */
  readonly racingSkillConsumerPreset?: boolean
  /** Seed one supported legacy session so first-start migration needs an explicit decision. */
  readonly legacySession?: boolean
  /** Force the composed session-create owner to reject terminal opens. */
  readonly terminalUnavailable?: boolean
  /** Rewrite every terminal open to one fixed session for real busy-process coverage. */
  readonly fixedTerminalSessionId?: string
  /** Start with Electron's Node-mode marker so the Runtime entry must consume it. */
  readonly electronRunAsNode?: string
  /** Spawn one post-listen descendant that reports whether the marker survived. */
  readonly probeDescendantEnvironment?: boolean
}

/** Start the real declared/source Runtime bin with an isolated home and observation hook. */
export async function startRuntimeProcess(options: StartRuntimeProcessOptions): Promise<RuntimeProcess> {
  const cwd = await mkdtemp(join(tmpdir(), `harness-runtime-${options.mode}-`))
  const harnessHome = join(cwd, 'selected-harness-home')
  const legacyHome = join(cwd, 'legacy-dsh-home')
  const platformHome = join(cwd, 'platform-default-home')
  const tracePath = join(cwd, 'runtime-trace.jsonl')
  if (options.legacySession === true) {
    await mkdir(join(legacyHome, 'sessions'), { recursive: true })
    await writeFile(join(legacyHome, 'sessions', 'legacy.jsonl'), '{"legacy":true}\n')
  }
  await mkdir(join(harnessHome, '.agent-presets', 'standard'), { recursive: true })
  const agentPreset = [
    ...options.userSkillPreset === undefined ? [] : [
      ...options.userSkillPreset === 'consumer-mounted' ? [{ name: sourceToolSkill }] : [],
      { name: sourceUserSkillFixture },
    ],
    ...options.terminalApprovalPreset === true ? [{ name: sourceApprovalToolFixture }] : [],
    ...options.racingSkillConsumerPreset === true ? [{ name: sourceRacingSkillConsumer }] : [],
  ]
  await writeFile(
    join(harnessHome, '.agent-presets', 'standard', 'agent.cordis.yml'),
    `${JSON.stringify(agentPreset, undefined, 2)}\n`,
  )

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
  const declaredBin = resolve(packageRoot, manifest.bin['harness-runtime'] ?? '')
  const selectedSource = options.entry === 'source-backend-fixture' ? sourceBackendFixture : sourceBin
  if (options.entry === 'source-backend-fixture' && options.mode !== 'src') {
    throw new Error('Runtime source-backend fixture is source-only')
  }
  const launch = resolveExampleLaunch({
    srcBin: selectedSource,
    libBin: declaredBin,
    mode: options.mode,
    tsconfigPath: repoTsconfig,
  })
  const entry = options.mode === 'src' ? selectedSource : declaredBin
  const entryIndex = launch.args.indexOf(entry)
  if (entryIndex < 0) throw new Error(`Runtime ${options.mode} launch did not contain its entry`)
  const args = [
    ...launch.args.slice(0, entryIndex),
    '--import', pathToFileURL(processHook).href,
    ...launch.args.slice(entryIndex),
  ]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    HARNESS_HOME: options.harnessHomeEnv ?? harnessHome,
    DSH_HOME: legacyHome,
    HOME: platformHome,
    USERPROFILE: platformHome,
    APPDATA: join(platformHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(platformHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(platformHome, '.config'),
    HARNESS_RUNTIME_TEST_MODE: 'stdin-lifetime',
    HARNESS_RUNTIME_TEST_TRACE: tracePath,
    ...(options.legacySession === true ? { DSH_RUNTIME_TEST_ENABLE_LEGACY_MIGRATION: '1' } : {}),
    ...(options.terminalUnavailable === true ? { DSH_RUNTIME_TEST_TERMINAL_UNAVAILABLE: '1' } : {}),
    ...(options.fixedTerminalSessionId === undefined
      ? {}
      : { DSH_RUNTIME_TEST_FIXED_TERMINAL_SESSION: options.fixedTerminalSessionId }),
    ...(options.denyWorkspaceLib === true ? { HARNESS_RUNTIME_TEST_DENY_WORKSPACE_LIB_ROOT: repoRoot } : {}),
    ...(options.observeWorkspaceModules === true ? { HARNESS_RUNTIME_TEST_OBSERVE_WORKSPACE_ROOT: repoRoot } : {}),
    ...(options.failImport === undefined ? {} : { HARNESS_RUNTIME_TEST_FAIL_IMPORT: options.failImport }),
    ...(options.failureMessage === undefined
      ? {}
      : { HARNESS_RUNTIME_TEST_FAILURE_MESSAGE: options.failureMessage.replace('{HARNESS_HOME}', harnessHome) }),
    ...(options.electronRunAsNode === undefined ? {} : { ELECTRON_RUN_AS_NODE: options.electronRunAsNode }),
    ...(options.probeDescendantEnvironment === true ? { HARNESS_RUNTIME_TEST_PROBE_DESCENDANT_ENV: '1' } : {}),
  }
  const child = spawn(launch.command, args, { cwd, env, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  return {
    child,
    cwd,
    harnessHome,
    legacyHome,
    platformHome,
    tracePath,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

/** Wait until the Runtime publishes its private endpoint record. */
export async function waitForEndpoint(runtime: RuntimeProcess): Promise<{
  readonly port: number
  readonly accessToken: string
}> {
  const path = join(runtime.harnessHome, 'runtime-endpoint.json')
  const deadline = Date.now() + PROCESS_TIMEOUT_MS
  for (;;) {
    try {
      const record = JSON.parse(await readFile(path, 'utf8')) as { port: number; accessToken: string }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (runtime.child.exitCode !== null) {
        let trace = ''
        try {
          trace = await readFile(runtime.tracePath, 'utf8')
        } catch (traceError) {
          if ((traceError as NodeJS.ErrnoException).code !== 'ENOENT') throw traceError
        }
        throw new Error(`Runtime exited before readiness. stdout:\n${runtime.stdout()}stderr:\n${runtime.stderr()}trace:\n${trace}`)
      }
      if (Date.now() >= deadline) throw new Error(`Runtime did not publish an endpoint. stderr:\n${runtime.stderr()}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

/** Request a graceful test lifetime release by closing stdin. */
export async function releaseRuntime(runtime: RuntimeProcess): Promise<RuntimeProcessResult> {
  await appendFile(runtime.tracePath, JSON.stringify({ event: 'release-requested' }) + '\n')
  runtime.child.stdin.end()
  return waitForRuntimeExit(runtime)
}

/** Wait for the child outcome and parse its process trace. */
export async function waitForRuntimeExit(runtime: RuntimeProcess): Promise<RuntimeProcessResult> {
  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      resolveOutcome({ exitCode: runtime.child.exitCode, signal: runtime.child.signalCode })
      return
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      runtime.child.kill('SIGKILL')
    }, PROCESS_TIMEOUT_MS)
    runtime.child.once('exit', (exitCode, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`Runtime did not exit. stdout:\n${runtime.stdout()}stderr:\n${runtime.stderr()}`))
        return
      }
      resolveOutcome({ exitCode, signal })
    })
  })
  let traceText = ''
  try {
    traceText = await readFile(runtime.tracePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const trace = traceText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as RuntimeTraceEvent)
  return { ...outcome, stdout: runtime.stdout(), stderr: runtime.stderr(), trace }
}

/** Force-stop a failed test process, then remove only its owned temporary directory. */
export async function cleanupRuntimeProcess(runtime: RuntimeProcess | undefined): Promise<void> {
  if (runtime === undefined) return
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGKILL')
    await new Promise(resolve => runtime.child.once('exit', resolve))
  }
  await rm(runtime.cwd, { recursive: true, force: true })
}

/** Recursively list regular files below an externally selected root. */
export async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return listFiles(path)
    return entry.isFile() ? [path] : []
  }))
  return nested.flat()
}

/** Mint one authenticated browser carrier through the real native-control exchange. */
export async function mintBrowserCookie(port: number, accessToken: string): Promise<string> {
  const origin = `http://127.0.0.1:${String(port)}`
  const minted = await fetch(`${origin}/_harness/control/browser-handoff`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-harness-runtime-client': 'runtime-process-browser-client',
    },
  })
  if (!minted.ok) throw new Error(`Runtime handoff mint failed with HTTP ${String(minted.status)}`)
  const handoff = await minted.json() as { id: string }
  const exchanged = await fetch(`${origin}/_harness/handoff`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    body: new URLSearchParams({ handoff: handoff.id }),
  })
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
  if (exchanged.status !== 303 || cookie === undefined) {
    throw new Error(`Runtime handoff exchange failed with HTTP ${String(exchanged.status)}`)
  }
  return cookie
}

/** Invoke one authenticated unary method over the real HTTP API carrier. */
export async function runtimeRpc<T>(
  port: number,
  cookie: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const origin = `http://127.0.0.1:${String(port)}`
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ type: 'client-request', rpcId: `runtime-${randomUUID()}`, method, payload }),
  })
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { message: string } }
  }
  if (!response.ok) throw new Error(`Runtime ${method} carrier failed with HTTP ${String(response.status)}`)
  if (!body.result.ok) throw new Error(`Runtime ${method} failed: ${body.result.error.message}`)
  return body.result.value
}

/** Invoke one cookie-authenticated Dashboard control operation. */
export async function dashboardControl<T>(
  port: number,
  cookie: string,
  operation: 'observe-active-work' | 'stop-own-ui-work',
): Promise<T> {
  const origin = `http://127.0.0.1:${String(port)}`
  const response = await fetch(`${origin}/_harness/dashboard-control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ operation }),
  })
  const body = await response.json() as {
    ok: true
    value: T
  } | {
    ok: false
    result: { kind: string }
  }
  if (!response.ok) throw new Error(`Dashboard control carrier failed with HTTP ${String(response.status)}`)
  if (!body.ok) throw new Error(`Dashboard control failed: ${body.result.kind}`)
  return body.value
}
