/** Build deterministic, offline Harness CLI archives around an allowlisted Node runtime. */

import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { unzipSync, zipSync, type ZipOptions, type Zippable } from 'fflate'
import * as tar from 'tar'
import checksumAllowlistJson from './node-runtime-checksums.json' with { type: 'json' }

const root = resolve(import.meta.dirname, '../..')
const cliRoot = resolve(root, 'apps/cli')
const defaultNodeVersion = '24.19.0'
const defaultSourceDateEpoch = 1_704_067_200

/**
 * Deploy the complete built CLI Runtime graph, then pack it with physical bundled dependencies.
 * @param outputDirectory - directory that receives the npm tarball.
 * @returns absolute tarball path.
 */
export async function packCliForRelease(outputDirectory: string): Promise<string> {
  const deployParent = await mkdtemp(join(tmpdir(), 'harness-cli-deploy-'))
  const deployedPackage = join(deployParent, 'package')
  try {
    await execa('pnpm', ['run', 'verify:cli-runtime-closure'], { cwd: root, reject: true })
    await execa('pnpm', [
      '--filter', '@harness-desktop/cli',
      'deploy', '--prod',
      '--config.inject-workspace-packages=true',
      '--ignore-scripts',
      deployedPackage,
    ], { cwd: root, env: { ...process.env, CI: 'true' }, reject: true })
    await execa('pnpm', [
      '--dir', deployedPackage,
      'install', '--prod', '--offline', '--frozen-lockfile', '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.confirm-modules-purge=false',
    ], { cwd: root, env: { ...process.env, CI: 'true' }, reject: true })
    const manifestPath = join(deployedPackage, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const sourceManifest = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>
    }
    const dependencies = Object.fromEntries(await Promise.all(
      Object.entries(sourceManifest.dependencies ?? {}).toSorted(([left], [right]) => left.localeCompare(right, 'en'))
        .map(async ([name, specifier]) => [
          name,
          specifier.startsWith('workspace:')
            ? (JSON.parse(await readFile(join(deployedPackage, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version: string }).version
            : specifier,
        ] as const),
    ))
    const bundledDependencies = Object.keys(dependencies)
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies, bundledDependencies }, undefined, 2)}\n`)
    await verifyPackedCliClosure(deployedPackage)
    await mkdir(outputDirectory, { recursive: true })
    const packed = await execa('pnpm', [
      '--dir', deployedPackage,
      '--config.node-linker=hoisted',
      'pack', '--pack-destination', outputDirectory,
    ], { cwd: root, reject: true })
    const packedPath = packed.stdout.trim().split(/\r?\n/u).at(-1)
    if (packedPath === undefined || packedPath === '') throw new Error('packed CLI: pnpm pack returned no tarball path')
    return isAbsolute(packedPath) ? packedPath : join(outputDirectory, packedPath)
  } finally {
    await rm(deployParent, { recursive: true, force: true })
  }
}

/** One allowlisted local Node distribution. */
export interface NodeRuntimeChecksum {
  readonly filename: string
  readonly sha256: string
}

/** Exact Node runtime allowlist keyed by version, platform, and architecture. */
export type NodeRuntimeChecksumAllowlist = Readonly<Record<string, Readonly<Partial<Record<
  NodeJS.Platform,
  Readonly<Record<string, NodeRuntimeChecksum>>
>>>>>

/** Inputs selecting one deterministic standalone CLI target. */
export interface CliStandaloneBuildInput {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly version: string
  readonly nodeRuntimeRoot: string
  readonly outputDirectory: string
}

/** Injectable build dependencies used by deterministic fixture tests. */
export interface CliStandaloneBuildDependencies {
  readonly cliPackageRoot: string
  readonly checksumAllowlist: NodeRuntimeChecksumAllowlist
  extractNodeDistribution(archive: string, destination: string): Promise<void>
  validateCliClosure(packageRoot: string): Promise<void>
}

interface StandaloneManifest {
  readonly version: 1
  readonly target: { readonly platform: NodeJS.Platform; readonly arch: string }
  readonly node: NodeRuntimeChecksum & { readonly version: string; readonly executable: string }
  readonly cli: { readonly name: string; readonly version: string }
  readonly launchers: readonly string[]
  readonly nativeModules: readonly string[]
  readonly files: Readonly<Record<string, string>>
}

/**
 * Build standalone archives from the repository's packed CLI and a local Node distribution.
 * @param input - target, version, local runtime root, and output directory.
 * @returns exact archive and sidecar filenames.
 */
export async function buildCliStandalone(
  input: CliStandaloneBuildInput,
): Promise<readonly string[]> {
  const packedRoot = await mkdtemp(join(tmpdir(), 'harness-cli-packed-'))
  try {
    const packDestination = join(packedRoot, 'tarball')
    await mkdir(packDestination, { recursive: true })
    const suppliedTarball = process.env.DSH_PACKED_CLI_TARBALL
    const tarball = suppliedTarball === undefined || suppliedTarball === ''
      ? await packCliForRelease(packDestination)
      : isAbsolute(suppliedTarball) ? suppliedTarball : resolve(root, suppliedTarball)
    if (!(await fileExists(tarball))) throw new Error(`standalone CLI: packed CLI tarball is missing at ${tarball}`)
    const packageRoot = join(packedRoot, 'package')
    await mkdir(packageRoot, { recursive: true })
    await tar.x({ file: tarball, cwd: packageRoot, strip: 1, strict: true })
    return await buildCliStandaloneWithDependencies(input, {
      cliPackageRoot: packageRoot,
      checksumAllowlist: checksumAllowlistJson,
      extractNodeDistribution,
      validateCliClosure: verifyPackedCliClosure,
    })
  } finally {
    await rm(packedRoot, { recursive: true, force: true })
  }
}

/**
 * Build standalone archives from an already closed CLI package payload.
 * @param input - target, version, local runtime root, and output directory.
 * @param dependencies - packed CLI root, reviewed checksum allowlist, and extractor.
 * @returns exact archive and sidecar filenames.
 */
export async function buildCliStandaloneWithDependencies(
  input: CliStandaloneBuildInput,
  dependencies: CliStandaloneBuildDependencies,
): Promise<readonly string[]> {
  const runtime = dependencies.checksumAllowlist[input.version]?.[input.platform]?.[input.arch]
  if (runtime === undefined) {
    throw new Error(`standalone CLI: no allowlisted Node runtime for ${input.version}/${input.platform}/${input.arch}`)
  }
  const runtimeArchive = join(input.nodeRuntimeRoot, runtime.filename)
  const runtimeBytes = await readFile(runtimeArchive).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`standalone CLI: missing Node runtime ${runtime.filename}`, { cause: error })
    throw error
  })
  const runtimeDigest = sha256(runtimeBytes)
  if (runtimeDigest !== runtime.sha256) {
    throw new Error(`standalone CLI: Node runtime checksum mismatch for ${runtime.filename}: expected ${runtime.sha256}, got ${runtimeDigest}`)
  }

  const stageParent = await mkdtemp(join(tmpdir(), 'harness-cli-standalone-'))
  const stage = join(stageParent, 'stage')
  try {
    await mkdir(join(stage, 'cli'), { recursive: true })
    await cp(dependencies.cliPackageRoot, join(stage, 'cli', 'package'), { recursive: true })
    await dependencies.extractNodeDistribution(runtimeArchive, join(stage, 'runtime'))
    const nodeExecutable = input.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node'
    if (!(await fileExists(join(stage, ...nodeExecutable.split('/'))))) {
      throw new Error(`standalone CLI: Node distribution ${runtime.filename} omitted ${nodeExecutable}`)
    }
    await dependencies.validateCliClosure(join(stage, 'cli', 'package'))
    const launchers = await writeLaunchers(stage, input.platform)
    const epoch = sourceDateEpoch()
    await normalizeTree(stage, epoch, new Set([...launchers, nodeExecutable]))
    await pruneOptionalForeignNativeModules(stage, input.platform, input.arch)
    const nativeModules = await verifyNativeModules(stage, input.platform, input.arch)
    const cliManifest = JSON.parse(await readFile(join(stage, 'cli', 'package', 'package.json'), 'utf8')) as {
      readonly name?: string
      readonly version?: string
    }
    if (typeof cliManifest.name !== 'string' || typeof cliManifest.version !== 'string') {
      throw new Error('standalone CLI: packed CLI package.json omits name or version')
    }
    const fileDigests = await digestTree(stage)
    const manifest: StandaloneManifest = {
      version: 1,
      target: { platform: input.platform, arch: input.arch },
      node: { version: input.version, ...runtime, executable: nodeExecutable },
      cli: { name: cliManifest.name, version: cliManifest.version },
      launchers,
      nativeModules,
      files: fileDigests,
    }
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    await normalizeTree(stage, epoch, new Set([...launchers, nodeExecutable]))

    await mkdir(input.outputDirectory, { recursive: true })
    const stem = `harness-cli-${input.version}-${input.platform}-${input.arch}`
    const zipName = `${stem}.zip`
    const tarName = `${stem}.tar.gz`
    const checksumName = `${stem}.sha256`
    const zipPath = join(input.outputDirectory, zipName)
    const tarPath = join(input.outputDirectory, tarName)
    await writeDeterministicZip(stage, zipPath, epoch)
    await tar.c({
      cwd: stage,
      file: tarPath,
      gzip: true,
      mtime: epoch,
      portable: true,
      strict: true,
    }, await listTree(stage))
    const checksum = [
      `${sha256(await readFile(zipPath))}  ${zipName}`,
      `${sha256(await readFile(tarPath))}  ${tarName}`,
      '',
    ].join('\n')
    await writeFile(join(input.outputDirectory, checksumName), checksum)
    return [zipName, tarName, checksumName]
  } finally {
    await rm(stageParent, { recursive: true, force: true })
  }
}

async function extractNodeDistribution(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  if (archive.endsWith('.zip')) {
    const entries = unzipSync(await readFile(archive))
    const top = `${basename(archive, '.zip')}/`
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.startsWith(top) || name.endsWith('/')) continue
      const target = join(destination, ...name.slice(top.length).split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    return
  }
  if (archive.endsWith('.tar.gz')) {
    await tar.x({ file: archive, cwd: destination, strip: 1, strict: true })
    return
  }
  throw new Error(`standalone CLI: unsupported Node distribution ${basename(archive)}`)
}

async function writeLaunchers(stage: string, platform: NodeJS.Platform): Promise<readonly string[]> {
  const sh = (entry: 'bin.js' | 'dsh-bin.js'): string => [
    '#!/bin/sh',
    'set -eu',
    'case "$0" in */*) root=${0%/*} ;; *) root=. ;; esac',
    'root=$(CDPATH= cd -- "$root" && pwd)',
    `exec "$root/runtime/bin/node" "$root/cli/package/lib/${entry}" "$@"`,
    '',
  ].join('\n')
  await writeFile(join(stage, 'harness'), sh('bin.js'))
  await writeFile(join(stage, 'dsh'), sh('dsh-bin.js'))
  const cmd = (entry: 'bin.js' | 'dsh-bin.js'): string => [
    '@echo off',
    `"%~dp0runtime\\node.exe" "%~dp0cli\\package\\lib\\${entry}" %*`,
    '',
  ].join('\r\n')
  await writeFile(join(stage, 'harness.cmd'), cmd('bin.js'))
  await writeFile(join(stage, 'dsh.cmd'), cmd('dsh-bin.js'))
  return platform === 'win32'
    ? ['harness', 'dsh', 'harness.cmd', 'dsh.cmd']
    : ['harness', 'dsh']
}

async function verifyPackedCliClosure(packageRoot: string): Promise<void> {
  const main = await readFile(join(packageRoot, 'lib', 'main.js'), 'utf8')
  if (!main.includes('from "@harness-desktop/dsh-host-local-runtime"')) {
    throw new Error('packed CLI: main.js must retain the package-relative local Runtime connector import')
  }
  for (const path of [
    ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'lib', 'bin.js'],
    ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'runtime.cordis.yml'],
    ['node_modules', '@harness-desktop', 'dsh-base', 'cordis.patch.yml'],
    ['node_modules', '@harness-desktop', 'dsh-web-app', 'cordis.patch.yml'],
    ['node_modules', '@harness-desktop', 'dsh-headless', 'cordis.patch.yml'],
    ['node_modules', '@harness-desktop', 'dsh-workflow-worker-thread', 'lib', 'worker.cjs'],
  ]) {
    if (!(await fileExists(join(packageRoot, ...path)))) {
      throw new Error(`packed CLI: Runtime closure omits ${path.join('/')}`)
    }
  }
}

async function verifyNativeModules(
  stage: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<readonly string[]> {
  const nativeModules = (await listTree(stage)).filter(path => path.endsWith('.node'))
  for (const path of nativeModules) {
    const target = nativeTarget(await readFile(join(stage, ...path.split('/'))))
    const expected = `${platform}-${arch}`
    if (target !== expected && !(platform === 'darwin' && target === 'darwin-universal')) {
      throw new Error(`standalone CLI: native module ${path} targets ${target}, expected ${expected}`)
    }
  }
  return nativeModules
}

async function pruneOptionalForeignNativeModules(
  stage: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<void> {
  const expected = `${platform}-${arch}`
  for (const path of (await listTree(stage)).filter(path => path.endsWith('.node'))) {
    const target = nativeTarget(await readFile(join(stage, ...path.split('/'))))
    if (target === expected || (platform === 'darwin' && target === 'darwin-universal')) continue
    if (!isOptionalPlatformNativeModule(path)) continue
    await rm(join(stage, ...path.split('/')), { force: true })
  }
}

function isOptionalPlatformNativeModule(path: string): boolean {
  return path.includes('/node_modules/node-pty/prebuilds/')
    || /\/node_modules\/(?:@koromix|@img|node-addon-require-builtin-)/u.test(path)
}

function nativeTarget(bytes: Buffer): string {
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const header = bytes.readUInt32LE(0x3c)
    const machine = header + 6 <= bytes.length ? bytes.readUInt16LE(header + 4) : 0
    return `win32-${machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : machine === 0x14c ? 'ia32' : 'unknown'}`
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
    return `linux-${machine === 62 ? 'x64' : machine === 183 ? 'arm64' : machine === 40 ? 'arm' : 'unknown'}`
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0)
    const little = magic === 0xcffaedfe || magic === 0xcefaedfe
    const cpu = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
    if ([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe].includes(magic)) {
      return `darwin-${cpu === 0x01000007 ? 'x64' : cpu === 0x0100000c ? 'arm64' : 'unknown'}`
    }
    if (magic === 0xcafebabe || magic === 0xbebafeca) return 'darwin-universal'
  }
  return 'unknown-unknown'
}

async function digestTree(rootDirectory: string): Promise<Readonly<Record<string, string>>> {
  const paths = await listTree(rootDirectory)
  const records = new Array<readonly [string, string]>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const path = paths[index]
      if (path === undefined) return
      records[index] = [path, sha256(await readFile(join(rootDirectory, ...path.split('/'))))]
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, worker))
  return Object.fromEntries(records)
}

async function listTree(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listTree(join(directory, entry.name), path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

async function normalizeTree(directory: string, epoch: Date, executablePaths: ReadonlySet<string>): Promise<void> {
  for (const path of await listTree(directory)) {
    const absolute = join(directory, ...path.split('/'))
    await chmod(absolute, executablePaths.has(path) ? 0o755 : 0o644)
    await utimes(absolute, epoch, epoch)
  }
  const directories = await listDirectories(directory)
  for (const path of directories) {
    await chmod(path, 0o755)
    await utimes(path, epoch, epoch)
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  const directories = [directory]
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(...await listDirectories(join(directory, entry.name)))
  }
  return directories
}

async function writeDeterministicZip(stage: string, output: string, epoch: Date): Promise<void> {
  const entries: Zippable = {}
  for (const path of await listTree(stage)) {
    const mode = (await stat(join(stage, ...path.split('/')))).mode & 0o777
    const options: ZipOptions = { mtime: epoch, attrs: mode << 16, os: 3 }
    entries[path] = [await readFile(join(stage, ...path.split('/'))), options]
  }
  await writeFile(output, zipSync(entries, { level: 9, mtime: epoch }))
}

function sourceDateEpoch(): Date {
  const raw = process.env.SOURCE_DATE_EPOCH
  const seconds = raw === undefined || raw === '' ? defaultSourceDateEpoch : Number(raw)
  if (!Number.isSafeInteger(seconds) || seconds < 315_532_800) {
    throw new Error(`standalone CLI: SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01, got ${JSON.stringify(raw)}`)
  }
  return new Date(seconds * 1000)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(value => value.isFile(), () => false)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const nodeRuntimeRoot = process.env.DSH_NODE_RUNTIME_ROOT
  if (nodeRuntimeRoot === undefined || nodeRuntimeRoot === '') {
    throw new Error('standalone CLI: DSH_NODE_RUNTIME_ROOT must name the local allowlisted Node distribution directory')
  }
  const version = process.env.DSH_NODE_RUNTIME_VERSION ?? defaultNodeVersion
  const outputDirectory = resolve(root, process.env.DSH_CLI_STANDALONE_OUTPUT ?? 'dist/cli-standalone')
  const outputs = await buildCliStandalone({
    platform: process.platform,
    arch: process.arch,
    version,
    nodeRuntimeRoot,
    outputDirectory,
  })
  process.stdout.write(`${outputs.map(name => join(outputDirectory, name)).join('\n')}\n`)
}
