/** Package-manager guidance and fail-closed standalone CLI update transactions. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { scrubbedParentEnv } from '@harness-desktop/dsh-subprocess'
import {
  EMPTY_UPDATE_TRUST,
  standaloneCliUpdateTarget,
  verifySignedUpdateManifest,
  type ReleaseUpdateTarget,
  type UpdateFetch,
  type UpdateTrust,
} from '@harness-desktop/dsh-update-policy'
import { loadStandaloneUpdateSource, type StandaloneUpdateSource } from './standalone-update-source.ts'
import {
  currentWindowsStandaloneProcessReference,
  scheduleWindowsStandaloneUpdate,
  type WindowsStandaloneUpdatePlan,
} from './windows-standalone-update.ts'

/** Result of one package-manager or standalone CLI update invocation. */
export type UpdateInvocationResult =
  | { readonly kind: 'managed-by-npm' }
  | { readonly kind: 'up-to-date'; readonly code: 'version-not-newer' }
  | { readonly kind: 'staged'; readonly version: string }
  | { readonly kind: 'applied'; readonly version: string }
  | { readonly kind: 'applied-with-cleanup-failure'; readonly code: 'retained-cleanup-failed'; readonly version: string }
  | { readonly kind: 'restart-scheduled'; readonly version: string }
  | { readonly kind: 'rolled-back'; readonly version: string }
  | { readonly kind: 'failed'; readonly code: 'candidate-rejected' | 'transaction-failed' | 'unconfigured-update-source' | 'unsupported-installation' }

/** Signed archive bytes supplied by a configured release source. */
interface LoadedCandidate {
  /** Decoded manifest still requiring shared-policy verification. */
  readonly manifest: unknown
  /** Candidate archive bytes whose digest and members are verified locally. */
  readonly bytes: Uint8Array
}

/** Dependencies for one update transaction. */
export interface UpdateInvocationOptions {
  /** Resolved CLI module location, used to derive the immutable installed layout. */
  readonly entryPath: string
  /** Installed CLI semantic version. */
  readonly version: string
  /** Human-readable command output writer. */
  readonly stdout: Pick<NodeJS.WritableStream, 'write'>
  /** Test-only audited release trust paired with {@link loadCandidate}. */
  readonly trust?: UpdateTrust
  /** Test-only source that supplies one manifest and archive in one fixture operation. */
  readonly loadCandidate?: () => Promise<LoadedCandidate>
  /** Test or embedding source with static trust and separate verified download operations. */
  readonly source?: StandaloneUpdateSource
  /** Optional release-source fetch implementation used only by integration tests or embedders. */
  readonly fetch?: UpdateFetch
  /** Process platform used only by the resolved installed layout and archive executor. */
  readonly platform?: NodeJS.Platform
  /** Process architecture supplied to shared artifact selection. */
  readonly arch?: string
  /** Filesystem operations owned by the transaction; tests may inject failure paths. */
  readonly operations?: Partial<UpdateFileOperations>
  /** Candidate health probe; production launches only the bundled Node executable. */
  readonly healthCheck?: (root: string, platform: NodeJS.Platform) => Promise<boolean>
  /** Test-only replacement for the detached Windows transaction scheduler. */
  readonly scheduleWindowsUpdate?: (plan: WindowsStandaloneUpdatePlan) => Promise<void>
}

interface StandaloneLayout {
  readonly root: string
  readonly transactionRoot: string
  readonly candidatePayload: (extractionRoot: string) => string
  readonly durable: boolean
}

type InstallationLayout = { readonly kind: 'npm' } | ({ readonly kind: 'standalone' } & StandaloneLayout) | { readonly kind: 'unsupported' }

/** Filesystem operations confined to one sibling standalone transaction. */
export interface UpdateFileOperations {
  access(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  /** Atomically create one private transaction file and reject an existing path. */
  createExclusiveFile(path: string, bytes: Uint8Array): Promise<void>
  lstat(path: string): Promise<{ readonly isDirectory: () => boolean; readonly isSymbolicLink: () => boolean }>
  mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
  /** Remove one exact private transaction file when it exists. */
  removeFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: {
    readonly recursive?: boolean
    readonly force?: boolean
    readonly maxRetries?: number
    readonly retryDelay?: number
  }): Promise<void>
  stat(path: string): Promise<{ readonly mode: number }>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  syncFile(path: string): Promise<void>
  syncDirectory(path: string): Promise<void>
}

