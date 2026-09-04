/** Verify standalone CLI archives by extracting and executing their bundled runtime. */

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import {
  parseReleaseUpdateConfiguration,
  releaseManifestEndpoint,
  releaseRollbackManifestEndpoint,
  standaloneCliUpdateTarget,
} from '@harness-desktop/dsh-update-policy'
import cliPackageJson from '../../apps/cli/package.json' with { type: 'json' }
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'

const root = resolve(import.meta.dirname, '../..')
const defaultNodeVersion = '24.19.0'
const hostileAmbientLoaderViolation = 'standalone CLI: archive child inherited hostile ambient Node loader'
const hostileAmbientEnvironmentKeys = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'TSX_TSCONFIG_PATH',
  'TS_NODE_PROJECT',
] as const

/** Inputs selecting one already-produced native standalone archive pair. */
export interface CliStandaloneVerificationInput {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly nodeVersion: string
  readonly cliVersion: string
  readonly archiveDirectory: string
}

interface StandaloneManifest {
  readonly version: number
  readonly target: { readonly platform: NodeJS.Platform; readonly arch: string }
  readonly node: {
    readonly version: string
    readonly filename: string
    readonly sha256: string
    readonly executable: string
  }
  readonly cli?: { readonly name: string; readonly version: string }
  readonly launchers: readonly string[]
  readonly executablePaths: readonly string[]
  readonly nativeModules: readonly string[]
  readonly files: Readonly<Record<string, string>>
}

/**
 * Verify the platform-owned standalone archive and execute its bundled runtime.
 * @param input - target and archive directory to verify.
 * @returns diagnostics; an empty array means the archive and launchers passed.
 */
export async function verifyCliStandalone(
  input: CliStandaloneVerificationInput,
): Promise<readonly string[]> {
  return verifyInHostileAmbientLoaderEnvironment(async () => verifyCliStandaloneArchives(input))
}

/**
 * Run archive verification while the already-running parent carries hostile loader state.
 * @param verification - archive verification that owns every child probe and lifecycle.
 * @returns archive diagnostics plus a stable violation if any child inherits the ambient loader.
 */
export async function verifyInHostileAmbientLoaderEnvironment(
  verification: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const hostileRoot = await mkdtemp(join(tmpdir(), 'harness-standalone-hostile-loader-'))
  const marker = join(hostileRoot, 'ambient-loader-ran')
  const loader = join(hostileRoot, 'ambient-loader.mjs')
  const originalEnvironment = new Map(
    hostileAmbientEnvironmentKeys.map(name => [name, process.env[name]] as const),
  )
  let primaryError: unknown
  let verificationViolations: readonly string[] = []
  let markerRan = false
  let markerCheckError: unknown
  let cleanupError: unknown
  try {
    await writeFile(loader, [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(marker)}, 'inherited\\n')`,
      '',
    ].join('\n'))
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(loader).href}`
    process.env.NODE_PATH = hostileRoot
    process.env.TSX_TSCONFIG_PATH = join(hostileRoot, 'hostile-tsconfig.json')
    process.env.TS_NODE_PROJECT = join(hostileRoot, 'hostile-ts-node.json')
    try {
      verificationViolations = await verification()
    } catch (error) {
      primaryError = error
    }
  } finally {
    restoreEnvironment(originalEnvironment)
    try {
      await access(marker)
      markerRan = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') markerCheckError = error
    }
    try {
      await removeTree(hostileRoot)
    } catch (error) {
      cleanupError = error
    }
  }

  const probeErrors = [
    ...(markerRan ? [new Error(hostileAmbientLoaderViolation)] : []),
    ...(markerCheckError === undefined
      ? []
      : [new Error(`standalone CLI: hostile ambient loader marker check failed: ${errorMessage(markerCheckError)}`)]),
    ...(cleanupError === undefined
      ? []
      : [new Error(`standalone CLI: hostile ambient loader cleanup failed: ${errorMessage(cleanupError)}`)]),
  ]
  if (primaryError !== undefined) {
    const normalizedPrimaryError = primaryError instanceof Error
      ? primaryError
      : new Error(errorMessage(primaryError))
    if (probeErrors.length === 0) throw normalizedPrimaryError
    throw new AggregateError(
      [normalizedPrimaryError, ...probeErrors],
      'standalone CLI: hostile ambient loader verification failed',
    )
  }
  return [...verificationViolations, ...probeErrors.map(error => error.message)]
}

