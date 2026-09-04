/** Build and verify ephemeral manifests over the exact Desktop and CLI artifacts produced by one native CI row. */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { UpdateArchitecture, UpdateArtifactFormat, UpdatePlatform } from '@harness-desktop/dsh-update-policy'
import desktopPackage from '../../apps/desktop/package.json' with { type: 'json' }
import cliPackage from '../../apps/cli/package.json' with { type: 'json' }
import { writeUpdateManifests, type UpdateManifestArtifactInput } from './build-update-manifest.ts'
import { resolveUpdateSnapshotRoot, updateSnapshotRootEnvironment } from './update-snapshot-root.ts'
import { verifyUpdateManifests } from './verify-update-manifests.ts'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const origin = 'https://ci-artifacts.example.invalid'
const keyId = 'ci-produced-artifacts'

interface ProducedTarget {
  readonly consumer: 'desktop' | 'cli'
  readonly platform: UpdatePlatform
  readonly arch: UpdateArchitecture
  readonly format: UpdateArtifactFormat
  readonly artifactPath: string
}

/** One redacted binding from a signed manifest digest to its exact locally generated artifact digest. */
export interface ProducedManifestBinding {
  readonly target: string
  readonly artifact: { readonly basename: string; readonly sha256: string }
  readonly manifest: { readonly basename: string; readonly sha256: string }
}

/** Machine-readable result for callers that must pass the immutable root to a later evidence collector. */
export interface ProducedManifestVerification {
  readonly snapshotRoot: string
  readonly bindings: readonly ProducedManifestBinding[]
}

/** Explicit repository, environment, and immutable output-root inputs for one verification invocation. */
export interface VerifyProducedUpdateManifestsOptions {
  readonly repositoryRoot?: string
  readonly snapshotRoot?: string
  readonly environment?: Readonly<NodeJS.ProcessEnv>
}

/** Generate an ephemeral Ed25519 key, sign real row artifacts, verify them, and persist redacted digest bindings. */
export async function verifyProducedUpdateManifests(
  options: VerifyProducedUpdateManifestsOptions = {},
): Promise<readonly ProducedManifestBinding[]> {
  return (await verifyProducedUpdateManifestsWithRoot(options)).bindings
}

