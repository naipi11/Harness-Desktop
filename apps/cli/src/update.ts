/** Package-manager guidance and fail-closed standalone CLI update transactions. */

import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  EMPTY_UPDATE_TRUST,
  verifySignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateTrust,
} from '@harness-desktop/dsh-update-policy'

/** Result of one package-manager or standalone CLI update invocation. */
export type UpdateInvocationResult =
  | { readonly kind: 'managed-by-npm' }
  | { readonly kind: 'up-to-date'; readonly code: 'version-not-newer' }
  | { readonly kind: 'staged'; readonly version: string }
  | { readonly kind: 'applied'; readonly version: string }
  | { readonly kind: 'applied-with-cleanup-failure'; readonly code: 'retained-cleanup-failed'; readonly version: string }
  | { readonly kind: 'rolled-back'; readonly version: string }
  | { readonly kind: 'failed'; readonly code: 'candidate-rejected' | 'transaction-failed' | 'unconfigured-update-source' | 'unsupported-installation' }

/** Signed archive bytes supplied by a configured release source. */
interface LoadedCandidate {
  /** Decoded manifest still requiring shared-policy verification. */
  readonly manifest: SignedUpdateManifest
  /** Candidate archive bytes whose digest and members are verified locally. */
  readonly bytes: Uint8Array
}

/** Dependencies for one update transaction. No shipped caller supplies a trust root. */
export interface UpdateInvocationOptions {
  /** Resolved CLI module location, used to derive the immutable installed layout. */
  readonly entryPath: string
  /** Installed CLI semantic version. */
  readonly version: string
  /** Human-readable command output writer. */
  readonly stdout: Pick<NodeJS.WritableStream, 'write'>
  /** Audited release trust supplied by a configured standalone distribution. */
  readonly trust?: UpdateTrust
  /** Configured source that supplies one manifest and archive only after trust is present. */
  readonly loadCandidate?: () => Promise<LoadedCandidate>
  /** Process platform used only by the resolved installed layout and archive executor. */
  readonly platform?: NodeJS.Platform
  /** Process architecture supplied to shared artifact selection. */
  readonly arch?: string
  /** Filesystem operations owned by the transaction; tests may inject failure paths. */
  readonly operations?: Partial<UpdateFileOperations>
  /** Candidate health probe; production launches only the bundled Node executable. */
  readonly healthCheck?: (root: string, platform: NodeJS.Platform) => Promise<boolean>
}

interface StandaloneLayout {
  readonly root: string
}

type InstallationLayout = { readonly kind: 'npm' } | { readonly kind: 'standalone'; readonly root: string } | { readonly kind: 'unsupported' }