const defaultOperations: UpdateFileOperations = {
  access,
  chmod,
  createExclusiveFile: async (path, bytes) => { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) },
  lstat,
  mkdir,
  realpath,
  readFile,
  removeFile: async (path) => { await rm(path, { force: true }) },
  rename,
  rm,
  stat,
  writeFile,
  syncFile: async (path) => {
    const handle = await open(path, 'r+')
    try { await handle.sync() } finally { await handle.close() }
  },
  syncDirectory: async (path) => {
    const handle = await open(path, process.platform === 'win32' ? 'a+' : constants.O_RDONLY)
    try { await handle.sync() } finally { await handle.close() }
  },
}

async function assertStandaloneDirectory(path: string, expectedParent: string, operations: UpdateFileOperations): Promise<void> {
  const details = await operations.lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('standalone CLI transaction path is not a private directory')
  const [canonicalParent, canonicalPath] = await Promise.all([operations.realpath(expectedParent), operations.realpath(path)])
  const child = relative(canonicalParent, canonicalPath)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || dirname(canonicalPath) !== canonicalParent) {
    throw new Error('standalone CLI transaction path escapes its private parent')
  }
}

async function removeStandaloneTree(path: string, operations: UpdateFileOperations): Promise<void> {
  const expectedParent = dirname(path)
  try { await assertStandaloneDirectory(path, expectedParent, operations) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await operations.rm(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    retryDelay: 25,
  })
}

