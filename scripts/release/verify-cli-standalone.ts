/** Verify standalone CLI archives by extracting and executing their bundled runtime. */

import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { unzipSync } from 'fflate'
import * as tar from 'tar'

const root = resolve(import.meta.dirname, '../..')
const defaultNodeVersion = '24.19.0'

/** Inputs selecting one already-produced native standalone archive pair. */
export interface CliStandaloneVerificationInput {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly version: string
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
  readonly launchers: readonly string[]
  readonly executablePaths: readonly string[]
  readonly nativeModules: readonly string[]
  readonly files: Readonly<Record<string, string>>
}

/**
 * Verify both standalone archive formats and execute their bundled runtime.
 * @param input - target and archive directory to verify.
 * @returns diagnostics; an empty array means both archives and launchers passed.
 */
export async function verifyCliStandalone(
  input: CliStandaloneVerificationInput,
): Promise<readonly string[]> {
  const stem = `harness-cli-${input.version}-${input.platform}-${input.arch}`
  const zipName = `${stem}.zip`
  const tarName = `${stem}.tar.gz`
  const checksumName = `${stem}.sha256`
  const zipPath = join(input.archiveDirectory, zipName)
  const tarPath = join(input.archiveDirectory, tarName)
  const checksumPath = join(input.archiveDirectory, checksumName)
  const [zipBytes, tarBytes, checksumText] = await Promise.all([
    readFile(zipPath),
    readFile(tarPath),
    readFile(checksumPath, 'utf8'),
  ])
  const expectedChecksum = [
    `${sha256(zipBytes)}  ${zipName}`,
    `${sha256(tarBytes)}  ${tarName}`,
    '',
  ].join('\n')
  if (checksumText !== expectedChecksum) return ['standalone CLI: checksum sidecar does not match archive bytes']

  const violations: string[] = []
  for (const [format, archive] of [['zip', zipPath], ['tar.gz', tarPath]] as const) {
    const extraction = await mkdtemp(join(tmpdir(), `harness-cli-verify-${format.replace('.', '-')}-`))
    try {
      if (format === 'zip') await extractZip(archive, extraction)
      else await tar.x({ file: archive, cwd: extraction, strict: true })
      violations.push(...await verifyExtracted(input, extraction, format))
    } catch (error) {
      violations.push(`standalone CLI: ${format} verification failed: ${errorMessage(error)}`)
    } finally {
      try {
        await removeTree(extraction)
      } catch (error) {
        violations.push(`standalone CLI: ${format} cleanup failed: ${errorMessage(error)}`)
      }
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
  if (manifest.node.version !== input.version) {
    violations.push(`standalone CLI: ${format} manifest Node version is ${manifest.node.version}`)
  }

  const actualDigests = await digestStandaloneTree(extraction, new Set(['manifest.json']))
  if (JSON.stringify(actualDigests) !== JSON.stringify(manifest.files)) {
    violations.push(`standalone CLI: ${format} digest map does not match extracted files`)
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
  for (const path of [
    'cli/package/node_modules/@harness-desktop/dsh-host-local-runtime/lib/bin.js',
    'cli/package/node_modules/@harness-desktop/dsh-host-local-runtime/runtime.cordis.yml',
    'cli/package/node_modules/@harness-desktop/dsh-base/cordis.patch.yml',
    'cli/package/node_modules/@harness-desktop/dsh-web-app/cordis.patch.yml',
    'cli/package/node_modules/@harness-desktop/dsh-headless/cordis.patch.yml',
    'cli/package/node_modules/@harness-desktop/dsh-workflow-worker-thread/lib/worker.cjs',
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
    if (version.exitCode !== 0 || version.stdout.trim() !== `v${input.version}`) {
      violations.push(`standalone CLI: ${format} bundled Node did not report v${input.version}`)
    }
    const executablePath = await execa(nodeExecutable, [
      '--eval', 'process.stdout.write(process.execPath)',
    ], { cwd: isolatedCwd, env: environment, extendEnv: false, reject: false })
    if (executablePath.exitCode !== 0 || resolve(executablePath.stdout) !== resolve(nodeExecutable)) {
      violations.push(`standalone CLI: ${format} process.execPath is outside the bundled runtime`)
    }
    for (const path of manifest.nativeModules) {
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
      violations.push(`standalone CLI: ${format} harness launcher failed from empty cwd`)
    }
    if (dsh.exitCode !== 0 || !/^Usage: dsh/mu.test(dsh.stdout)) {
      violations.push(`standalone CLI: ${format} dsh launcher failed from empty cwd`)
    }
    let runtimePid: number | undefined
    try {
      const started = await runLauncher(
        input.platform, extraction, 'harness', ['web', '--background', '--no-open'], isolatedCwd, environment,
      )
      if (started.exitCode !== 0 || started.stdout !== 'Web lease: web present') {
        violations.push(`standalone CLI: ${format} harness failed to start the bundled Runtime: ${started.stderr}`)
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
          violations.push(`standalone CLI: ${format} dsh failed to attach to the bundled Runtime: ${status.stderr}`)
        }
        const stopped = await runLauncher(input.platform, extraction, 'harness', ['web', '--stop'], isolatedCwd, environment)
        if (stopped.exitCode !== 0 || stopped.stdout !== 'Web lease: web absent') {
          violations.push(`standalone CLI: ${format} harness failed to release the bundled Runtime lease: ${stopped.stderr}`)
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
    platform: process.platform,
    arch: process.arch,
    version: process.env.DSH_NODE_RUNTIME_VERSION ?? defaultNodeVersion,
    archiveDirectory,
  })
  if (violations.length === 0) process.stdout.write('release:verify-cli-standalone: archives verified.\n')
  else {
    for (const violation of violations) process.stderr.write(`${violation}\n`)
    process.exitCode = 1
  }
}