/** Filesystem operations confined to one sibling standalone transaction. */
export interface UpdateFileOperations {
  access(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>
  readFile(path: string): Promise<Buffer>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>
  stat(path: string): Promise<{ readonly mode: number }>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
}

const defaultOperations: UpdateFileOperations = { access, chmod, mkdir, readFile, rename, rm, stat, writeFile }

/**
 * Updates one CLI installation without creating a Runtime or Web attachment.
 * @param options - resolved installation layout, output, and optional configured update source.
 * @returns a redacted package-manager, no-op, or transaction settlement.
 */
export async function runUpdateInvocation(options: UpdateInvocationOptions): Promise<UpdateInvocationResult> {
  const installation = installationLayout(options.entryPath)
  if (installation.kind === 'npm') {
    options.stdout.write('npm update -g @harness-desktop/cli\n')
    return { kind: 'managed-by-npm' }
  }
  if (installation.kind === 'unsupported') return { kind: 'failed', code: 'unsupported-installation' }
  const platform = options.platform ?? process.platform
  const operations = { ...defaultOperations, ...options.operations }
  const trust = options.trust ?? EMPTY_UPDATE_TRUST
  if (trust.allowedOrigins.length === 0 || Object.keys(trust.publicKeys).length === 0) {
    return { kind: 'failed', code: 'unconfigured-update-source' }
  }
  if (options.loadCandidate === undefined) return { kind: 'failed', code: 'transaction-failed' }

  let loaded: LoadedCandidate
  try {
    loaded = await options.loadCandidate()
  } catch {
    return { kind: 'failed', code: 'candidate-rejected' }
  }
  const verification = verifySignedUpdateManifest(loaded.manifest, {
    appId: productMetadata.appId,
    currentVersion: options.version,
    channel: 'stable',
    consumer: 'cli',
    platform,
    arch: options.arch ?? process.arch,
    ...trust,
  })
  if (verification.kind === 'rejected') {
    return verification.code === 'version-not-newer'
      ? { kind: 'up-to-date', code: 'version-not-newer' }
      : { kind: 'failed', code: 'candidate-rejected' }
  }
  if (digest(loaded.bytes) !== verification.artifact.sha256) return { kind: 'failed', code: 'candidate-rejected' }
  if (verification.artifact.format !== 'zip' && verification.artifact.format !== 'tar.gz') {
    return { kind: 'failed', code: 'candidate-rejected' }
  }
  return applyStandaloneCandidate(
    installation,
    verification.artifact.version,
    verification.artifact.format,
    verification.artifact.members,
    loaded.bytes,
    platform,
    operations,
    options.healthCheck,
  )
}

function installationLayout(entryPath: string): InstallationLayout {
  const packageRoot = dirname(dirname(entryPath))
  const packageParent = dirname(packageRoot)
  if (basename(packageParent) === '@harness-desktop' && basename(dirname(packageParent)) === 'node_modules') return { kind: 'npm' }
  if (basename(packageRoot) !== 'package' || basename(packageParent) !== 'cli') return { kind: 'unsupported' }
  return { kind: 'standalone', root: dirname(packageParent) }
}

function basename(path: string): string { return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? '' }

async function applyStandaloneCandidate(
  layout: StandaloneLayout,
  version: string,
  format: 'zip' | 'tar.gz',
  members: readonly string[],
  bytes: Uint8Array,
  platform: NodeJS.Platform,
  operations: UpdateFileOperations,
  healthCheck: ((root: string, platform: NodeJS.Platform) => Promise<boolean>) | undefined,
): Promise<UpdateInvocationResult> {
  const candidate = `${layout.root}.candidate-${randomUUID()}`
  const retained = `${layout.root}.retained-${randomUUID()}`
  try {
    await operations.mkdir(candidate, { recursive: true })
    await extractVerifiedArchive(candidate, format, members, bytes, platform, operations)
  } catch {
    await operations.rm(candidate, { recursive: true, force: true })
    return { kind: 'failed', code: 'candidate-rejected' }
  }

  try {
    await operations.rename(layout.root, retained)
    try {
      await operations.rename(candidate, layout.root)
    } catch {
      try { await operations.rename(retained, layout.root) } catch {}
      return { kind: 'failed', code: 'transaction-failed' }
    }
  } catch {
    await operations.rm(candidate, { recursive: true, force: true })
    return { kind: 'failed', code: 'transaction-failed' }
  }

  const healthy = healthCheck === undefined
    ? candidateIsHealthy(layout.root, platform)
    : healthCheck(layout.root, platform)
  if (await healthy) {
    try {
      await operations.rm(retained, { recursive: true, force: true })
    } catch {
      return { kind: 'applied-with-cleanup-failure', code: 'retained-cleanup-failed', version }
    }
    return { kind: 'applied', version }
  }
  const displaced = `${layout.root}.failed-${randomUUID()}`
  try {
    await operations.rename(layout.root, displaced)
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
  try {
    await operations.rename(retained, layout.root)
  } catch {
    try { await operations.rename(displaced, layout.root) } catch {}
    return { kind: 'failed', code: 'transaction-failed' }
  }
  try {
    await operations.rm(displaced, { recursive: true, force: true })
    return { kind: 'rolled-back', version }
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
}

async function extractVerifiedArchive(
  destination: string,
  format: 'zip' | 'tar.gz',
  declared: readonly string[],
  bytes: Uint8Array,
  platform: NodeJS.Platform,
  operations: UpdateFileOperations,
): Promise<void> {
  if (format === 'zip') {
    const entries = unzipSync(bytes)
    const members = Object.keys(entries).filter(path => !path.endsWith('/'))
    if (!sameMembers(members, declared)) throw new Error('archive members do not match signed manifest')
    await Promise.all(members.map(async (member) => {
      const content = entries[member]
      if (content === undefined) throw new Error('archive member is absent')
      const target = join(destination, ...member.split('/'))
      await operations.mkdir(dirname(target), { recursive: true })
      await operations.writeFile(target, content)
    }))
    await restoreStandaloneExecutablePaths(destination, 'zip', declared, platform, operations)
    return
  }
  const archive = join(destination, '.candidate.tar.gz')
  await operations.writeFile(archive, bytes)
  await verifyTarMembers(archive, declared)
  await tar.x({ file: archive, cwd: destination, strict: true })
  await operations.rm(archive, { force: true })
  await restoreStandaloneExecutablePaths(destination, 'tar.gz', declared, platform, operations)
}

async function verifyTarMembers(archive: string, declared: readonly string[]): Promise<void> {
  const entries: Array<{ readonly path: string; readonly type: tar.types.EntryTypeName }> = []
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      entries.push({ path: entry.path, type: entry.type })
    },
  })
  if (entries.some(entry => entry.type !== 'File' || !isSafeMember(entry.path))
    || !sameMembers(entries.map(entry => entry.path), declared)) {
    throw new Error('archive members do not match signed manifest')
  }
}

async function restoreStandaloneExecutablePaths(
  root: string,
  format: 'zip' | 'tar.gz',
  declared: readonly string[],
  platform: NodeJS.Platform,
  operations: UpdateFileOperations,
): Promise<void> {
  const manifestPath = join(root, 'manifest.json')
  const parsed = JSON.parse((await operations.readFile(manifestPath)).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('standalone manifest is invalid')
  const executablePaths = (parsed as { readonly executablePaths?: unknown }).executablePaths
  if (!isStringArray(executablePaths)) {
    throw new Error('standalone executable paths are invalid')
  }
  const sorted = [...new Set(executablePaths)].toSorted()
  if (JSON.stringify(executablePaths) !== JSON.stringify(sorted)
    || sorted.some(path => !declared.includes(path) || !isSafeMember(path))) {
    throw new Error('standalone executable paths are invalid')
  }
  for (const path of sorted) {
    const target = join(root, ...path.split('/'))
    if (format === 'zip') await operations.chmod(target, 0o755)
    if (platform !== 'win32' && ((await operations.stat(target)).mode & 0o777) !== 0o755) {
      throw new Error('standalone executable mode is invalid')
    }
  }
}

async function candidateIsHealthy(root: string, platform: NodeJS.Platform): Promise<boolean> {
  const node = join(root, 'runtime', platform === 'win32' ? 'node.exe' : join('bin', 'node'))
  const entry = join(root, 'cli', 'package', 'lib', 'bin.js')
  try {
    const result = await execa(node, [entry, '--help'], { reject: false, timeout: 30_000, windowsHide: true })
    return result.exitCode === 0 && /^Usage: harness/mu.test(result.stdout)
  } catch {
    return false
  }
}

function sameMembers(actual: readonly string[], declared: readonly string[]): boolean {
  const left = [...actual].sort()
  const right = [...declared].sort()
  return left.length === right.length && left.every((member, index) => member === right[index])
}

function isSafeMember(path: string): boolean {
  return !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