/**
 * Updates one CLI installation without creating a Runtime or Web attachment.
 * @param options - resolved installation layout, output, and optional test collaborators.
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
  const target = standaloneCliUpdateTarget(platform, options.arch ?? process.arch)
  if (target === undefined) return { kind: 'failed', code: 'unsupported-installation' }
  const source = await resolveUpdateSource(installation, target, options.version, options)
  if (source === undefined) return { kind: 'failed', code: 'unconfigured-update-source' }
  const trust = options.trust ?? source.trust
  if (trust.allowedOrigins.length === 0 || Object.keys(trust.publicKeys).length === 0) {
    return { kind: 'failed', code: 'unconfigured-update-source' }
  }

  let manifest: unknown
  let legacyBytes: Uint8Array | undefined
  try {
    if (options.loadCandidate !== undefined) {
      const loaded = await options.loadCandidate()
      manifest = loaded.manifest
      legacyBytes = loaded.bytes
    } else {
      manifest = await source.loadManifest()
    }
  } catch {
    return { kind: 'failed', code: 'candidate-rejected' }
  }
  const verification = verifySignedUpdateManifest(manifest, {
    appId: productMetadata.appId,
    currentVersion: options.version,
    channel: 'stable',
    consumer: 'cli',
    platform,
    arch: options.arch ?? process.arch,
    format: target.format,
    ...trust,
  })
  if (verification.kind === 'rejected') {
    return verification.code === 'version-not-newer'
      ? { kind: 'up-to-date', code: 'version-not-newer' }
      : { kind: 'failed', code: 'candidate-rejected' }
  }
  if (verification.artifact.format !== 'zip' && verification.artifact.format !== 'tar.gz') {
    return { kind: 'failed', code: 'candidate-rejected' }
  }
  if (options.loadCandidate === undefined) {
    let rollback: ReturnType<typeof verifySignedUpdateManifest>
    try {
      rollback = verifySignedUpdateManifest(await source.loadRollbackManifest(), {
        appId: productMetadata.appId,
        currentVersion: options.version,
        channel: 'stable',
        consumer: 'cli',
        platform,
        arch: options.arch ?? process.arch,
        format: target.format,
        versionMode: 'current',
        ...trust,
      })
    } catch {
      return { kind: 'failed', code: 'candidate-rejected' }
    }
    if (rollback.kind !== 'accepted' || rollback.artifact.format !== target.format) {
      return { kind: 'failed', code: 'candidate-rejected' }
    }
  }
  let bytes: Uint8Array
  try {
    bytes = legacyBytes ?? await source.download(verification.artifact)
  } catch {
    return { kind: 'failed', code: 'candidate-rejected' }
  }
  if (digest(bytes) !== verification.artifact.sha256) return { kind: 'failed', code: 'candidate-rejected' }
  return applyStandaloneCandidate(
    installation,
    verification.artifact.version,
    verification.artifact.format,
    verification.artifact.members,
    bytes,
    platform,
    operations,
    options.healthCheck,
    source.healthCheckTimeoutMs,
    options.loadCandidate === undefined || options.scheduleWindowsUpdate !== undefined,
    options.scheduleWindowsUpdate,
  )
}

async function resolveUpdateSource(
  installation: StandaloneLayout,
  target: ReleaseUpdateTarget,
  currentVersion: string,
  options: UpdateInvocationOptions,
): Promise<StandaloneUpdateSource | undefined> {
  if (options.source !== undefined) return options.source
  if (options.loadCandidate !== undefined) {
    return {
      trust: options.trust ?? EMPTY_UPDATE_TRUST,
      healthCheckTimeoutMs: 120_000,
      loadManifest: () => Promise.reject(new Error('legacy candidate fixture must load through its paired operation')),
      loadRollbackManifest: () => Promise.reject(new Error('legacy candidate fixture must load through its paired operation')),
      download: () => Promise.reject(new Error('legacy candidate fixture must load through its paired operation')),
    }
  }
  try {
    return await loadStandaloneUpdateSource({
      root: installation.transactionRoot,
      target,
      currentVersion,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  } catch { return undefined }
}

function installationLayout(entryPath: string): InstallationLayout {
  const packageRoot = dirname(dirname(entryPath))
  const packageParent = dirname(packageRoot)
  if (basename(packageParent) === '@harness-desktop' && basename(dirname(packageParent)) === 'node_modules') return { kind: 'npm' }
  if (basename(packageRoot) !== 'package' || basename(packageParent) !== 'cli') return { kind: 'unsupported' }
  const payload = dirname(packageParent)
  if (basename(payload) === 'current' && basename(dirname(payload)) === 'payload') {
    const archiveRoot = dirname(dirname(payload))
    return {
      kind: 'standalone',
      root: payload,
      transactionRoot: archiveRoot,
      candidatePayload: (extraction: string) => join(extraction, 'payload', 'current'),
      durable: true,
    }
  }
  return {
    kind: 'standalone',
    root: payload,
    transactionRoot: payload,
    candidatePayload: (extraction: string) => extraction,
    durable: false,
  }
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
  healthCheckTimeoutMs: number,
  productionSource: boolean,
  scheduleWindowsUpdate: ((plan: WindowsStandaloneUpdatePlan) => Promise<void>) | undefined,
): Promise<UpdateInvocationResult> {
  if (layout.durable) {
    try { await recoverStandaloneUpdate(layout, operations) } catch {
      return { kind: 'failed', code: 'transaction-failed' }
    }
  }
  const lock = {
    path: layout.durable ? join(layout.transactionRoot, '.harness-update.lock') : `${layout.root}.update.lock`,
    token: randomUUID(),
  }
  try {
    await operations.createExclusiveFile(lock.path, Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      token: lock.token,
      processId: process.pid,
      executablePath: process.execPath,
      startedBeforeMs: Math.ceil(Date.now() - process.uptime() * 1000),
      expiresAtMs: Date.now() + Math.max(30_000, healthCheckTimeoutMs * 2),
    })}\n`))
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
  let result: UpdateInvocationResult
  try {
    result = await applyStandaloneCandidateUnderLock(
      layout,
      version,
      format,
      members,
      bytes,
      platform,
      operations,
      healthCheck,
      healthCheckTimeoutMs,
      productionSource,
      scheduleWindowsUpdate,
      lock,
    )
  } catch {
    result = { kind: 'failed', code: 'transaction-failed' }
  }
  if (result.kind === 'restart-scheduled') return result
  try {
    await releaseStandaloneUpdateLock(lock, operations)
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
  return result
}

async function applyStandaloneCandidateUnderLock(
  layout: StandaloneLayout,
  version: string,
  format: 'zip' | 'tar.gz',
  members: readonly string[],
  bytes: Uint8Array,
  platform: NodeJS.Platform,
  operations: UpdateFileOperations,
  healthCheck: ((root: string, platform: NodeJS.Platform) => Promise<boolean>) | undefined,
  healthCheckTimeoutMs: number,
  productionSource: boolean,
  scheduleWindowsUpdate: ((plan: WindowsStandaloneUpdatePlan) => Promise<void>) | undefined,
  lock: { readonly path: string; readonly token: string },
): Promise<UpdateInvocationResult> {
  const candidate = layout.durable
    ? join(layout.transactionRoot, `.harness-candidate-${randomUUID()}`)
    : `${layout.root}.candidate-${randomUUID()}`
  const retained = layout.durable ? join(dirname(layout.root), 'retained') : `${layout.root}.retained-${randomUUID()}`
  const failed = layout.durable ? join(dirname(layout.root), 'failed') : `${layout.root}.failed-${randomUUID()}`
  const journal = layout.durable ? join(layout.transactionRoot, '.harness-update.json') : undefined
  try {
    await operations.mkdir(candidate, { recursive: true })
    await extractVerifiedArchive(candidate, format, members, bytes, platform, operations)
  } catch {
    await removeStandaloneTree(candidate, operations)
    return { kind: 'failed', code: 'candidate-rejected' }
  }

  if (platform === 'win32' && productionSource) {
    if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'prepared', candidate, operations)
    const plan: WindowsStandaloneUpdatePlan = {
      schemaVersion: 2,
      parentProcess: currentWindowsStandaloneProcessReference(),
      root: layout.root,
      candidate,
      retained,
      failed,
      lockPath: lock.path,
      lockToken: lock.token,
      healthCheckTimeoutMs,
    }
    try {
      await (scheduleWindowsUpdate ?? scheduleWindowsStandaloneUpdate)(plan)
      return { kind: 'restart-scheduled', version }
    } catch {
      await removeStandaloneTree(candidate, operations)
      return { kind: 'failed', code: 'transaction-failed' }
    }
  }

  try {
    if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'prepared', candidate, operations)
    await assertStandaloneDirectory(layout.root, dirname(layout.root), operations)
    await operations.rename(layout.root, retained)
    if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'retained', candidate, operations)
    try {
      const candidatePayload = layout.candidatePayload(candidate)
      await assertStandaloneDirectory(candidatePayload, dirname(candidatePayload), operations)
      await operations.rename(candidatePayload, layout.root)
      if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'candidate-published', candidate, operations)
    } catch {
      try { await operations.rename(retained, layout.root) } catch {}
      return { kind: 'failed', code: 'transaction-failed' }
    }
  } catch {
    await removeStandaloneTree(candidate, operations)
    return { kind: 'failed', code: 'transaction-failed' }
  }

  const healthy = healthCheck === undefined
    ? candidateIsHealthy(layout.root, platform, healthCheckTimeoutMs)
    : healthCheck(layout.root, platform)
  if (await healthy) {
    if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'committed', candidate, operations)
    try {
      await removeStandaloneTree(retained, operations)
      await removeStandaloneTree(candidate, operations)
      if (journal !== undefined) await operations.removeFile(journal)
    } catch {
      return { kind: 'applied-with-cleanup-failure', code: 'retained-cleanup-failed', version }
    }
    return { kind: 'applied', version }
  }
  try {
    if (journal !== undefined) await writeStandaloneUpdateJournal(journal, 'rollback-started', candidate, operations)
    await assertStandaloneDirectory(layout.root, dirname(layout.root), operations)
    await operations.rename(layout.root, failed)
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
  try {
    await assertStandaloneDirectory(retained, dirname(retained), operations)
    await operations.rename(retained, layout.root)
  } catch {
    try { await operations.rename(failed, layout.root) } catch {}
    return { kind: 'failed', code: 'transaction-failed' }
  }
  try {
    await removeStandaloneTree(failed, operations)
    await removeStandaloneTree(candidate, operations)
    if (journal !== undefined) await operations.removeFile(journal)
    return { kind: 'rolled-back', version }
  } catch {
    return { kind: 'failed', code: 'transaction-failed' }
  }
}

type StandaloneUpdatePhase = 'prepared' | 'retained' | 'candidate-published' | 'rollback-started' | 'committed'

async function writeStandaloneUpdateJournal(
  path: string,
  phase: StandaloneUpdatePhase,
  candidate: string,
  operations: UpdateFileOperations,
): Promise<void> {
  const temporary = `${path}.staging-${randomUUID()}`
  try {
    await operations.createExclusiveFile(temporary, Buffer.from(`${JSON.stringify({ schemaVersion: 1, phase, candidate })}\n`))
    await operations.syncFile(temporary)
    await operations.rename(temporary, path)
    await operations.syncDirectory(dirname(path))
  } finally {
    await operations.rm(temporary, { force: true })
  }
}

/** Restore the stable payload from a durable standalone journal before a launcher or a later update proceeds. */
export async function recoverStandaloneUpdate(
  layout: StandaloneLayout,
  operations: UpdateFileOperations = defaultOperations,
): Promise<void> {
  if (!layout.durable) return
  const journalPath = join(layout.transactionRoot, '.harness-update.json')
  let decoded: unknown
  try { decoded = JSON.parse((await operations.readFile(journalPath)).toString('utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!isStandaloneUpdateJournal(decoded, layout.transactionRoot)) throw new Error('standalone CLI update journal is invalid')
  const retained = join(dirname(layout.root), 'retained')
  const failed = join(dirname(layout.root), 'failed')
  const exists = async (path: string): Promise<boolean> => operations.access(path).then(() => true, () => false)
  if (decoded.phase === 'committed') {
    await removeStandaloneTree(retained, operations)
  } else if (await exists(retained)) {
    if (await exists(layout.root)) {
      await removeStandaloneTree(failed, operations)
      await assertStandaloneDirectory(layout.root, dirname(layout.root), operations)
      await operations.rename(layout.root, failed)
    }
    await assertStandaloneDirectory(retained, dirname(retained), operations)
    await operations.rename(retained, layout.root)
    await removeStandaloneTree(failed, operations)
  } else if (!await exists(layout.root)) {
    throw new Error('standalone CLI update recovery has no launchable payload')
  }
  await removeStandaloneTree(decoded.candidate, operations)
  await operations.removeFile(journalPath)
  await operations.removeFile(join(layout.transactionRoot, '.harness-update.lock'))
}

function isStandaloneUpdateJournal(
  value: unknown,
  archiveRoot: string,
): value is { readonly schemaVersion: 1; readonly phase: StandaloneUpdatePhase; readonly candidate: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).toSorted().join(',') === 'candidate,phase,schemaVersion'
    && record.schemaVersion === 1 && typeof record.candidate === 'string'
    && new RegExp(
      `^${escapeRegularExpression(join(archiveRoot, '.harness-candidate-'))}`
      + '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      'iu',
    ).test(record.candidate)
    && ['prepared', 'retained', 'candidate-published', 'rollback-started', 'committed'].includes(String(record.phase))
}

function escapeRegularExpression(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

async function releaseStandaloneUpdateLock(
  lock: { readonly path: string; readonly token: string },
  operations: UpdateFileOperations,
): Promise<void> {
  let current: Buffer
  try {
    current = await operations.readFile(lock.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let decoded: unknown
  try { decoded = JSON.parse(current.toString('utf8')) as unknown } catch { decoded = undefined }
  if (!isStandaloneUpdateLock(decoded) || decoded.token !== lock.token) {
    throw new Error('standalone CLI: update transaction lock ownership changed')
  }
  await operations.removeFile(lock.path)
}

function isStandaloneUpdateLock(value: unknown): value is {
  readonly schemaVersion: 1
  readonly token: string
  readonly processId: number
  readonly executablePath: string
  readonly startedBeforeMs: number
  readonly expiresAtMs: number
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).toSorted().join(',') === 'executablePath,expiresAtMs,processId,schemaVersion,startedBeforeMs,token'
    && record.schemaVersion === 1 && typeof record.token === 'string'
    && typeof record.processId === 'number' && Number.isSafeInteger(record.processId) && record.processId > 0
    && typeof record.executablePath === 'string' && typeof record.startedBeforeMs === 'number' && Number.isSafeInteger(record.startedBeforeMs) && record.startedBeforeMs > 0
    && typeof record.expiresAtMs === 'number' && Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > 0
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
    if (members.some(member => !isSafeMember(member))) {
      throw new Error('archive members do not match signed manifest')
    }
    const verifiedMembers = usesStandaloneCatalog(declared)
      ? validateStandaloneCatalog(entries['manifest.json'], members)
      : declared
    if (!usesStandaloneCatalog(declared) && !sameMembers(members, declared)) {
      throw new Error('archive members do not match signed manifest')
    }
    await Promise.all(members.map(async (member) => {
      const content = entries[member]
      if (content === undefined) throw new Error('archive member is absent')
      const target = join(destination, ...member.split('/'))
      await operations.mkdir(dirname(target), { recursive: true })
      await operations.writeFile(target, content)
    }))
    await restoreStandaloneExecutablePaths(destination, 'zip', verifiedMembers, platform, operations)
    return
  }
  const archive = join(destination, '.candidate.tar.gz')
  await operations.writeFile(archive, bytes)
  const verifiedMembers = await verifyTarMembers(archive, declared)
  await tar.x({ file: archive, cwd: destination, strict: true })
  await operations.rm(archive, { force: true })
  await restoreStandaloneExecutablePaths(destination, 'tar.gz', verifiedMembers, platform, operations)
}

async function verifyTarMembers(archive: string, declared: readonly string[]): Promise<readonly string[]> {
  const entries: Array<{ readonly path: string; readonly type: tar.types.EntryTypeName }> = []
  const manifestChunks: Buffer[] = []
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      entries.push({ path: entry.path, type: entry.type })
      if (entry.path === 'manifest.json' && entry.type === 'File') {
        entry.on('data', (chunk) => { manifestChunks.push(Buffer.from(chunk)) })
      } else {
        entry.resume()
      }
    },
  })
  const members = entries.map(entry => entry.path)
  if (entries.some(entry => entry.type !== 'File' || !isSafeMember(entry.path))) {
    throw new Error('archive members do not match signed manifest')
  }
  if (usesStandaloneCatalog(declared)) return validateStandaloneCatalog(Buffer.concat(manifestChunks), members)
  if (!sameMembers(members, declared)) throw new Error('archive members do not match signed manifest')
  return declared
}

