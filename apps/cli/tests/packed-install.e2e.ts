import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { packCliForRelease } from '../../../scripts/release/build-cli-standalone.ts'
import {
  collectTerminalReadinessFailure,
  requirePackedCliBuild,
  settlePackedCliChild,
} from './support/packed-install-fixture.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliRoot = fileURLToPath(new URL('..', import.meta.url))
const builtBin = join(cliRoot, 'lib', 'bin.js')
const npmExecutable = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
const roots: string[] = []
const nodeLoaderEnvironmentNames = new Set(['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH'])
const builtCliAvailable = requirePackedCliBuild({
  available: await access(builtBin).then(() => true, () => false),
  required: process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1',
})
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const runtimeUnavailableDiagnostic = new RegExp(
  '^The local Harness Runtime is not running\\.\\n'
  + 'Start Harness again, or retry after the existing Runtime becomes available\\.\\n'
  + `Diagnostic: ${uuidPattern}$`,
  'u',
)
const desktopInstallationRoute: Readonly<Record<NodeJS.Platform, string>> = {
  aix: 'Install Harness Desktop for this platform from GitHub Releases.',
  android: 'Install Harness Desktop for this platform from GitHub Releases.',
  darwin: 'Install Harness Desktop from the macOS universal DMG on GitHub Releases.',
  freebsd: 'Install Harness Desktop for this platform from GitHub Releases.',
  haiku: 'Install Harness Desktop for this platform from GitHub Releases.',
  linux: 'Install Harness Desktop with the Linux Deb package from GitHub Releases.',
  openbsd: 'Install Harness Desktop for this platform from GitHub Releases.',
  sunos: 'Install Harness Desktop for this platform from GitHub Releases.',
  win32: 'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.',
  cygwin: 'Install Harness Desktop for this platform from GitHub Releases.',
  netbsd: 'Install Harness Desktop for this platform from GitHub Releases.',
}

interface ChildResult {
  readonly exitCode?: number
  readonly stdout: string
  readonly stderr: string
}

interface RunningChild extends PromiseLike<ChildResult> {
  readonly pid?: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  kill(signal: NodeJS.Signals): boolean
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 100,
    retryDelay: 100,
  })))
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label))
  roots.push(root)
  return root
}

function packedChildEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const checkout = repoRoot.toLowerCase()
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(base).filter(([name, value]) => {
    const normalized = name.toUpperCase()
    return normalized !== 'PATH'
      && !nodeLoaderEnvironmentNames.has(normalized)
      && !normalized.startsWith('TS_NODE_')
      && (value === undefined || !value.toLowerCase().includes(checkout))
  }))
  const systemRoot = Object.entries(base)
    .find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1]
  const pathEntries = [dirname(process.execPath)]
  if (process.platform === 'win32') {
    if (systemRoot === undefined) throw new Error('packed CLI child environment: SystemRoot is missing')
    pathEntries.push(
      join(systemRoot, 'System32'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    )
  } else {
    pathEntries.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }
  environment.PATH = [...new Set(pathEntries)].join(delimiter)
  return environment
}

function withoutEnvironmentNames(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const omitted = new Set(names.map(name => name.toUpperCase()))
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !omitted.has(name.toUpperCase())))
}