/** Verify produced artifacts and return the exact snapshot root used by this invocation. */
export async function verifyProducedUpdateManifestsWithRoot(
  options: VerifyProducedUpdateManifestsOptions = {},
): Promise<ProducedManifestVerification> {
  const root = resolve(options.repositoryRoot ?? repositoryRoot)
  if (desktopPackage.version !== cliPackage.version) throw new Error('produced update manifests require one Desktop and CLI version')
  const targets = await producedTargets(root)
  const temporary = await mkdtemp(join(tmpdir(), 'harness-produced-update-manifests-'))
  const resolvedSnapshotRoot = await resolveProducedSnapshotRoot(root, options)
  const snapshotRoot = resolvedSnapshotRoot.absolutePath
  const artifactSnapshots = join(snapshotRoot, 'artifacts')
  const output = join(snapshotRoot, 'manifests')
  try {
    if (!resolvedSnapshotRoot.precreated) await mkdir(snapshotRoot)
    await mkdir(artifactSnapshots)
    const snapshotPaths = new Map<string, string>()
    for (const artifactPath of await producedUploadArtifacts(root, targets)) {
      const snapshotPath = join(artifactSnapshots, basename(artifactPath))
      await snapshotArtifact(artifactPath, snapshotPath)
      snapshotPaths.set(artifactPath, snapshotPath)
    }
    const snapshotTargets = targets.map(target => ({
      ...target,
      artifactPath: snapshotPaths.get(target.artifactPath) ?? (() => { throw new Error('produced artifact snapshot is missing') })(),
    }))
    const keys = generateKeyPairSync('ed25519')
    const privateKeyPath = join(temporary, 'private.pem')
    const publicKeyPath = join(temporary, 'public.pem')
    await Promise.all([
      writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }),
      writeFile(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
    ])
    const artifacts: UpdateManifestArtifactInput[] = snapshotTargets.map(target => ({
      channel: 'stable',
      consumer: target.consumer,
      platform: target.platform,
      arch: target.arch,
      format: target.format,
      artifactPath: target.artifactPath,
      url: `${origin}/${encodeURIComponent(basename(target.artifactPath))}`,
    }))
    const names = await writeUpdateManifests({
      currentVersion: '1.0.0',
      version: desktopPackage.version,
      keyId,
      signingKeyPath: privateKeyPath,
      outputDirectory: output,
      artifacts,
    })
    const manifests = names.map((name) => {
      const filename = basename(name)
      const target = snapshotTargets.find(candidate => filename === `stable-${candidate.consumer}-${candidate.platform}-${candidate.arch}-${candidate.format.replace('.', '-')}.json`)
      if (target === undefined) throw new Error('produced update manifest target ordering changed')
      return {
        manifestPath: join(output, name),
        artifactPath: target.artifactPath,
        channel: 'stable' as const,
        consumer: target.consumer,
        platform: target.platform,
        arch: target.arch,
        format: target.format,
        allowedOrigins: [origin],
      }
    })
    const violations = await verifyUpdateManifests({ currentVersion: '1.0.0', keyId, verificationKeyPath: publicKeyPath, manifests })
    if (violations.length > 0) throw new Error(`produced update manifest verification failed: ${violations.join('; ')}`)
    const bindings = await Promise.all(manifests.map(async target => ({
      target: `${target.consumer}/${target.platform}/${target.arch}/${target.format}`,
      artifact: { basename: basename(target.artifactPath), sha256: sha256(await readFile(target.artifactPath)) },
      manifest: { basename: basename(target.manifestPath), sha256: sha256(await readFile(target.manifestPath)) },
    })))
    await writeFile(join(snapshotRoot, 'bindings.json'), `${JSON.stringify(bindings, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return { snapshotRoot, bindings }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Resolve a caller-selected root, or reserve a fresh `dist/` child for a local invocation. */
async function resolveProducedSnapshotRoot(
  repositoryRoot: string,
  options: VerifyProducedUpdateManifestsOptions,
): Promise<{ readonly absolutePath: string; readonly precreated: boolean }> {
  const environment = options.environment ?? process.env
  if (options.snapshotRoot !== undefined || environment[updateSnapshotRootEnvironment] !== undefined) {
    return {
      absolutePath: resolveUpdateSnapshotRoot({
        repositoryRoot,
        ...(options.snapshotRoot === undefined ? {} : { snapshotRoot: options.snapshotRoot }),
        environment,
      }).absolutePath,
      precreated: false,
    }
  }
  const fresh = await mkdtemp(join(repositoryRoot, 'dist', 'update-snapshots-'))
  return {
    absolutePath: resolveUpdateSnapshotRoot({
      repositoryRoot,
      snapshotRoot: relative(repositoryRoot, fresh).split(sep).join('/'),
      environment,
    }).absolutePath,
    precreated: true,
  }
}

/** Copy one stable no-follow artifact read into an exclusive private snapshot. */
export async function snapshotArtifact(source: string, destination: string): Promise<void> {
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('produced artifact is not a private regular file')
  }
  const handle = await open(source, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('produced artifact changed while opening')
    }
    await writeFile(destination, await handle.readFile(), { flag: 'wx', mode: 0o600 })
  } finally {
    await handle.close()
  }
}

async function producedUploadArtifacts(root: string, targets: readonly ProducedTarget[]): Promise<readonly string[]> {
  const paths = new Set(targets.map(target => target.artifactPath))
  const desktopDirectory = join(root, 'apps', 'desktop', 'release')
  const cliDirectory = join(root, 'dist', 'cli-standalone')
  const desktopNames = await readdir(desktopDirectory)
  const cliNames = await readdir(cliDirectory)
  if (process.platform === 'darwin') paths.add(exact(desktopDirectory, desktopNames, '.dmg', `Harness Desktop-${desktopPackage.version}-universal`))
  if (process.platform === 'linux') paths.add(exact(desktopDirectory, desktopNames, '.deb', `harness-desktop_${desktopPackage.version}_`))
  for (const target of targets.filter(target => target.consumer === 'cli')) {
    const stem = basename(target.artifactPath).replace(/\.(?:zip|tar\.gz)$/u, '')
    paths.add(exact(cliDirectory, cliNames, '.sha256', stem))
  }
  return [...paths]
}

async function producedTargets(root: string): Promise<readonly ProducedTarget[]> {
  const desktopDirectory = join(root, 'apps', 'desktop', 'release')
  const cliDirectory = join(root, 'dist', 'cli-standalone')
  const desktopNames = await readdir(desktopDirectory)
  const cliNames = await readdir(cliDirectory)
  if (process.platform === 'win32') return [
    target(
      'desktop', 'win32', 'x64', 'nsis',
      exact(desktopDirectory, desktopNames, '.exe', `Setup ${desktopPackage.version}`),
    ),
    target('cli', 'win32', 'x64', 'zip', exact(cliDirectory, cliNames, '.zip', `harness-cli-${cliPackage.version}-win32-x64`)),
  ]
  if (process.platform === 'darwin') return [
    target('desktop', 'darwin', 'universal', 'zip', exact(desktopDirectory, desktopNames, '.zip', '-universal-mac')),
    target('cli', 'darwin', 'arm64', 'tar.gz', exact(cliDirectory, cliNames, '.tar.gz', `harness-cli-${cliPackage.version}-darwin-arm64`)),
    target('cli', 'darwin', 'x64', 'tar.gz', exact(cliDirectory, cliNames, '.tar.gz', `harness-cli-${cliPackage.version}-darwin-x64`)),
  ]
  if (process.platform === 'linux') return [
    target('desktop', 'linux', 'x64', 'appimage', exact(desktopDirectory, desktopNames, '.AppImage', desktopPackage.version)),
    target('cli', 'linux', 'x64', 'tar.gz', exact(cliDirectory, cliNames, '.tar.gz', `harness-cli-${cliPackage.version}-linux-x64`)),
  ]
  throw new Error(`produced update manifests do not support ${process.platform}`)
}

function target(
  consumer: ProducedTarget['consumer'], platform: UpdatePlatform, arch: UpdateArchitecture,
  format: UpdateArtifactFormat, artifactPath: string,
): ProducedTarget { return { consumer, platform, arch, format, artifactPath } }

function exact(directory: string, names: readonly string[], suffix: string, contains: string): string {
  const matches = names.filter(name => name.endsWith(suffix) && name.includes(contains))
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`produced update manifests expected one ${contains} ${suffix} artifact, found ${String(matches.length)}`)
  }
  return join(directory, matches[0])
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyProducedUpdateManifestsWithRoot({ environment: process.env })
  process.stdout.write(`release: verified ${String(result.bindings.length)} produced artifact manifests at ${result.snapshotRoot}.\n`)
}
