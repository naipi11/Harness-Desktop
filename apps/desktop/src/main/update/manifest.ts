/** Desktop Main-process signed update manifest parsing and fail-closed selection. */

import { createPublicKey, verify } from 'node:crypto'
import type { DesktopUpdateChannel } from '@harness-desktop/dsh-host-local-runtime'

const CHANNELS = ['stable', 'beta', 'nightly'] as const satisfies readonly DesktopUpdateChannel[]
const PLATFORMS = ['win32', 'darwin', 'linux'] as const
const ARCHITECTURES = ['x64', 'arm64', 'universal'] as const
const FORMATS = ['nsis', 'dmg', 'appimage', 'deb'] as const
const SHA256 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SEMANTIC_VERSION = new RegExp([
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)',
  '(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?',
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
].join(''))

/** One platform whose installer may appear in a signed Desktop update manifest. */
export type DesktopUpdatePlatform = typeof PLATFORMS[number]

/** One supported Desktop artifact architecture. */
export type DesktopUpdateArchitecture = typeof ARCHITECTURES[number]

/** One supported Desktop installer family. */
export type DesktopUpdateArtifactFormat = typeof FORMATS[number]

/** One signed artifact declaration before download or extraction. */
export interface DesktopUpdateArtifact {
  /** Operating-system target. */
  readonly platform: DesktopUpdatePlatform
  /** CPU target. */
  readonly arch: DesktopUpdateArchitecture
  /** Installer or archive family. */
  readonly format: DesktopUpdateArtifactFormat
  /** HTTPS release location, retained only inside Main-process verification. */
  readonly url: string
  /** Lowercase SHA-256 digest of the downloaded artifact. */
  readonly sha256: string
  /** Declared safe member paths that a later extractor must verify against the artifact. */
  readonly members: readonly string[]
}

/** Exact fields signed for one Desktop update release. */
export interface DesktopUpdateManifestPayload {
  /** Current signed-manifest grammar version. */
  readonly schemaVersion: 1
  /** Frozen Harness Desktop application identity. */
  readonly applicationId: string
  /** Release channel carrying this candidate. */
  readonly channel: DesktopUpdateChannel
  /** Candidate semantic version. */
  readonly version: string
  /** All target-specific artifacts for this candidate. */
  readonly artifacts: readonly DesktopUpdateArtifact[]
}

/** Detached Ed25519 signature attached to one manifest payload. */
export interface DesktopUpdateManifestSignature {
  /** Fixed public-key signature algorithm. */
  readonly algorithm: 'ed25519'
  /** Trusted public-key identifier. */
  readonly keyId: string
  /** Base64url-encoded detached signature. */
  readonly value: string
}

/** One signed Desktop update manifest. */
export interface SignedDesktopUpdateManifest extends DesktopUpdateManifestPayload {
  /** Detached signature over {@link canonicalizeDesktopUpdateManifest}. */
  readonly signature: DesktopUpdateManifestSignature
}

/** Trusted release locations and Ed25519 public keys compiled into Desktop Main. */
export interface DesktopUpdateManifestTrust {
  /** Exact HTTPS origins allowed for release artifacts. */
  readonly allowedOrigins: readonly string[]
  /** PEM-encoded public keys keyed by their signed manifest identifier. */
  readonly publicKeys: Readonly<Record<string, string>>
}

/** Request context a Main-process caller supplies for one update check. */
export interface DesktopUpdateManifestPolicy extends DesktopUpdateManifestTrust {
  /** Frozen app identity expected by this installed Desktop instance. */
  readonly appId: string
  /** Installed semantic version that candidates must exceed. */
  readonly currentVersion: string
  /** Runtime-owned release channel selected by the user. */
  readonly channel: DesktopUpdateChannel
  /** Current operating-system target. */
  readonly platform: NodeJS.Platform
  /** Current CPU target. */
  readonly arch: string
}