async function waitForJsonFile<T>(path: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (Date.now() >= deadline) throw new Error(`packed CLI fixture timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForChildLine(
  lines: AsyncIterator<string>,
  label: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    lines.next().then(result => ({ kind: 'line' as const, result })),
    new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => { resolve({ kind: 'timeout' }) }, timeoutMs)
      timeout.unref()
    }),
  ])
  if (timeout !== undefined) clearTimeout(timeout)
  if (outcome.kind === 'timeout') throw new Error(`packed CLI fixture timed out waiting for ${label}`)
  if (outcome.result.done === true) throw new Error(`packed CLI fixture child exited before ${label}`)
  return JSON.parse(outcome.result.value) as Record<string, unknown>
}

function writeChildLine(child: RunningChild, line: string): void {
  if (child.stdin === null) throw new Error('packed CLI fixture child has no stdin')
  child.stdin.write(`${line}\n`)
}

function installedRunCliLoader(installedBin: string): string {
  return [
    "import { readFile } from 'node:fs/promises'",
    "import { pathToFileURL } from 'node:url'",
    `const installedBin = ${JSON.stringify(installedBin)}`,
    "const binSource = await readFile(installedBin, 'utf8')",
    'const binding = /import \\{ ([A-Za-z_$][\\w$]*) as runCli \\} from "([^"]+)";/u.exec(binSource)',
    "if (binding === null) throw new Error('installed harness bin does not reference its CLI bundle')",
    'const cliModule = await import(new URL(binding[2], pathToFileURL(installedBin)).href)',
    'const runCli = cliModule[binding[1]]',
    "if (typeof runCli !== 'function') throw new Error('installed harness CLI bundle does not export its runner binding')",
  ].join('\n')
}

async function runInstalledDriver(
  root: string,
  name: string,
  source: string,
  environment: NodeJS.ProcessEnv,
) {
  const driver = join(root, name)
  await writeFile(driver, `${source}\n`)
  return execa(process.execPath, [driver], {
    cwd: root,
    env: environment,
    extendEnv: false,
    reject: false,
    timeout: 30_000,
  })
}

async function exerciseInstalledRuntime(input: {
  readonly root: string
  readonly packageRoot: string
  readonly harness: string
  readonly dsh: string
  readonly harnessHome: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<void> {
  const runtimeBin = join(
    input.packageRoot,
    'node_modules',
    '@harness-desktop',
    'dsh-host-local-runtime',
    'lib',
    'bin.js',
  )
  const connectorEntry = join(dirname(runtimeBin), 'index.js')
  const helper = join(input.root, 'installed-terminal-client.mjs')
  // The direct Runtime entry consumes the same user-owned keyless preset that its process harness supplies.
  const presetRoot = join(input.harnessHome, '.agent-presets', 'standard')
  await mkdir(presetRoot, { recursive: true })
  await writeFile(join(presetRoot, 'agent.cordis.yml'), '[]\n')
  await writeFile(helper, [
    "import { createInterface } from 'node:readline'",
    `const { createRuntimeConnector } = await import(${JSON.stringify(pathToFileURL(connectorEntry).href)})`,
    "const connector = createRuntimeConnector({ input: { env: process.env, homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '' } })",
    'const client = await connector.connect({ start: false })',
    'const terminal = await client.openTerminal({ workspace: process.env.HARNESS_TEST_WORKSPACE })',
    'const events = terminal.events()[Symbol.asyncIterator]()',
    'const opened = await events.next()',
    "if (opened.done === true || opened.value.kind !== 'session-opened') throw new Error('installed terminal did not publish session-opened')",
    "process.stdout.write(JSON.stringify({ kind: 'terminal-ready', event: opened.value.kind }) + '\\n')",
    'const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })',
    'try {',
    '  for await (const command of commands) {',
    "    if (command === 'probe') {",
    '      const cancellation = await terminal.cancel()',
    '      const status = await client.status()',
    "      process.stdout.write(JSON.stringify({ kind: 'terminal-usable', cancellation: cancellation.kind, state: status.state }) + '\\n')",
    "    } else if (command === 'close') {",
    '      await terminal.close()',
    '      await client.close()',
    "      process.stdout.write(JSON.stringify({ kind: 'terminal-closed' }) + '\\n')",
    '      break',
    '    } else throw new Error(`unknown installed terminal fixture command ${JSON.stringify(command)}`)',
    '  }',
    '} finally {',
    '  await terminal.close().catch(() => {})',
    '  await client.close().catch(() => {})',
    '}',
    '',
  ].join('\n'))

  const runtimeEnvironment = {
    ...withoutEnvironmentNames(input.environment, ['DSH_HOME']),
    HARNESS_RUNTIME_TEST_MODE: 'stdin-lifetime',
  }
  let runtime: RunningChild | undefined
  let terminalClient: RunningChild | undefined
  let terminalLines: ReadlineInterface | undefined
  let runtimeSettled = false
  let terminalSettled = false
  let failure: unknown
  try {
    const runtimeChild = execa(process.execPath, [runtimeBin], {
      cwd: input.root,
      env: runtimeEnvironment,
      extendEnv: false,
      reject: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    runtime = runtimeChild
    const endpoint = await waitForJsonFile<{ readonly process: { readonly pid: number } }>(
      join(input.harnessHome, 'runtime-endpoint.json'),
    )
    expect(endpoint.process.pid).toBe(runtimeChild.pid)

    const terminalChild = execa(process.execPath, [helper], {
      cwd: input.root,
      env: { ...runtimeEnvironment, HARNESS_TEST_WORKSPACE: input.root },
      extendEnv: false,
      reject: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    terminalClient = terminalChild
    let terminalStderr = ''
    terminalChild.stderr?.setEncoding('utf8').on('data', (chunk: string) => { terminalStderr += chunk })
    if (terminalChild.stdout === null) throw new Error('packed CLI terminal helper has no stdout')
    terminalLines = createInterface({ input: terminalChild.stdout, crlfDelay: Infinity })
    const lines = terminalLines[Symbol.asyncIterator]()
    let terminalReady: Record<string, unknown>
    try {
      terminalReady = await waitForChildLine(lines, 'terminal attachment')
    } catch (error) {
      const readiness = await collectTerminalReadinessFailure({
        cause: error,
        child: terminalChild,
        lines: terminalLines,
        closeInput: () => terminalChild.stdin?.end(),
        observedStderr: () => terminalStderr,
      })
      terminalSettled = readiness.settled
      throw readiness.error
    }
    expect(terminalReady).toEqual({ kind: 'terminal-ready', event: 'session-opened' })

    const acquired = await execa(input.harness, ['web', '--background', '--no-open'], {
      cwd: input.root,
      env: runtimeEnvironment,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
    })
    expect(acquired.exitCode, acquired.stderr).toBe(0)
    expect(acquired.stdout).toBe('Web lease: web present')

    const stoppedByAlias = await execa(input.dsh, ['web', '--stop'], {
      cwd: input.root,
      env: runtimeEnvironment,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
    })
    expect(stoppedByAlias.exitCode, stoppedByAlias.stderr).toBe(0)
    expect(stoppedByAlias.stdout).toBe('Web lease: web absent')

    const stoppedByPrimary = await execa(input.harness, ['web', '--stop'], {
      cwd: input.root,
      env: runtimeEnvironment,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
    })
    expect(stoppedByPrimary.exitCode, stoppedByPrimary.stderr).toBe(0)
    expect(stoppedByPrimary.stdout).toBe('Web lease: web absent')

    writeChildLine(terminalChild, 'probe')
    await expect(waitForChildLine(lines, 'retained terminal probe')).resolves.toEqual({
      kind: 'terminal-usable',
      cancellation: 'idle',
      state: 'running',
    })
    writeChildLine(terminalChild, 'close')
    await expect(waitForChildLine(lines, 'terminal close')).resolves.toEqual({ kind: 'terminal-closed' })
    terminalLines.close()
    const terminalOutcome = await settlePackedCliChild(terminalChild, () => terminalChild.stdin?.end())
    terminalSettled = true
    expect(terminalOutcome.forced).toBe(false)
    expect(terminalOutcome.result.exitCode, terminalOutcome.result.stderr).toBe(0)
    expect(terminalOutcome.result.stderr).toBe('')
    expect(terminalOutcome.result.stdout).not.toContain(repoRoot)

    const runtimeOutcome = await settlePackedCliChild(runtimeChild, () => runtimeChild.stdin?.end())
    runtimeSettled = true
    expect(runtimeOutcome.forced).toBe(false)
    expect(runtimeOutcome.result.exitCode, runtimeOutcome.result.stderr).toBe(0)
    expect(runtimeOutcome.result.stderr).toMatch(/^harness-runtime: ready /u)
    expect(runtimeOutcome.result.stderr).not.toMatch(/accessToken|runtime-endpoint|Bearer /u)
    expect(runtimeOutcome.result.stderr).not.toContain(repoRoot)
  } catch (error) {
    failure = error
  } finally {
    terminalLines?.close()
    const cleanupErrors: unknown[] = []
    if (terminalClient !== undefined && !terminalSettled) {
      try {
        await settlePackedCliChild(terminalClient, () => terminalClient?.stdin?.end(), {
          timeoutMs: 10_000,
          postKillTimeoutMs: 10_000,
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (runtime !== undefined && !runtimeSettled) {
      try {
        await settlePackedCliChild(runtime, () => runtime?.stdin?.end(), {
          timeoutMs: 10_000,
          postKillTimeoutMs: 10_000,
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (failure !== undefined) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([failure, ...cleanupErrors], 'packed CLI lifecycle and cleanup both failed')
      }
      throw failure
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'packed CLI lifecycle cleanup failed')
  }
}

it('removes checkout Node loader hooks from installed child processes', async () => {
  const checkoutBin = join(repoRoot, 'node_modules', '.bin')
  const inherited = {
    NODE_PATH: process.env.NODE_PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
    TS_NODE_PROJECT: process.env.TS_NODE_PROJECT,
    PATH: process.env.PATH,
  }
  try {
    process.env.NODE_PATH = join(repoRoot, 'node_modules')
    process.env.NODE_OPTIONS = '--no-warnings'
    process.env.TSX_TSCONFIG_PATH = join(repoRoot, 'tsconfig.base.json')
    process.env.TS_NODE_PROJECT = join(repoRoot, 'tsconfig.base.json')
    process.env.PATH = [checkoutBin, inherited.PATH ?? ''].join(delimiter)
    const environment = packedChildEnvironment()
    const probe = await execa(process.execPath, [
      '--input-type=module',
      '--eval',
      'process.stdout.write(JSON.stringify({ NODE_PATH: process.env.NODE_PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH, TS_NODE_PROJECT: process.env.TS_NODE_PROJECT, PATH: process.env.PATH }))',
    ], { env: environment, extendEnv: false, reject: false })

    expect(probe.exitCode, probe.stderr).toBe(0)
    const childEnvironment = JSON.parse(probe.stdout) as NodeJS.ProcessEnv
    expect(childEnvironment).toEqual({ PATH: environment.PATH })
    expect(childEnvironment.PATH?.split(delimiter)).toContain(dirname(process.execPath))
    expect(childEnvironment.PATH?.split(delimiter)).not.toContain(checkoutBin)
    expect(Object.values(environment).join('\n')).not.toContain(repoRoot)
  } finally {
    if (inherited.NODE_PATH === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = inherited.NODE_PATH
    if (inherited.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = inherited.NODE_OPTIONS
    if (inherited.TSX_TSCONFIG_PATH === undefined) delete process.env.TSX_TSCONFIG_PATH
    else process.env.TSX_TSCONFIG_PATH = inherited.TSX_TSCONFIG_PATH
    if (inherited.TS_NODE_PROJECT === undefined) delete process.env.TS_NODE_PROJECT
    else process.env.TS_NODE_PROJECT = inherited.TS_NODE_PROJECT
    if (inherited.PATH === undefined) delete process.env.PATH
    else process.env.PATH = inherited.PATH
  }
})

describe.skipIf(!builtCliAvailable)('packed CLI offline installation', () => {
  it('installs into an empty prefix and consumes the installed public client entries', async () => {
    const root = await temporaryRoot('harness-packed-cli-')
    const packRoot = join(root, 'pack')
    const prefix = join(root, 'prefix')
    const cache = join(root, 'empty-cache')
    const tarball = process.env.DSH_PACKED_CLI_TARBALL ?? await packCliForRelease(packRoot)
    await access(npmExecutable)
    const installEnvironment = {
      ...packedChildEnvironment(),
      npm_config_cache: cache,
      npm_config_update_notifier: 'false',
    }
    const installed = await execa(npmExecutable, [
      'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefix', prefix, tarball,
    ], {
      cwd: root,
      env: installEnvironment,
      extendEnv: false,
      reject: false,
    })
    expect(installed.exitCode, installed.stderr).toBe(0)

    const globalModules = process.platform === 'win32'
      ? join(prefix, 'node_modules')
      : join(prefix, 'lib', 'node_modules')
    const packageRoot = join(globalModules, '@harness-desktop', 'cli')
    const closureModules = join(packageRoot, 'node_modules')
    for (const path of [
      ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'lib', 'bin.js'],
      ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'runtime.cordis.yml'],
      ['node_modules', '@harness-desktop', 'dsh-base', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-web-app', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-headless', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-workflow-worker-thread', 'lib', 'worker.cjs'],
    ]) {
      await expect(access(join(closureModules, ...path.slice(1)))).resolves.toBeUndefined()
    }
    const main = await readFile(join(packageRoot, 'lib', 'main.js'), 'utf8')
    expect(main).toContain('from "@harness-desktop/dsh-host-local-runtime"')
    const childEnvironment = packedChildEnvironment()
    const imports = await execa(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./lib/main.js')",
    ], { cwd: packageRoot, env: childEnvironment, extendEnv: false, reject: false })
    expect(imports.exitCode, imports.stderr).toBe(0)

    const binRoot = process.platform === 'win32' ? prefix : join(prefix, 'bin')
    const suffix = process.platform === 'win32' ? '.cmd' : ''
    const harness = join(binRoot, `harness${suffix}`)
    const dsh = join(binRoot, `dsh${suffix}`)
    const installedBin = join(packageRoot, 'lib', 'bin.js')
    const helpEnvironment = packedChildEnvironment()
    const harnessHelp = await execa(harness, ['--help'], {
      cwd: root, env: helpEnvironment, extendEnv: false, reject: false,
    })
    const dshHelp = await execa(dsh, ['--help'], {
      cwd: root, env: helpEnvironment, extendEnv: false, reject: false,
    })
    expect(harnessHelp.exitCode, harnessHelp.stderr).toBe(0)
    expect(harnessHelp.stdout).toMatch(/^Usage: harness/mu)
    expect(dshHelp.exitCode, dshHelp.stderr).toBe(0)
    expect(dshHelp.stdout).toMatch(/^Usage: dsh/mu)
    expect(harnessHelp.stdout).not.toContain(repoRoot)
    expect(dshHelp.stdout).not.toContain(repoRoot)

    const statusHome = join(root, 'absent-status-home')
    const statusTemp = join(root, 'absent-status-temp')
    const descendantMarker = join(root, 'absent-status-descendant.jsonl')
    const descendantPreload = join(root, 'absent-status-preload.mjs')
    await mkdir(statusTemp)
    await writeFile(descendantPreload, [
      "import childProcess from 'node:child_process'",
      "import { appendFileSync } from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      `const marker = ${JSON.stringify(descendantMarker)}`,
      "const trap = kind => (...args) => { appendFileSync(marker, JSON.stringify({ kind, command: String(args[0]) }) + '\\n'); throw new Error(`unexpected ${kind}`) }",
      "childProcess.spawn = trap('spawn')",
      "childProcess.execFile = trap('execFile')",
      'syncBuiltinESMExports()',
      '',
    ].join('\n'))
    const statusEnvironment = {
      ...withoutEnvironmentNames(packedChildEnvironment(), ['DSH_HOME']),
      HARNESS_HOME: statusHome,
      HOME: join(root, 'absent-status-platform-home'),
      USERPROFILE: join(root, 'absent-status-platform-home'),
      TEMP: statusTemp,
      TMP: statusTemp,
      NODE_OPTIONS: `--import=${pathToFileURL(descendantPreload).href}`,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    }
    const absentStatus = await execa(harness, ['web', '--status'], {
      cwd: root,
      env: statusEnvironment,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
    })
    expect(absentStatus.exitCode).toBe(3)
    expect(absentStatus.stdout).toBe('')
    expect(absentStatus.stderr).toMatch(runtimeUnavailableDiagnostic)
    for (const absentPath of [
      statusHome,
      join(statusHome, 'runtime.lock'),
      join(statusHome, 'runtime.lock.recovery'),
      join(statusHome, 'runtime-endpoint.json'),
    ]) {
      await expect(access(absentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(readdir(statusTemp)).resolves.toEqual([])
    await expect(access(descendantMarker)).rejects.toMatchObject({ code: 'ENOENT' })

    const harnessHome = join(root, 'runtime-home')
    const platformHome = join(root, 'runtime-platform-home')
    const runtimeEnvironment = {
      ...withoutEnvironmentNames(packedChildEnvironment(), ['DSH_HOME']),
      HARNESS_HOME: harnessHome,
      HOME: platformHome,
      USERPROFILE: platformHome,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    }
    await exerciseInstalledRuntime({
      root,
      packageRoot,
      harness,
      dsh,
      harnessHome,
      environment: runtimeEnvironment,
    })

    const activationDriver = await runInstalledDriver(root, 'installed-desktop-activation.mjs', [
      installedRunCliLoader(installedBin),
      "import { PassThrough, Writable } from 'node:stream'",
      "let stdoutText = ''",
      "let stderrText = ''",
      'let activations = 0',
      'let connectorCalls = 0',
      'let openerCalls = 0',
      'const stdout = new Writable({ write(chunk, _encoding, callback) { stdoutText += String(chunk); callback() } })',
      'const stderr = new Writable({ write(chunk, _encoding, callback) { stderrText += String(chunk); callback() } })',
      "const activator = { async activate() { activations += 1; return 'activated' } }",
      "const connector = { async connect() { connectorCalls += 1; throw new Error('desktop dispatch connected to Runtime') } }",
      "const opener = { async open() { openerCalls += 1; throw new Error('desktop dispatch opened a browser') } }",
      "const code = await runCli('harness', ['desktop'], {",
      '  activator, connector, opener,',
      '  io: { stdin: new PassThrough(), stdout, stderr, workspace: process.cwd(), columns: 80, colorDepth: 1 },',
      '})',
      'process.stdout.write(JSON.stringify({ code, activations, connectorCalls, openerCalls, stdoutText, stderrText }))',
    ].join('\n'), packedChildEnvironment())
    expect(activationDriver.exitCode, activationDriver.stderr).toBe(0)
    expect(JSON.parse(activationDriver.stdout)).toEqual({
      code: 0,
      activations: 1,
      connectorCalls: 0,
      openerCalls: 0,
      stdoutText: '',
      stderrText: '',
    })

    const unavailableDesktopHome = join(root, 'absent-desktop-runtime-home')
    const unavailableDesktopPlatformHome = join(root, 'absent-desktop-platform-home')
    const unavailableDesktopTemp = join(root, 'absent-desktop-temp')
    await mkdir(unavailableDesktopPlatformHome)
    await mkdir(unavailableDesktopTemp)
    const unavailableDesktopEnvironment = {
      ...withoutEnvironmentNames(packedChildEnvironment(), ['DSH_HOME']),
      HARNESS_HOME: unavailableDesktopHome,
      HOME: unavailableDesktopPlatformHome,
      USERPROFILE: unavailableDesktopPlatformHome,
      LOCALAPPDATA: join(unavailableDesktopPlatformHome, 'LocalAppData'),
      ProgramFiles: join(unavailableDesktopPlatformHome, 'ProgramFiles'),
      'ProgramFiles(x86)': join(unavailableDesktopPlatformHome, 'ProgramFiles-x86'),
      XDG_DATA_HOME: join(unavailableDesktopPlatformHome, 'xdg-data'),
      TEMP: unavailableDesktopTemp,
      TMP: unavailableDesktopTemp,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    }
    const unavailableDriver = await runInstalledDriver(root, 'installed-desktop-unavailable.mjs', [
      "import fs from 'node:fs'",
      "import childProcess from 'node:child_process'",
      "import { syncBuiltinESMExports } from 'node:module'",
      "import { PassThrough, Writable } from 'node:stream'",
      'const candidateAccesses = []',
      'const nativeLaunches = []',
      "fs.promises.access = async path => { candidateAccesses.push(String(path)); throw Object.assign(new Error('absent installed Desktop candidate'), { code: 'ENOENT' }) }",
      "childProcess.spawn = (...args) => { nativeLaunches.push({ kind: 'spawn', command: String(args[0]) }); throw new Error('unexpected native spawn') }",
      "childProcess.execFile = (...args) => { nativeLaunches.push({ kind: 'execFile', command: String(args[0]) }); throw new Error('unexpected native execFile') }",
      'syncBuiltinESMExports()',
      installedRunCliLoader(installedBin),
      "let stdoutText = ''",
      "let stderrText = ''",
      'const stdout = new Writable({ write(chunk, _encoding, callback) { stdoutText += String(chunk); callback() } })',
      'const stderr = new Writable({ write(chunk, _encoding, callback) { stderrText += String(chunk); callback() } })',
      "const code = await runCli('harness', ['desktop'], {",
      '  io: { stdin: new PassThrough(), stdout, stderr, workspace: process.cwd(), columns: 80, colorDepth: 1 },',
      '})',
      'process.stdout.write(JSON.stringify({ code, candidateAccesses, nativeLaunches, stdoutText, stderrText, electron: process.versions.electron ?? null }))',
    ].join('\n'), unavailableDesktopEnvironment)
    expect(unavailableDriver.exitCode, unavailableDriver.stderr).toBe(0)
    const unavailable = JSON.parse(unavailableDriver.stdout) as {
      readonly code: number
      readonly candidateAccesses: readonly string[]
      readonly nativeLaunches: readonly unknown[]
      readonly stdoutText: string
      readonly stderrText: string
      readonly electron: string | null
    }
    expect(unavailable.code).toBe(3)
    expect(unavailable.stdoutText).toBe('')
    expect(unavailable.stderrText).toMatch(new RegExp(
      '^Harness Desktop is not installed\\.\\n'
      + `${desktopInstallationRoute[process.platform].replaceAll('.', '\\.')}\\n`
      + `Diagnostic: ${uuidPattern}\\n$`,
      'u',
    ))
    expect(unavailable.candidateAccesses.length).toBeGreaterThan(0)
    expect(unavailable.nativeLaunches).toEqual([])
    expect(unavailable.electron).toBeNull()
    await expect(access(unavailableDesktopHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(unavailableDesktopTemp)).resolves.toEqual([])
    expect(unavailableDriver.stdout).not.toContain(repoRoot)
    expect(unavailableDriver.stderr).not.toContain(repoRoot)
  }, 900_000)
})
