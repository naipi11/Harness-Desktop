/** Write a redacted, deterministic inventory of one native release matrix row. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveUpdateSnapshotRoot, updateSnapshotRootEnvironment } from './update-snapshot-root.ts'

const root = resolve(import.meta.dirname, '../..')
const outputRelativePath = 'dist/release-logs/release-evidence.json'
const artifactRootRelativePaths = [
  'artifacts',
  'manifests/ready',
] as const
const matrixLabels = new Set([
  'windows-nsis',
  'macos-universal-dmg-zip',
  'linux-appimage-deb',
])
const cliFormats = new Set(['zip', 'tar.gz'])
const checkEnvironment = {
  nodeRuntime: 'DSH_RELEASE_CHECK_NODE_RUNTIME',
  desktopArtifacts: 'DSH_RELEASE_CHECK_DESKTOP_ARTIFACTS',
  desktopUpdater: 'DSH_RELEASE_CHECK_DESKTOP_UPDATER',
  packedCli: 'DSH_RELEASE_CHECK_PACKED_CLI',
  cliArchives: 'DSH_RELEASE_CHECK_CLI_ARCHIVES',
  updateManifests: 'DSH_RELEASE_CHECK_UPDATE_MANIFESTS',
  producedUpdateManifests: 'DSH_RELEASE_CHECK_PRODUCED_UPDATE_MANIFESTS',
  cliUpdater: 'DSH_RELEASE_CHECK_CLI_UPDATER',
  installedDesktop: 'DSH_RELEASE_CHECK_INSTALLED_DESKTOP',
  nativeUpdateRollback: 'DSH_RELEASE_CHECK_NATIVE_UPDATE_ROLLBACK',
} as const
const checkOutcomes = new Set(['success', 'failure', 'skipped', 'cancelled', 'not-run'])

/** The fixed status fields recorded for every native release matrix row. */
export interface ReleaseEvidenceChecks {
  readonly nodeRuntime: ReleaseEvidenceCheckOutcome
  readonly desktopArtifacts: ReleaseEvidenceCheckOutcome
  readonly desktopUpdater: ReleaseEvidenceCheckOutcome
  readonly packedCli: ReleaseEvidenceCheckOutcome
  readonly cliArchives: ReleaseEvidenceCheckOutcome
  readonly updateManifests: ReleaseEvidenceCheckOutcome
  readonly producedUpdateManifests: ReleaseEvidenceCheckOutcome
  readonly cliUpdater: ReleaseEvidenceCheckOutcome
  readonly installedDesktop: ReleaseEvidenceCheckOutcome
  readonly nativeUpdateRollback: ReleaseEvidenceCheckOutcome
}

/** One allowed, non-sensitive result of a fixed release check. */
export type ReleaseEvidenceCheckOutcome = 'success' | 'failure' | 'skipped' | 'cancelled' | 'not-run'

/** One redacted immutable artifact record. */
export interface ReleaseEvidenceArtifact {
  readonly basename: string
  readonly size: number
  readonly sha256: string
}

/** The complete redacted evidence document. */
export interface ReleaseEvidence {
  readonly schemaVersion: 2
  readonly runner: { readonly platform: NodeJS.Platform; readonly arch: string }
  readonly commit?: string
  readonly matrixLabel: string
  readonly cliFormat: 'zip' | 'tar.gz'
  readonly checks: ReleaseEvidenceChecks
  readonly artifacts: readonly ReleaseEvidenceArtifact[]
  readonly manifestBindings: readonly ReleaseEvidenceManifestBinding[]
}

/** Redacted proof that one manifest digest authenticates one exact produced artifact digest. */
export interface ReleaseEvidenceManifestBinding {
  readonly target: string
  readonly artifact: { readonly basename: string; readonly sha256: string }
  readonly manifest: { readonly basename: string; readonly sha256: string }
}

/** Inputs for one local repository copy, explicit snapshot root, and safe environment. */
export interface CollectReleaseEvidenceOptions {
  readonly repositoryRoot?: string
  /** Repository-relative root; when omitted, the environment must define `DSH_UPDATE_SNAPSHOT_ROOT`. */
  readonly snapshotRoot?: string
  readonly environment?: Readonly<NodeJS.ProcessEnv>
  readonly runnerPlatform?: NodeJS.Platform
  readonly runnerArch?: string
}

/**
 * Collect and write one redacted release-evidence document.
 * @param options - repository, safe environment, and runner identity overrides for tests.
 * @returns the exact document written below `dist/release-logs`.
 * @throws when neither the options nor environment select the immutable snapshot root.
 */