/** Secret-free selected artifact returned to a later staging owner. */
export interface RedactedDesktopUpdateArtifact {
  /** Verified candidate semantic version. */
  readonly version: string
  /** Verified selected channel. */
  readonly channel: DesktopUpdateChannel
  /** Verified operating-system target. */
  readonly platform: DesktopUpdatePlatform
  /** Verified CPU target. */
  readonly arch: DesktopUpdateArchitecture
  /** Verified artifact family. */
  readonly format: DesktopUpdateArtifactFormat
  /** Verified SHA-256 digest. */
  readonly sha256: string
  /** Verified archive members in deterministic order. */
  readonly members: readonly string[]
}

/** Stable reason an update manifest was rejected without reflecting input. */
export type DesktopUpdateManifestRejectionCode =
  | 'unconfigured-trust-root'
  | 'malformed-manifest'
  | 'signature-invalid'
  | 'application-mismatch'
  | 'channel-mismatch'
  | 'version-not-newer'
  | 'target-mismatch'
  | 'artifact-origin-invalid'
  | 'digest-invalid'
  | 'archive-path-invalid'
  | 'artifact-ambiguous'

/** Outcome of one Main-process manifest verification. */
export type DesktopUpdateManifestVerification =
  | { readonly kind: 'accepted'; readonly artifact: RedactedDesktopUpdateArtifact }
  | { readonly kind: 'rejected'; readonly code: DesktopUpdateManifestRejectionCode }

/** Empty shipped trust configuration: no production update source is accepted by default. */
export const PRODUCTION_DESKTOP_UPDATE_TRUST: DesktopUpdateManifestTrust = Object.freeze({
  allowedOrigins: Object.freeze([]),
  publicKeys: Object.freeze({}),
})

/**
 * Produce the exact bytes an Ed25519 signer and verifier use for one payload.
 * @param payload - already typed signed fields without a signature.
 * @returns UTF-8 canonical bytes independent of input artifact or member ordering.
 */
export function canonicalizeDesktopUpdateManifest(payload: DesktopUpdateManifestPayload): Buffer {
  const artifacts = orderedArtifacts(payload.artifacts).map(artifact => ({
    platform: artifact.platform,
    arch: artifact.arch,
    format: artifact.format,
    url: artifact.url,
    sha256: artifact.sha256,
    members: [...artifact.members].sort(compareText),
  }))
  return Buffer.from(JSON.stringify({
    schemaVersion: payload.schemaVersion,
    applicationId: payload.applicationId,
    channel: payload.channel,
    version: payload.version,
    artifacts,
  }), 'utf8')
}

/**
 * Verify and select exactly one signed Desktop update artifact without mutating local state.
 * @param input - untrusted decoded manifest JSON.
 * @param policy - trusted Main-process request and compiled trust policy.
 * @returns one accepted redacted artifact or a stable rejection code.
 */
export function verifyDesktopUpdateManifest(
  input: unknown,
  policy: DesktopUpdateManifestPolicy,
): DesktopUpdateManifestVerification {
  if (policy.allowedOrigins.length === 0 || Object.keys(policy.publicKeys).length === 0) {
    return rejected('unconfigured-trust-root')
  }
  let manifest: SignedDesktopUpdateManifest | undefined
  try {
    manifest = parseManifest(input)
  } catch {
    return rejected('malformed-manifest')
  }
  if (manifest === undefined) return rejected('malformed-manifest')
  if (hasDuplicateTargets(manifest.artifacts)) return rejected('artifact-ambiguous')
  if (!verifySignature(manifest, policy.publicKeys)) return rejected('signature-invalid')
  if (manifest.applicationId !== policy.appId) return rejected('application-mismatch')
  if (manifest.channel !== policy.channel) return rejected('channel-mismatch')
  if (!isStrictlyNewer(manifest.version, policy.currentVersion)) return rejected('version-not-newer')
  const target = selectTarget(manifest.artifacts, policy.platform, policy.arch)
  if (target.kind === 'ambiguous') return rejected('artifact-ambiguous')
  if (target.kind === 'none') return rejected('target-mismatch')
  const selected = target.artifact
  if (!isAllowedArtifactUrl(selected.url, policy.allowedOrigins)) return rejected('artifact-origin-invalid')
  if (!SHA256.test(selected.sha256)) return rejected('digest-invalid')
  if (!hasSafeArchiveMembers(selected.members)) return rejected('archive-path-invalid')
  return {
    kind: 'accepted',
    artifact: {
      version: manifest.version,
      channel: manifest.channel,
      platform: selected.platform,
      arch: selected.arch,
      format: selected.format,
      sha256: selected.sha256,
      members: [...selected.members].sort(compareText),
    },
  }
}