function restoreEnvironment(environment: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of environment) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
}

async function verifyCliStandaloneArchives(
  input: CliStandaloneVerificationInput,
): Promise<readonly string[]> {
  const stem = `harness-cli-${input.cliVersion}-${input.platform}-${input.arch}`
  const target = standaloneCliUpdateTarget(input.platform, input.arch)
  if (target === undefined) return ['standalone CLI: unsupported archive target']
  const archiveName = `${stem}.${target.format}`
  const checksumName = `${stem}.sha256`
  const archivePath = join(input.archiveDirectory, archiveName)
  const checksumPath = join(input.archiveDirectory, checksumName)
  const [archiveBytes, checksumText] = await Promise.all([
    readFile(archivePath),
    readFile(checksumPath, 'utf8'),
  ])
  const expectedChecksum = [
    `${sha256(archiveBytes)}  ${archiveName}`,
    '',
  ].join('\n')
  if (checksumText !== expectedChecksum) return ['standalone CLI: checksum sidecar does not match archive bytes']

  const violations: string[] = []
  const extraction = await mkdtemp(join(tmpdir(), `harness-cli-verify-${target.format.replace('.', '-')}-`))
  try {
    if (target.format === 'zip') await extractZip(archivePath, extraction)
    else await tar.x({ file: archivePath, cwd: extraction, strict: true })
    violations.push(...await verifyExtracted(input, extraction, target.format))
  } catch (error) {
    violations.push(`standalone CLI: ${target.format} verification failed: ${errorMessage(error)}`)
  } finally {
    try {
      await removeTree(extraction)
    } catch (error) {
      violations.push(`standalone CLI: ${target.format} cleanup failed: ${errorMessage(error)}`)
    }
  }
  return violations
}