export async function collectReleaseEvidence(
  options: CollectReleaseEvidenceOptions = {},
): Promise<ReleaseEvidence> {
  const repositoryRoot = resolve(options.repositoryRoot ?? root)
  const environment = options.environment ?? process.env
  if (options.snapshotRoot === undefined && environment[updateSnapshotRootEnvironment] === undefined) {
    throw new Error(`release evidence: ${updateSnapshotRootEnvironment} is required`)
  }
  const snapshotRoot = resolveUpdateSnapshotRoot({
    repositoryRoot,
    ...(options.snapshotRoot === undefined ? {} : { snapshotRoot: options.snapshotRoot }),
    environment,
  })
  const commit = validCommit(environment.GITHUB_SHA)
  const evidence: ReleaseEvidence = {
    schemaVersion: 2,
    runner: {
      platform: options.runnerPlatform ?? platform(),
      arch: options.runnerArch ?? arch(),
    },
    ...(commit === undefined ? {} : { commit }),
    matrixLabel: requiredValue(environment, 'DSH_RELEASE_MATRIX_LABEL', matrixLabels),
    cliFormat: requiredValue(environment, 'DSH_RELEASE_CLI_FORMAT', cliFormats) as 'zip' | 'tar.gz',
    checks: collectChecks(environment),
    ...await collectBoundEvidence(repositoryRoot, snapshotRoot.relativePath),
  }
  await writeEvidence(repositoryRoot, evidence)
  return evidence
}

async function collectBoundEvidence(repositoryRoot: string, snapshotRootRelativePath: string): Promise<{
  readonly artifacts: readonly ReleaseEvidenceArtifact[]
  readonly manifestBindings: readonly ReleaseEvidenceManifestBinding[]
}> {
  const snapshotRoot = await existingDirectoryInside(repositoryRoot, snapshotRootRelativePath)
  if (snapshotRoot === undefined) return { artifacts: [], manifestBindings: [] }
  const artifacts = await collectArtifacts(snapshotRoot)
  const manifestBindings = await collectManifestBindings(snapshotRoot)
  const byName = new Map(artifacts.map(artifact => [artifact.basename, artifact]))
  for (const binding of manifestBindings) {
    if (byName.get(binding.artifact.basename)?.sha256 !== binding.artifact.sha256
      || byName.get(binding.manifest.basename)?.sha256 !== binding.manifest.sha256) {
      throw new Error('release evidence: manifest binding does not match immutable snapshots')
    }
  }
  return { artifacts, manifestBindings }
}

async function collectManifestBindings(snapshotRoot: string): Promise<readonly ReleaseEvidenceManifestBinding[]> {
  const path = resolveInside(snapshotRoot, 'bindings.json')
  let decoded: unknown
  try { decoded = JSON.parse(await readFile(path, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('release evidence: produced manifest bindings are invalid', { cause: error })
  }
  if (!Array.isArray(decoded) || decoded.some(value => !isManifestBinding(value))) {
    throw new Error('release evidence: produced manifest bindings are invalid')
  }
  return (decoded as ReleaseEvidenceManifestBinding[]).toSorted((left, right) => left.target.localeCompare(right.target, 'en'))
}

function isManifestBinding(value: unknown): value is ReleaseEvidenceManifestBinding {
  if (!isRecord(value) || Object.keys(value).toSorted().join(',') !== 'artifact,manifest,target'
    || typeof value.target !== 'string' || !isDigestRecord(value.artifact) || !isDigestRecord(value.manifest)) return false
  return true
}

function isDigestRecord(value: unknown): value is { readonly basename: string; readonly sha256: string } {
  return isRecord(value) && Object.keys(value).toSorted().join(',') === 'basename,sha256'
    && typeof value.basename === 'string' && value.basename === basename(value.basename)
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  allowed: ReadonlySet<string>,
): string {
  const value = environment[name]
  if (value === undefined || !allowed.has(value)) throw new Error(`release evidence: ${name} is invalid`)
  return value
}

function validCommit(value: string | undefined): string | undefined {
  if (value === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) return undefined
  return value.toLowerCase()
}

function collectChecks(environment: Readonly<NodeJS.ProcessEnv>): ReleaseEvidenceChecks {
  return {
    nodeRuntime: checkOutcome(environment, checkEnvironment.nodeRuntime),
    desktopArtifacts: checkOutcome(environment, checkEnvironment.desktopArtifacts),
    desktopUpdater: checkOutcome(environment, checkEnvironment.desktopUpdater),
    packedCli: checkOutcome(environment, checkEnvironment.packedCli),
    cliArchives: checkOutcome(environment, checkEnvironment.cliArchives),
    updateManifests: checkOutcome(environment, checkEnvironment.updateManifests),
    producedUpdateManifests: checkOutcome(environment, checkEnvironment.producedUpdateManifests),
    cliUpdater: checkOutcome(environment, checkEnvironment.cliUpdater),
    installedDesktop: checkOutcome(environment, checkEnvironment.installedDesktop),
    nativeUpdateRollback: checkOutcome(environment, checkEnvironment.nativeUpdateRollback),
  }
}

function checkOutcome(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): ReleaseEvidenceCheckOutcome {
  if (environment[name] === undefined) return 'not-run'
  return requiredValue(environment, name, checkOutcomes) as ReleaseEvidenceCheckOutcome
}

async function collectArtifacts(snapshotRoot: string): Promise<readonly ReleaseEvidenceArtifact[]> {
  assertDirectory(await lstat(snapshotRoot))
  const files = (await Promise.all(artifactRootRelativePaths.map(relativeRoot => collectArtifactRoot(
    snapshotRoot,
    relativeRoot,
  )))).flat()
  const artifacts = await Promise.all(files.map(async (path) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error('release evidence: artifact is not a regular file')
      const bytes = await handle.readFile()
      return {
        basename: basename(path),
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    } finally {
      await handle.close()
    }
  }))
  return artifacts.toSorted((left, right) => left.basename.localeCompare(right.basename, 'en')
    || left.sha256.localeCompare(right.sha256, 'en'))
}

async function collectArtifactRoot(
  repositoryRoot: string,
  relativeRoot: string,
): Promise<readonly string[]> {
  const artifactRoot = await existingDirectoryInside(repositoryRoot, relativeRoot)
  return artifactRoot === undefined ? [] : await collectDirectory(artifactRoot, artifactRoot)
}

async function collectDirectory(directory: string, artifactRoot: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  const files: string[] = []
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const path = resolveInside(directory, entry.name)
    resolveInside(artifactRoot, relative(artifactRoot, path))
    const metadata = await lstat(path)
    assertNotLink(metadata)
    if (metadata.isDirectory()) files.push(...await collectDirectory(path, artifactRoot))
    else if (metadata.isFile()) files.push(path)
    else throw new Error('release evidence: artifact root contains a non-regular file')
  }
  return files
}