function rejected(code: DesktopUpdateManifestRejectionCode): DesktopUpdateManifestVerification {
  return { kind: 'rejected', code }
}

function parseManifest(input: unknown): SignedDesktopUpdateManifest | undefined {
  if (!isExactRecord(input, ['schemaVersion', 'applicationId', 'channel', 'version', 'artifacts', 'signature'])) return undefined
  if (input.schemaVersion !== 1 || !isBoundedText(input.applicationId, 256)
    || !isChannel(input.channel) || !isSemanticVersion(input.version)
    || !Array.isArray(input.artifacts) || input.artifacts.length === 0 || input.artifacts.length > 32) return undefined
  const artifacts: DesktopUpdateArtifact[] = []
  for (const candidate of input.artifacts as unknown[]) {
    const artifact = parseArtifact(candidate)
    if (artifact === undefined) return undefined
    artifacts.push(artifact)
  }
  const signature = parseSignature(input.signature)
  if (signature === undefined) return undefined
  return {
    schemaVersion: 1,
    applicationId: input.applicationId,
    channel: input.channel,
    version: input.version,
    artifacts,
    signature,
  }
}

function parseArtifact(input: unknown): DesktopUpdateArtifact | undefined {
  if (!isExactRecord(input, ['platform', 'arch', 'format', 'url', 'sha256', 'members'])) return undefined
  if (!isPlatform(input.platform) || !isArchitecture(input.arch) || !isFormat(input.format)
    || !isBoundedText(input.url, 2048) || !isBoundedText(input.sha256, 128)
    || !Array.isArray(input.members) || input.members.length === 0 || input.members.length > 4096) return undefined
  const members: string[] = []
  for (const member of input.members as unknown[]) {
    if (!isBoundedText(member, 512)) return undefined
    members.push(member)
  }
  return {
    platform: input.platform,
    arch: input.arch,
    format: input.format,
    url: input.url,
    sha256: input.sha256,
    members,
  }
}

function parseSignature(input: unknown): DesktopUpdateManifestSignature | undefined {
  if (!isExactRecord(input, ['algorithm', 'keyId', 'value']) || input.algorithm !== 'ed25519'
    || !isBoundedText(input.keyId, 128) || !isBoundedText(input.value, 256)) return undefined
  return { algorithm: 'ed25519', keyId: input.keyId, value: input.value }
}

function verifySignature(manifest: SignedDesktopUpdateManifest, publicKeys: Readonly<Record<string, string>>): boolean {
  const pem = publicKeys[manifest.signature.keyId]
  if (pem === undefined || !BASE64URL.test(manifest.signature.value)) return false
  let signature: Buffer
  try {
    signature = Buffer.from(manifest.signature.value, 'base64url')
  } catch {
    return false
  }
  if (signature.length !== 64) return false
  try {
    return verify(null, canonicalizeDesktopUpdateManifest(manifest), createPublicKey(pem), signature)
  } catch {
    return false
  }
}

type TargetSelection =
  | { readonly kind: 'selected'; readonly artifact: DesktopUpdateArtifact }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }

function selectTarget(
  artifacts: readonly DesktopUpdateArtifact[],
  platform: NodeJS.Platform,
  arch: string,
): TargetSelection {
  if (!isPlatform(platform) || !isRuntimeArchitecture(arch)) return { kind: 'none' }
  const matching = artifacts.filter(artifact => artifact.platform === platform
    && (artifact.arch === arch || artifact.arch === 'universal'))
  if (matching.length === 0) return { kind: 'none' }
  if (matching.length > 1) return { kind: 'ambiguous' }
  const target = matching[0]
  if (target === undefined || !formatMatchesPlatform(target.format, target.platform, target.arch)) return { kind: 'none' }
  return { kind: 'selected', artifact: target }
}

