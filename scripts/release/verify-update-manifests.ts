/** Verify signed update manifests against named local artifacts without publishing them. */

import { createHash, createPublicKey } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { path7za } from '7zip-bin'
import { execa } from 'execa'
import { unzipSync } from 'fflate'
import * as tar from 'tar'
import {
  verifySignedUpdateManifest,
  type UpdateArchitecture,
  type UpdateArtifactConsumer,
  type UpdateArtifactFormat,
  type UpdateChannel,
  type UpdatePlatform,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'

/** One expected manifest and its exact local artifact. */
export interface UpdateManifestVerificationTarget {
  readonly manifestPath: string
  readonly artifactPath: string
  readonly channel: UpdateChannel
  readonly consumer: UpdateArtifactConsumer
  readonly platform: UpdatePlatform
  readonly arch: UpdateArchitecture
  readonly format: UpdateArtifactFormat
  readonly allowedOrigins: readonly string[]
}

/** Inputs for a credential-free local manifest verification pass. */
export interface UpdateManifestVerificationInput {
  readonly currentVersion: string
  readonly keyId: string
  readonly verificationKeyPath: string
  readonly manifests: readonly UpdateManifestVerificationTarget[]
}

/** Bytes and file members observed directly from one local artifact. */
export interface InspectedUpdateArtifact {
  readonly bytes: Buffer
  readonly members: readonly string[]
}

/**
 * Inspect archive members from caller-owned snapshot bytes.
 * @param snapshot - exact bytes already matched to the signed digest.
 * @param format - archive format whose inspector applies.
 * @returns file-member paths from the snapshot.
 */
export type UpdateArtifactSnapshotInspector = (
  snapshot: Buffer,
  format: UpdateArtifactFormat,
) => Promise<readonly string[]>

/**
 * Inspect one named local artifact without downloading, installing, or publishing it.
 * @param artifactPath - local artifact file selected by the caller.
 * @param format - archive format whose native reader applies.
 * @returns exact bytes and sorted file-member paths.
 */
export async function inspectUpdateArtifact(
  artifactPath: string,
  format: UpdateArtifactFormat,
): Promise<InspectedUpdateArtifact> {
  const bytes = await readFile(artifactPath)
  return { bytes, members: await inspectUpdateArtifactSnapshot(bytes, format) }
}

/**
 * Inspect an immutable artifact snapshot without reopening the caller's path.
 * @param snapshot - exact bytes already read and hashed by the caller.
 * @param format - archive format whose portable or native reader applies.
 * @returns sorted, unique file-member paths from those exact bytes.
 */
export async function inspectUpdateArtifactSnapshot(
  snapshot: Buffer,
  format: UpdateArtifactFormat,
): Promise<readonly string[]> {
  if (format === 'zip') return uniqueSortedMembers(Object.keys(unzipSync(snapshot)).filter(path => !path.endsWith('/')))

  const directory = await mkdtemp(join(tmpdir(), 'harness-update-snapshot-'))
  const snapshotPath = join(directory, snapshotFilename(format))
  try {
    await writeFile(snapshotPath, snapshot, { flag: 'wx', mode: format === 'appimage' ? 0o700 : 0o600 })
    return uniqueSortedMembers(await inspectSnapshotMembers(snapshotPath, format))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Verify every manifest with the shared update-policy parser and its named local artifact.
 * @param input - expected targets, rollback version, and caller-supplied public-key file.
 * @param inspectSnapshot - inspector for bytes already matched to the signed digest.
 * @returns stable redacted diagnostics; empty means every target verified.
 */
export async function verifyUpdateManifests(
  input: UpdateManifestVerificationInput,
  inspectSnapshot: UpdateArtifactSnapshotInspector = inspectUpdateArtifactSnapshot,
): Promise<readonly string[]> {
  const duplicates = duplicateTargetDiagnostics(input.manifests)
  if (duplicates.length > 0) return duplicates

  const publicKeyBytes = await readFile(input.verificationKeyPath).catch((error: unknown) => {
    throw new Error('update manifest: verification key file is unavailable', { cause: error })
  })
  let publicKey: ReturnType<typeof createPublicKey>
  try {
    publicKey = createPublicKey(publicKeyBytes)
  } catch (error) {
    throw new Error('update manifest: verification key file is invalid', { cause: error })
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('update manifest: verification key must be Ed25519')
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

  const violations: string[] = []
  for (const target of input.manifests) {
    const label = basename(target.manifestPath)
    let manifest: unknown
    try {
      manifest = JSON.parse(await readFile(target.manifestPath, 'utf8')) as unknown
    } catch (error) {
      violations.push(`update manifest ${label}: cannot read JSON: ${errorMessage(error)}`)
      continue
    }
    const verification = verifySignedUpdateManifest(manifest, {
      appId: productMetadata.appId,
      currentVersion: input.currentVersion,
      channel: target.channel,
      consumer: target.consumer,
      platform: target.platform,
      arch: runtimeArchitecture(target.arch),
      allowedOrigins: target.allowedOrigins,
      publicKeys: { [input.keyId]: publicKeyPem },
    })
    if (verification.kind === 'rejected') {
      violations.push(`update manifest ${label}: shared policy rejected ${verification.code}`)
      continue
    }
    if (!hasExactExpectedArtifact(manifest, target)) {
      violations.push(`update manifest ${label}: must contain exactly one expected target artifact ${targetKey(target)}`)
      continue
    }
    const artifact = verification.artifact
    if (artifact.channel !== target.channel || artifact.consumer !== target.consumer
      || artifact.platform !== target.platform || artifact.arch !== target.arch || artifact.format !== target.format) {
      violations.push(`update manifest ${label}: selected artifact does not match expected target ${targetKey(target)}`)
      continue
    }

    let snapshot: Buffer
    try {
      snapshot = await readFile(target.artifactPath)
    } catch (error) {
      violations.push(`update manifest ${label}: local artifact read failed: ${errorMessage(error)}`)
      continue
    }
    if (sha256(snapshot) !== artifact.sha256) {
      violations.push(`update manifest ${label}: local artifact digest does not match signed digest`)
      continue
    }
    let members: readonly string[]
    try {
      members = uniqueSortedMembers(await inspectSnapshot(snapshot, target.format))
    } catch (error) {
      violations.push(`update manifest ${label}: local artifact inspection failed: ${errorMessage(error)}`)
      continue
    }
    if (!sameMembers(members, artifact.members)) {
      violations.push(`update manifest ${label}: local artifact members do not match signed members`)
    }
  }
  return violations
}

function duplicateTargetDiagnostics(
  targets: readonly UpdateManifestVerificationTarget[],
): string[] {
  const seen = new Set<string>()
  const violations: string[] = []
  for (const target of targets) {
    const key = targetKey(target)
    if (seen.has(key)) violations.push(`update manifest verification: duplicate target ${key}`)
    else seen.add(key)
  }
  return violations
}

function targetKey(target: Pick<
  UpdateManifestVerificationTarget,
  'channel' | 'consumer' | 'platform' | 'arch' | 'format'
>): string {
  return `${target.channel}/${target.consumer}/${target.platform}/${target.arch}/${target.format}`
}

function runtimeArchitecture(arch: UpdateArchitecture): string {
  return arch === 'universal' ? 'x64' : arch
}

async function inspectSnapshotMembers(
  snapshotPath: string,
  format: UpdateArtifactFormat,
): Promise<readonly string[]> {
  switch (format) {
    case 'tar.gz':
      return inspectTarMembers(snapshotPath)
    case 'nsis':
      return inspectNsisMembers(snapshotPath)
    case 'dmg':
      return inspectDmgMembers(snapshotPath)
    case 'appimage':
      return inspectAppImageMembers(snapshotPath)
    case 'deb':
      return inspectDebMembers(snapshotPath)
    case 'zip':
      throw new Error('ZIP snapshots are inspected in memory')
  }
  throw new Error(`unsupported update artifact format ${JSON.stringify(format)}`)
}

function snapshotFilename(format: UpdateArtifactFormat): string {
  switch (format) {
    case 'zip': return 'artifact.zip'
    case 'tar.gz': return 'artifact.tar.gz'
    case 'nsis': return 'artifact.exe'
    case 'dmg': return 'artifact.dmg'
    case 'appimage': return 'artifact.AppImage'
    case 'deb': return 'artifact.deb'
  }
  throw new Error(`unsupported update artifact format ${JSON.stringify(format)}`)
}

async function inspectTarMembers(artifactPath: string): Promise<readonly string[]> {
  const members: string[] = []
  await tar.t({
    file: artifactPath,
    strict: true,
    onReadEntry(entry) {
      if (entry.type === 'File') members.push(entry.path)
      else if (entry.type !== 'Directory') {
        throw new Error(`unsupported tar member type ${entry.type} at ${JSON.stringify(entry.path)}`)
      }
      entry.resume()
    },
  })
  return members
}

async function inspectNsisMembers(artifactPath: string): Promise<readonly string[]> {
  const listing = await execa(path7za, ['l', '-slt', artifactPath], { reject: true })
  const records = listing.stdout.split(/\r?\n\r?\n/u)
  const members: string[] = []
  let inEntries = false
  for (const record of records) {
    if (record.includes('----------')) inEntries = true
    if (!inEntries) continue
    const path = /^Path = (.+)$/mu.exec(record)?.[1]
    const attributes = /^Attributes = (.+)$/mu.exec(record)?.[1] ?? ''
    if (path !== undefined && !attributes.includes('D')) members.push(path.replaceAll('\\', '/'))
  }
  if (members.length === 0) throw new Error('NSIS artifact has no inspectable file members')
  return members
}

async function inspectDmgMembers(artifactPath: string): Promise<readonly string[]> {
  if (process.platform !== 'darwin') throw new Error('DMG inspection requires a macOS runner')
  const mount = await mkdtemp(join(tmpdir(), 'harness-update-dmg-'))
  let attached = false
  try {
    await execa('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifactPath], { reject: true })
    attached = true
    return await listNonDirectoryMembers(mount)
  } finally {
    if (attached) await execa('hdiutil', ['detach', mount], { reject: true })
    await rm(mount, { recursive: true, force: true })
  }
}

async function inspectAppImageMembers(artifactPath: string): Promise<readonly string[]> {
  if (process.platform !== 'linux') throw new Error('AppImage inspection requires a Linux runner')
  const extraction = await mkdtemp(join(tmpdir(), 'harness-update-appimage-'))
  try {
    await execa(artifactPath, ['--appimage-extract'], {
      cwd: extraction,
      env: {
        HOME: extraction,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: extraction,
      },
      extendEnv: false,
      reject: true,
    })
    return await listNonDirectoryMembers(join(extraction, 'squashfs-root'))
  } finally {
    await rm(extraction, { recursive: true, force: true })
  }
}

async function inspectDebMembers(artifactPath: string): Promise<readonly string[]> {
  if (process.platform !== 'linux') throw new Error('Deb inspection requires a Linux runner')
  const extraction = await mkdtemp(join(tmpdir(), 'harness-update-deb-'))
  try {
    await execa('dpkg-deb', ['--extract', artifactPath, extraction], { reject: true })
    return await listNonDirectoryMembers(extraction)
  } finally {
    await rm(extraction, { recursive: true, force: true })
  }
}

async function listNonDirectoryMembers(directory: string, prefix = ''): Promise<string[]> {
  const members: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) members.push(...await listNonDirectoryMembers(join(directory, entry.name), path))
    else members.push(path)
  }
  return members
}

function uniqueSortedMembers(members: readonly string[]): readonly string[] {
  const sorted = [...members].sort(compareText)
  if (new Set(sorted).size !== sorted.length) throw new Error('artifact contains duplicate file members')
  if (sorted.length === 0) throw new Error('artifact contains no file members')
  return sorted
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const right = [...expected].sort(compareText)
  return actual.length === right.length && actual.every((member, index) => member === right[index])
}

function hasExactExpectedArtifact(manifest: unknown, target: UpdateManifestVerificationTarget): boolean {
  if (!isRecord(manifest) || manifest.channel !== target.channel) return false
  const artifacts = manifest.artifacts
  if (!Array.isArray(artifacts) || artifacts.length !== 1) return false
  const artifact = (artifacts as unknown[]).at(0)
  return isRecord(artifact)
    && artifact.consumer === target.consumer
    && artifact.platform === target.platform
    && artifact.arch === target.arch
    && artifact.format === target.format
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(input: unknown, base: string, verificationKeyPath: string): UpdateManifestVerificationInput {
  if (!isRecord(input) || typeof input.currentVersion !== 'string' || typeof input.keyId !== 'string'
    || !Array.isArray(input.manifests)) {
    throw new Error('update manifest verifier: input must contain currentVersion, keyId, and manifests')
  }
  const manifests = input.manifests.map((target, index): UpdateManifestVerificationTarget => {
    if (!isRecord(target) || typeof target.manifestPath !== 'string' || typeof target.artifactPath !== 'string'
      || typeof target.channel !== 'string' || typeof target.consumer !== 'string' || typeof target.platform !== 'string'
      || typeof target.arch !== 'string' || typeof target.format !== 'string' || !Array.isArray(target.allowedOrigins)
      || target.allowedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error(`update manifest verifier: manifests[${index}] is invalid`)
    }
    return {
      manifestPath: resolve(base, target.manifestPath),
      artifactPath: resolve(base, target.artifactPath),
      channel: target.channel as UpdateChannel,
      consumer: target.consumer as UpdateArtifactConsumer,
      platform: target.platform as UpdatePlatform,
      arch: target.arch as UpdateArchitecture,
      format: target.format as UpdateArtifactFormat,
      allowedOrigins: target.allowedOrigins as string[],
    }
  })
  return {
    currentVersion: input.currentVersion,
    keyId: input.keyId,
    verificationKeyPath,
    manifests,
  }
}

async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--verification-key') {
    throw new Error('usage: verify-update-manifests.ts --input <config.json> --verification-key <public-key.pem>')
  }
  const configPath = resolve(args[1] ?? '')
  const keyPath = resolve(args[3] ?? '')
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  const violations = await verifyUpdateManifests(parseConfig(parsed, dirname(configPath), keyPath))
  for (const violation of violations) process.stderr.write(`${violation}\n`)
  if (violations.length === 0) process.stdout.write('release:verify-update-manifests: named local manifests verified.\n')
  return violations.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