function usesStandaloneCatalog(declared: readonly string[]): boolean {
  return declared.length === 1 && declared[0] === 'manifest.json'
}

function validateStandaloneCatalog(manifestBytes: Uint8Array | undefined, actualMembers: readonly string[]): readonly string[] {
  if (manifestBytes === undefined) throw new Error('standalone archive member catalog is missing')
  let value: unknown
  try { value = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as unknown } catch {
    throw new Error('standalone archive member catalog is invalid')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('standalone archive member catalog is invalid')
  }
  const files = (value as { readonly files?: unknown }).files
  if (typeof files !== 'object' || files === null || Array.isArray(files)
    || Object.values(files).some(digest => typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest))) {
    throw new Error('standalone archive member catalog is invalid')
  }
  if (!sameMembers([...Object.keys(files), 'manifest.json'], actualMembers)) {
    throw new Error('standalone archive member catalog does not enumerate every member')
  }
  return actualMembers
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

async function candidateIsHealthy(root: string, platform: NodeJS.Platform, healthCheckTimeoutMs: number): Promise<boolean> {
  const node = join(root, 'runtime', platform === 'win32' ? 'node.exe' : join('bin', 'node'))
  const entry = join(root, 'cli', 'package', 'lib', 'bin.js')
  try {
    const result = await runNodeHealthCheck(node, entry, platform, healthCheckTimeoutMs)
    return result.exitCode === 0 && result.treeQuiescent
      && !result.timedOut && !result.outputLimitExceeded
      && /^Usage: harness/mu.test(result.stdout)
  } catch {
    return false
  }
}