function isAllowedArtifactUrl(value: string, allowedOrigins: readonly string[]): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '' && allowedOrigins.includes(url.origin)
  } catch {
    return false
  }
}

function hasSafeArchiveMembers(members: readonly string[]): boolean {
  return new Set(members).size === members.length && members.every(isSafeArchiveMember)
}

function isSafeArchiveMember(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\u0000-\u001F\u007F]/u.test(value)) return false
  const segments = value.split('/')
  return segments.length > 0 && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function hasDuplicateTargets(artifacts: readonly DesktopUpdateArtifact[]): boolean {
  const targets = new Set<string>()
  for (const artifact of artifacts) {
    const target = `${artifact.platform}:${artifact.arch}`
    if (targets.has(target)) return true
    targets.add(target)
  }
  return false
}

function orderedArtifacts(artifacts: readonly DesktopUpdateArtifact[]): readonly DesktopUpdateArtifact[] {
  return [...artifacts].sort((left, right) => compareText(
    `${left.platform}:${left.arch}:${left.format}`,
    `${right.platform}:${right.arch}:${right.format}`,
  ))
}

function formatMatchesPlatform(
  format: DesktopUpdateArtifactFormat,
  platform: DesktopUpdatePlatform,
  arch: DesktopUpdateArchitecture,
): boolean {
  if (platform === 'win32') return format === 'nsis'
  if (platform === 'darwin') return format === 'dmg' && arch === 'universal'
  return arch !== 'universal' && (format === 'appimage' || format === 'deb')
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return actual.length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key]
    return descriptor !== undefined && 'value' in descriptor
  })
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function isChannel(value: unknown): value is DesktopUpdateChannel {
  return typeof value === 'string' && CHANNELS.includes(value as DesktopUpdateChannel)
}

function isPlatform(value: unknown): value is DesktopUpdatePlatform {
  return typeof value === 'string' && PLATFORMS.includes(value as DesktopUpdatePlatform)
}

function isArchitecture(value: unknown): value is DesktopUpdateArchitecture {
  return typeof value === 'string' && ARCHITECTURES.includes(value as DesktopUpdateArchitecture)
}

function isRuntimeArchitecture(value: unknown): value is Exclude<DesktopUpdateArchitecture, 'universal'> {
  return value === 'x64' || value === 'arm64'
}


function isFormat(value: unknown): value is DesktopUpdateArtifactFormat {
  return typeof value === 'string' && FORMATS.includes(value as DesktopUpdateArtifactFormat)
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && SEMANTIC_VERSION.test(value)
}

function isStrictlyNewer(candidate: string, current: string): boolean {
  const parsedCandidate = parseSemanticVersion(candidate)
  const parsedCurrent = parseSemanticVersion(current)
  return parsedCandidate !== undefined && parsedCurrent !== undefined && compareSemanticVersion(parsedCandidate, parsedCurrent) > 0
}

interface SemanticVersion {
  readonly major: string
  readonly minor: string
  readonly patch: string
  readonly prerelease?: readonly string[]
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = SEMANTIC_VERSION.exec(value)
  if (match === null) return undefined
  const [, major = '', minor = '', patch = '', prerelease] = match
  return {
    major,
    minor,
    patch,
    ...prerelease === undefined ? {} : { prerelease: prerelease.split('.') },
  }
}

function compareSemanticVersion(left: SemanticVersion, right: SemanticVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumericText(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1
  if (right.prerelease === undefined) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const candidate = left.prerelease[index]
    const current = right.prerelease[index]
    if (candidate === undefined) return -1
    if (current === undefined) return 1
    const candidateNumeric = /^\d+$/u.test(candidate)
    const currentNumeric = /^\d+$/u.test(current)
    if (candidateNumeric && currentNumeric) {
      const comparison = compareNumericText(candidate, current)
      if (comparison !== 0) return comparison
      continue
    }
    if (candidateNumeric !== currentNumeric) return candidateNumeric ? -1 : 1
    const comparison = compareText(candidate, current)
    if (comparison !== 0) return comparison
  }
  return 0
}

function compareNumericText(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return compareText(left, right)
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}