async function verifyExtracted(
  input: CliStandaloneVerificationInput,
  extraction: string,
  format: string,
): Promise<readonly string[]> {
  const manifest = JSON.parse(await readFile(join(extraction, 'manifest.json'), 'utf8')) as StandaloneManifest
  const violations: string[] = []
  if (manifest.version !== 2) violations.push(`standalone CLI: ${format} manifest version is not 2`)
  if (manifest.target.platform !== input.platform || manifest.target.arch !== input.arch) {
    violations.push(`standalone CLI: ${format} manifest target is ${manifest.target.platform}-${manifest.target.arch}`)
  }
  if (manifest.node.version !== input.nodeVersion) {
    violations.push(`standalone CLI: ${format} manifest Node version is ${manifest.node.version}`)
  }

  const actualDigests = await digestStandaloneTree(extraction, new Set(['manifest.json']))
  if (JSON.stringify(actualDigests) !== JSON.stringify(manifest.files)) {
    violations.push(`standalone CLI: ${format} digest map does not match extracted files`)
  }
  if (typeof manifest.cli?.version !== 'string') {
    violations.push(`standalone CLI: ${format} manifest CLI version is missing or invalid`)
  } else {
    if (manifest.cli.version !== input.cliVersion) {
      violations.push(`standalone CLI: ${format} manifest CLI version is ${manifest.cli.version}`)
    }
    violations.push(...await verifyStandaloneReleasePolicy(extraction, input, manifest.cli.version))
  }
  const executablePaths = validateExecutablePaths(manifest.executablePaths, actualDigests, format, violations)
  for (const path of [...manifest.launchers, manifest.node.executable]) {
    if (!executablePaths.includes(path)) {
      violations.push(`standalone CLI: ${format} executable manifest omits ${path}`)
    }
  }
  violations.push(...await applyStandaloneExecutablePaths({
    format: format === 'zip' ? 'zip' : 'tar.gz',
    platform: input.platform,
    extraction,
    executablePaths,
  }))
  const comparePaths = (left: string, right: string): number => left.localeCompare(right, 'en')
  const actualNativeModules = Object.keys(actualDigests).filter(path => path.endsWith('.node')).toSorted(comparePaths)
  const expectedNativeModules = [...manifest.nativeModules].toSorted(comparePaths)
  if (JSON.stringify(actualNativeModules) !== JSON.stringify(expectedNativeModules)) {
    violations.push(
      `standalone CLI: ${format} native-module closure does not match extracted files: manifest=${JSON.stringify(expectedNativeModules)} extracted=${JSON.stringify(actualNativeModules)}`,
    )
  }
  violations.push(...verifyLinuxNativeClosure(input.platform, input.arch, Object.keys(actualDigests)))
  for (const path of [
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-host-local-runtime/lib/bin.js',
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-host-local-runtime/runtime.cordis.yml',
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-base/cordis.patch.yml',
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-web-app/cordis.patch.yml',
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-headless/cordis.patch.yml',
    'payload/current/cli/package/node_modules/@harness-desktop/dsh-workflow-worker-thread/lib/worker.cjs',
  ]) {
    if (actualDigests[path] === undefined) violations.push(`standalone CLI: ${format} Runtime closure omits ${path}`)
  }

  const nodeExecutable = join(extraction, ...manifest.node.executable.split('/'))
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'harness-cli-empty-cwd-'))
  try {
    const environment = await isolatedEnvironment(input.platform, isolatedCwd)
    const version = await execa(nodeExecutable, ['--version'], {
      cwd: isolatedCwd,
      env: environment,
      extendEnv: false,
      reject: false,
    })
    if (version.exitCode !== 0 || version.stdout.trim() !== `v${input.nodeVersion}`) {
      violations.push(`standalone CLI: ${format} bundled Node did not report v${input.nodeVersion}`)
    }
    const executablePath = await execa(nodeExecutable, [
      '--eval', 'process.stdout.write(process.execPath)',
    ], { cwd: isolatedCwd, env: environment, extendEnv: false, reject: false })
    const expectedNodePath = await realpath(nodeExecutable)
    const actualNodePath = executablePath.exitCode === 0
      ? await realpath(executablePath.stdout.trim()).catch(() => '')
      : ''
    if (executablePath.exitCode !== 0 || !samePath(actualNodePath, expectedNodePath)) {
      violations.push(`standalone CLI: ${format} process.execPath is outside the bundled runtime`)
    }
    for (const path of nativeModuleLoadPaths(manifest.nativeModules)) {
      const result = await execa(nodeExecutable, [
        '--input-type=module',
        '--eval',
        "const require = process.getBuiltinModule('node:module').createRequire(import.meta.url); require(process.argv[1])",
        join(extraction, ...path.split('/')),
      ], { cwd: isolatedCwd, env: environment, extendEnv: false, reject: false })
      if (result.exitCode !== 0) violations.push(`standalone CLI: ${format} native module failed to load: ${path}`)
    }

    const [harness, dsh] = await Promise.all([
      runLauncher(input.platform, extraction, 'harness', ['--help'], isolatedCwd, environment),
      runLauncher(input.platform, extraction, 'dsh', ['--help'], isolatedCwd, environment),
    ])
    if (harness.exitCode !== 0 || !/^Usage: harness/mu.test(harness.stdout)) {
      violations.push(`standalone CLI: ${format} harness launcher failed from empty cwd: ${launcherDiagnostic(harness)}`)
    }
    if (dsh.exitCode !== 0 || !/^Usage: dsh/mu.test(dsh.stdout)) {
      violations.push(`standalone CLI: ${format} dsh launcher failed from empty cwd: ${launcherDiagnostic(dsh)}`)
    }
    let runtimePid: number | undefined
    try {
      const started = await runLauncher(
        input.platform, extraction, 'harness', ['web', '--background', '--no-open'], isolatedCwd, environment,
      )
      if (started.exitCode !== 0 || started.stdout !== 'Web lease: web present') {
        violations.push(`standalone CLI: ${format} harness failed to start the bundled Runtime: ${launcherDiagnostic(started)}`)
      } else {
        const harnessHome = environment.HARNESS_HOME
        if (harnessHome === undefined) throw new Error('standalone CLI: isolated environment omitted HARNESS_HOME')
        const endpoint = JSON.parse(await readFile(join(harnessHome, 'runtime-endpoint.json'), 'utf8')) as {
          readonly process: { readonly pid: number }
        }
        runtimePid = endpoint.process.pid
        const status = await runLauncher(input.platform, extraction, 'dsh', ['web', '--status'], isolatedCwd, environment)
        if (status.exitCode !== 0 || !status.stdout.includes('Runtime: running')
          || !status.stdout.includes('Web lease: web present')) {
          violations.push(`standalone CLI: ${format} dsh failed to attach to the bundled Runtime: ${launcherDiagnostic(status)}`)
        }
        const stopped = await runLauncher(input.platform, extraction, 'harness', ['web', '--stop'], isolatedCwd, environment)
        if (stopped.exitCode !== 0 || stopped.stdout !== 'Web lease: web absent') {
          violations.push(`standalone CLI: ${format} harness failed to release the bundled Runtime lease: ${launcherDiagnostic(stopped)}`)
        }
      }
    } finally {
      if (runtimePid !== undefined) {
        try { process.kill(runtimePid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        await waitForProcessExit(runtimePid)
      }
    }
  } finally {
    try {
      await removeTree(isolatedCwd)
    } catch (error) {
      violations.push(`standalone CLI: ${format} isolated-home cleanup failed: ${errorMessage(error)}`)
    }
  }
  return violations
}

/**
 * Select native-module load probes without treating mutually exclusive Koffi libc binaries as independent modules.
 * @param paths - complete checksummed native-module closure from the standalone manifest.
 * @returns direct native paths plus one Koffi package-loader path when its Linux variants are present.
 */
export function nativeModuleLoadPaths(paths: readonly string[]): readonly string[] {
  const koffiVariants = paths.some(isKoffiLinuxVariant)
  return [
    ...paths.filter(path => !isKoffiLinuxVariant(path)),
    ...(koffiVariants ? ['payload/current/cli/package/node_modules/koffi'] : []),
  ].toSorted((left, right) => left.localeCompare(right, 'en'))
}

/**
 * Check Linux-only native dependencies that must remain portable after extraction.
 * @param platform - archive target platform.
 * @param arch - archive target architecture.
 * @param paths - all extracted archive-relative paths.
 * @returns native-closure diagnostics; empty when the Linux requirements are met or do not apply.
 */
export function verifyLinuxNativeClosure(
  platform: NodeJS.Platform,
  arch: string,
  paths: readonly string[],
): readonly string[] {
  if (platform !== 'linux') return []
  const root = 'payload/current/cli/package/node_modules'
  const nodePty = `${root}/node-pty`
  const koffi = `${root}/@koromix/koffi-linux-${arch}`
  const violations: string[] = []
  if (![
    `${nodePty}/prebuilds/linux-${arch}/pty.node`,
    `${nodePty}/build/Release/pty.node`,
  ].some(path => paths.includes(path))) {
    violations.push(`standalone CLI: Linux node-pty closure omits a linux-${arch} pty.node binding`)
  }
  if (paths.includes(`${root}/koffi/index.js`) || paths.some(path => path.startsWith(`${koffi}/`))) {
    for (const libc of ['linux', 'musl']) {
      const path = `${koffi}/${libc}_${arch}/koffi.node`
      if (!paths.includes(path)) violations.push(`standalone CLI: Linux Koffi native closure omits ${libc}_${arch}/koffi.node`)
    }
  }
  return violations
}

function isKoffiLinuxVariant(path: string): boolean {
  return /^payload\/current\/cli\/package\/node_modules\/@koromix\/koffi-linux-[^/]+\/(?:linux|musl)_[^/]+\/koffi\.node$/u.test(path)
}

/**
 * Verify that one extracted archive embeds candidate and current-version rollback endpoints for its exact target.
 * @param extraction - extracted standalone archive root.
 * @param input - host target selected by the verifier.
 * @param currentVersion - CLI package version embedded in the archive.
 * @returns stable policy diagnostics; empty means both endpoints are present in a valid public policy.
 */
export async function verifyStandaloneReleasePolicy(
  extraction: string,
  input: CliStandaloneVerificationInput,
  currentVersion: string,
): Promise<readonly string[]> {
  const violations: string[] = []
  let policy: ReturnType<typeof parseReleaseUpdateConfiguration>
  try {
    policy = parseReleaseUpdateConfiguration(
      JSON.parse(await readFile(join(extraction, 'update-policy.json'), 'utf8')) as unknown,
      productMetadata.appId,
    )
  } catch {
    violations.push('standalone CLI: release update policy is missing or invalid')
    return violations
  }
  const target = standaloneCliUpdateTarget(input.platform, input.arch)
  if (target === undefined) {
    violations.push('standalone CLI: release update policy has an unsupported archive platform')
    return violations
  }
  if (releaseManifestEndpoint(policy, target) === undefined) {
    violations.push('standalone CLI: release update policy omits this archive target')
  }
  if (releaseRollbackManifestEndpoint(policy, { ...target, currentVersion }) === undefined) {
    violations.push('standalone CLI: release update policy omits this archive rollback target')
  }
  return violations
}

async function runLauncher(
  platform: NodeJS.Platform,
  extraction: string,
  name: 'harness' | 'dsh',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | undefined; readonly stdout: string; readonly stderr: string }> {
  if (platform === 'win32') {
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const result = await execa(command, ['/d', '/s', '/c', join(extraction, `${name}.cmd`), ...args], {
      cwd,
      env,
      extendEnv: false,
      reject: false,
      timeout: 90_000,
    })
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
  const launcher = join(extraction, name)
  await chmod(launcher, 0o755)
  const result = await execa(launcher, [...args], {
    cwd,
    env,
    extendEnv: false,
    reject: false,
    timeout: 90_000,
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function launcherDiagnostic(result: { readonly exitCode: number | undefined; readonly stdout: string; readonly stderr: string }): string {
  return `exit=${String(result.exitCode)} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+/gu, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4 * 1024)
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`standalone CLI Runtime ${String(pid)} did not exit`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function isolatedEnvironment(platform: NodeJS.Platform, home: string): Promise<NodeJS.ProcessEnv> {
  return {
    HOME: home,
    USERPROFILE: home,
    HARNESS_HOME: join(home, 'harness-home'),
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_offline: 'true',
    PATH: await isolatedSystemPath(platform, home),
    PATHEXT: platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : undefined,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
  }
}

async function isolatedSystemPath(platform: NodeJS.Platform, home: string): Promise<string> {
  if (platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  }
  const candidates = platform === 'darwin' ? ['/bin/ps', '/usr/bin/ps'] : ['/usr/bin/ps', '/bin/ps']
  const source = await firstExisting(candidates)
  if (source === undefined) throw new Error(`standalone CLI: ${platform} process probe is unavailable`)
  const tools = join(home, 'system-tools')
  await mkdir(tools)
  await symlink(source, join(tools, 'ps'))
  return tools
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await access(path).then(() => true, () => false)) return path
  }
  return undefined
}

async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

/** Filesystem operations used to restore and inspect archive executable modes. */
export interface StandaloneExecutableModeDependencies {
  chmod(path: string, mode: number): Promise<void>
  stat(path: string): Promise<{ readonly mode: number }>
}

/**
 * Restore ZIP modes from the checksummed manifest and require tar to preserve them.
 * @param input - extracted format, target platform, root, and recorded executable paths.
 * @param dependencies - filesystem mode operations.
 * @returns mode diagnostics; empty means every applicable path is executable.
 */
export async function applyStandaloneExecutablePaths(
  input: {
    readonly format: 'zip' | 'tar.gz'
    readonly platform: NodeJS.Platform
    readonly extraction: string
    readonly executablePaths: readonly string[]
  },
  dependencies: StandaloneExecutableModeDependencies = { chmod, stat },
): Promise<readonly string[]> {
  const violations: string[] = []
  for (const path of input.executablePaths) {
    const absolute = join(input.extraction, ...path.split('/'))
    if (input.format === 'zip') await dependencies.chmod(absolute, 0o755)
    if (input.platform === 'win32') continue
    const mode = (await dependencies.stat(absolute)).mode & 0o777
    if (mode !== 0o755) {
      violations.push(`standalone CLI: ${input.format} executable ${path} has mode ${mode.toString(8)}, expected 755`)
    }
  }
  return violations
}

function validateExecutablePaths(
  value: unknown,
  digests: Readonly<Record<string, string>>,
  format: string,
  violations: string[],
): readonly string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) {
    violations.push(`standalone CLI: ${format} executable manifest is invalid`)
    return []
  }
  const paths = value as string[]
  const sorted = [...new Set(paths)].toSorted((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    violations.push(`standalone CLI: ${format} executable manifest is not sorted and unique`)
  }
  for (const path of sorted) {
    try {
      assertSafeMember(path)
    } catch (error) {
      violations.push(`standalone CLI: ${format} executable manifest contains ${errorMessage(error)}`)
      continue
    }
    if (digests[path] === undefined) violations.push(`standalone CLI: ${format} executable manifest names missing file ${path}`)
  }
  return sorted.filter(path => digests[path] !== undefined)
}

async function extractZip(archive: string, destination: string): Promise<void> {
  for (const [path, bytes] of Object.entries(unzipSync(await readFile(archive)))) {
    assertSafeMember(path)
    if (path.endsWith('/')) continue
    const target = join(destination, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}

function assertSafeMember(path: string): void {
  const segments = path.replaceAll('\\', '/').split('/')
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || segments.includes('..')) {
    throw new Error(`unsafe archive member ${JSON.stringify(path)}`)
  }
}

/**
 * Hash one extracted archive tree with bounded readers and stable path ordering.
 * @param directory - extracted archive root.
 * @param excluded - archive-relative paths omitted from the digest map.
 * @returns sorted archive-relative SHA-256 entries.
 */
export async function digestStandaloneTree(
  directory: string,
  excluded: ReadonlySet<string>,
): Promise<Readonly<Record<string, string>>> {
  const paths = (await listTree(directory)).filter(path => !excluded.has(path))
  const records = new Array<readonly [string, string]>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const path = paths[index]
      if (path === undefined) return
      records[index] = [path, sha256(await readFile(join(directory, ...path.split('/'))))]
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, worker))
  return Object.fromEntries(records)
}

async function listTree(directory: string, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      paths.push(...await listTree(join(directory, entry.name), path))
    } else if (entry.isFile()) {
      paths.push(path)
    }
  }
  return paths
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const archiveDirectory = resolve(root, process.env.DSH_CLI_STANDALONE_OUTPUT ?? 'dist/cli-standalone')
  const violations = await verifyCliStandalone({
    platform: (process.env.DSH_CLI_STANDALONE_PLATFORM as NodeJS.Platform | undefined) ?? process.platform,
    arch: process.env.DSH_CLI_STANDALONE_ARCH ?? process.arch,
    nodeVersion: process.env.DSH_NODE_RUNTIME_VERSION ?? defaultNodeVersion,
    cliVersion: process.env.DSH_CLI_VERSION ?? cliPackageJson.version,
    archiveDirectory,
  })
  if (violations.length === 0) process.stdout.write('release:verify-cli-standalone: archives verified.\n')
  else {
    for (const violation of violations) process.stderr.write(`${violation}\n`)
    process.exitCode = 1
  }
}