function runNodeHealthCheck(
  node: string,
  entry: string,
  platform: NodeJS.Platform,
  healthCheckTimeoutMs: number,
): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly timedOut: boolean
  readonly outputLimitExceeded: boolean
  readonly treeQuiescent: boolean
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [entry, '--help'], {
      windowsHide: true,
      detached: platform !== 'win32',
      env: healthCheckEnvironment(platform),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const output: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let terminating = false
    let timedOut = false
    let outputLimitExceeded = false
    let forceKill: NodeJS.Timeout | undefined
    const clearTimers = () => {
      clearTimeout(timeout)
      if (forceKill !== undefined) clearTimeout(forceKill)
    }
    const settle = (exitCode: number | null, treeQuiescent: boolean) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve({ exitCode, stdout: Buffer.concat(output).toString('utf8'), timedOut, outputLimitExceeded, treeQuiescent })
    }
    const terminate = (reason: 'timeout' | 'output') => {
      if (settled || terminating) return
      terminating = true
      if (reason === 'timeout') timedOut = true
      else outputLimitExceeded = true
      terminateHealthProcessTree(child, platform, 'SIGTERM')
      forceKill = setTimeout(() => {
        if (settled) return
        terminateHealthProcessTree(child, platform, 'SIGKILL')
      }, Math.min(1_000, Math.max(25, Math.floor(healthCheckTimeoutMs / 10))))
    }
    const timeout = setTimeout(() => { terminate('timeout') }, healthCheckTimeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes <= 1_048_576) output.push(chunk)
      else terminate('output')
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.once('close', (exitCode) => {
      void settleHealthProcessTree(child, platform, healthCheckTimeoutMs).then(
        (treeQuiescent) => { settle(exitCode, treeQuiescent) },
        () => { settle(exitCode, false) },
      )
    })
  })
}

