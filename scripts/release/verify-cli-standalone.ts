/** Verify standalone CLI archives by extracting and executing their bundled runtime. */

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
      await rm(extraction, { recursive: true, force: true })
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
  if (manifest.version !== 1) violations.push(`standalone CLI: ${format} manifest version is not 1`)
  if (manifest.target.platform !== input.platform || manifest.target.arch !== input.arch) {
    violations.push(`standalone CLI: ${format} manifest target is ${manifest.target.platform}-${manifest.target.arch}`)
  }
  if (manifest.node.version !== input.version) {
    violations.push(`standalone CLI: ${format} manifest Node version is ${manifest.node.version}`)
  }

  const actualDigests = await digestTree(extraction, new Set(['manifest.json']))
  if (JSON.stringify(actualDigests) !== JSON.stringify(manifest.files)) {
    violations.push(`standalone CLI: ${format} digest map does not match extracted files`)
  }
  const actualNativeModules = Object.keys(actualDigests).filter(path => path.endsWith('.node'))
  if (JSON.stringify(actualNativeModules) !== JSON.stringify([...manifest.nativeModules].toSorted())) {
    violations.push(`standalone CLI: ${format} native-module closure does not match extracted files`)
  }

  const nodeExecutable = join(extraction, ...manifest.node.executable.split('/'))
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'harness-cli-empty-cwd-'))
  try {
    const environment = isolatedEnvironment(input.platform, isolatedCwd)
    const version = await execa(nodeExecutable, ['--version'], { cwd: isolatedCwd, env: environment, reject: false })
    if (version.exitCode !== 0 || version.stdout.trim() !== `v${input.version}`) {
      violations.push(`standalone CLI: ${format} bundled Node did not report v${input.version}`)
    }
    const executablePath = await execa(nodeExecutable, [
      '--eval', 'process.stdout.write(process.execPath)',
    ], { cwd: isolatedCwd, env: environment, reject: false })
    if (executablePath.exitCode !== 0 || resolve(executablePath.stdout) !== resolve(nodeExecutable)) {
      violations.push(`standalone CLI: ${format} process.execPath is outside the bundled runtime`)
    }
    for (const path of manifest.nativeModules) {
      const result = await execa(nodeExecutable, [
        '--input-type=module',
        '--eval',
        "const require = process.getBuiltinModule('node:module').createRequire(import.meta.url); require(process.argv[1])",
        join(extraction, ...path.split('/')),
      ], { cwd: isolatedCwd, env: environment, reject: false })
      if (result.exitCode !== 0) violations.push(`standalone CLI: ${format} native module failed to load: ${path}`)
    }

    const [harness, dsh] = await Promise.all([
      runLauncher(input.platform, extraction, 'harness', isolatedCwd, environment),
      runLauncher(input.platform, extraction, 'dsh', isolatedCwd, environment),
    ])
    if (harness.exitCode !== 0 || !/^Usage: harness/mu.test(harness.stdout)) {
      violations.push(`standalone CLI: ${format} harness launcher failed from empty cwd`)
    }
    if (dsh.exitCode !== 0 || !/^Usage: dsh/mu.test(dsh.stdout)) {
      violations.push(`standalone CLI: ${format} dsh launcher failed from empty cwd`)
    }
  } finally {
    await rm(isolatedCwd, { recursive: true, force: true })
  }
  return violations
}

async function runLauncher(
  platform: NodeJS.Platform,
  extraction: string,
  name: 'harness' | 'dsh',
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | undefined; readonly stdout: string }> {
  if (platform === 'win32') {
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const result = await execa(command, ['/d', '/s', '/c', join(extraction, `${name}.cmd`), '--help'], {
      cwd,
      env,
      reject: false,
    })
    return { exitCode: result.exitCode, stdout: result.stdout }
  }
  const launcher = join(extraction, name)
  await chmod(launcher, 0o755)
  const result = await execa(launcher, ['--help'], { cwd, env, reject: false })
  return { exitCode: result.exitCode, stdout: result.stdout }
}

function isolatedEnvironment(platform: NodeJS.Platform, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USERPROFILE: home,
    HARNESS_HOME: join(home, 'harness-home'),
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
    NODE_PATH: '',
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_offline: 'true',
    PATH: platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '',
    PATHEXT: platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : undefined,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
  }
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

async function digestTree(
  directory: string,
  excluded: ReadonlySet<string>,
  prefix = '',
): Promise<Readonly<Record<string, string>>> {
  const records: Array<readonly [string, string]> = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      records.push(...Object.entries(await digestTree(join(directory, entry.name), excluded, path)))
    } else if (entry.isFile() && !excluded.has(path)) {
      records.push([path, sha256(await readFile(join(directory, entry.name)))])
    }
  }
  return Object.fromEntries(records)
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