function assertDirectory(metadata: Awaited<ReturnType<typeof lstat>>): void {
  assertNotLink(metadata)
  if (!metadata.isDirectory()) throw new Error('release evidence: artifact root is not a directory')
}

function assertNotLink(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (metadata.isSymbolicLink()) throw new Error('release evidence: symbolic links and reparse points are forbidden')
}

function resolveInside(directory: string, child: string): string {
  const resolved = resolve(directory, child)
  const remainder = relative(directory, resolved)
  if (remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))) {
    return resolved
  }
  throw new Error('release evidence: path escapes its allowed root')
}

async function writeEvidence(repositoryRoot: string, evidence: ReleaseEvidence): Promise<void> {
  const output = resolveInside(repositoryRoot, outputRelativePath)
  const outputDirectory = await ensureDirectoryInside(repositoryRoot, 'dist/release-logs')
  const existing = await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) {
    assertNotLink(existing)
    if (!existing.isFile()) throw new Error('release evidence: output is not a regular file')
    throw new Error('release evidence: final output already exists')
  }
  const temporary = resolveInside(outputDirectory, `.${basename(output)}.${randomUUID()}.tmp`)
  let failure: unknown
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`)
    } finally {
      await handle.close()
    }
    const metadata = await lstat(temporary)
    assertNotLink(metadata)
    if (!metadata.isFile()) throw new Error('release evidence: temporary output is not a regular file')
    // link() is an atomic no-clobber publication. rename() can silently replace
    // a concurrently created result and must not publish over another owner.
    await link(temporary, output)
  } catch (error) {
    failure = error
  }
  try {
    await rm(temporary, { force: true })
  } catch (cleanupError) {
    if (failure === undefined) failure = cleanupError
    else failure = new AggregateError([failure, cleanupError], 'release evidence: temporary output cleanup failed')
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error('release evidence: unexpected non-error failure')
}

async function existingDirectoryInside(directory: string, child: string): Promise<string | undefined> {
  let current = directory
  for (const segment of child.split('/')) {
    current = resolveInside(current, segment)
    const metadata = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (metadata === undefined) return undefined
    assertDirectory(metadata)
  }
  return current
}

async function ensureDirectoryInside(directory: string, child: string): Promise<string> {
  assertDirectory(await lstat(directory))
  let current = directory
  for (const segment of child.split('/')) {
    current = resolveInside(current, segment)
    const existing = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined) await mkdir(current)
    assertDirectory(await lstat(current))
  }
  return current
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await collectReleaseEvidence()
}