async function settleHealthProcessTree(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  timeoutMs: number,
): Promise<boolean> {
  if (child.pid === undefined) return false
  if (platform === 'win32') {
    const descendants = await windowsDescendantProcessIds(child.pid)
    if (descendants === undefined) return false
    if (descendants.length === 0) return true
    const taskkill = process.env.SystemRoot === undefined ? undefined : join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    if (taskkill === undefined) return false
    await Promise.all(descendants.map(async (processId) => {
      await new Promise<void>((resolve) => {
        const terminator = spawn(taskkill, ['/PID', String(processId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        terminator.once('error', () => { resolve() })
        terminator.once('close', () => { resolve() })
      })
    }))
    return false
  }
  const hadLiveMembers = posixProcessGroupIsAlive(child.pid)
  if (!hadLiveMembers) return true
  terminateHealthProcessTree(child, platform, 'SIGKILL')
  const deadline = Date.now() + Math.min(timeoutMs, 5_000)
  while (posixProcessGroupIsAlive(child.pid)) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
  return false
}

async function windowsDescendantProcessIds(rootProcessId: number): Promise<readonly number[] | undefined> {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined) return undefined
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)',
    `$frontier = @(${String(rootProcessId)})`,
    '$found = @()',
    'while ($frontier.Count -gt 0) {',
    '  $next = @($rows | Where-Object { $frontier -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })',
    '  $found += $next; $frontier = $next',
    '}',
    '$found | Sort-Object -Unique | ForEach-Object { Write-Output $_ }',
  ].join('; ')
  return await new Promise((resolve) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
      env: healthCheckEnvironment('win32'),
    }, (error, stdout) => {
      if (error !== null) { resolve(undefined); return }
      resolve(stdout.split(/\r?\n/u).flatMap((line) => {
        const value = Number(line.trim())
        return Number.isSafeInteger(value) && value > 0 ? [value] : []
      }))
    })
  })
}

function posixProcessGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

/** Keep the candidate health process free of Harness credentials and kill its process group on failure. */
function healthCheckEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const environment = scrubbedParentEnv()
  if (platform !== 'win32') return environment
  const systemRoot = process.env.SystemRoot
  return systemRoot === undefined ? environment : { ...environment, SystemRoot: systemRoot, WINDIR: systemRoot }
}

/** @param signal - graceful or forceful termination requested for the candidate tree. */
function terminateHealthProcessTree(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): void {
  if (platform !== 'win32' && child.pid !== undefined) {
    try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
    return
  }
  try { child.kill(signal) } catch {}
  if (platform === 'win32' && child.pid !== undefined) {
    // taskkill /T is the system-supported way to include descendants on Windows.
    const taskkill = process.env.SystemRoot === undefined
      ? undefined
      : join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    if (taskkill !== undefined) {
      try { spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    }
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
