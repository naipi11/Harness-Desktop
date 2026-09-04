/** Signed update manifest parsing and fail-closed artifact selection. */

import { createPublicKey, verify } from 'node:crypto'

export {
  parseReleaseUpdateConfiguration,
  releaseManifestEndpoint,
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpoint,
  releaseRollbackManifestEndpointKey,
  standaloneCliUpdateTarget,
  ReleaseUpdateConfigurationError,
  type ReleaseUpdateConfiguration,
  type ReleaseUpdateConfigurationErrorCode,
  type ReleaseRollbackTarget,
  type ReleaseUpdateTarget,
  type StandaloneCliUpdateTarget,
} from './release-config.ts'

export {
  fetchAllowedUpdateBytes,
  fetchAllowedUpdateJson,
  UpdateSourceError,
  type UpdateFetch,
  type UpdateSourceErrorCode,
} from './https-source.ts'

const CHANNELS = ['stable', 'beta', 'nightly'] as const
const PLATFORMS = ['win32', 'darwin', 'linux'] as const
const ARCHITECTURES = ['x64', 'arm64', 'universal'] as const
const CONSUMERS = ['desktop', 'cli'] as const
const FORMATS = ['nsis', 'dmg', 'appimage', 'deb', 'zip', 'tar.gz'] as const
const SHA256 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SEMANTIC_VERSION = new RegExp([
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)',
  '(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?',
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
].join(''))

/** One release channel selected for signed updates. */
export type UpdateChannel = typeof CHANNELS[number]
/** One supported update artifact platform. */
export type UpdatePlatform = typeof PLATFORMS[number]
/** One supported update artifact architecture. */
export type UpdateArchitecture = typeof ARCHITECTURES[number]
/** One application form that can consume a signed update artifact. */
export type UpdateArtifactConsumer = typeof CONSUMERS[number]
/** One supported update artifact format. */
export type UpdateArtifactFormat = typeof FORMATS[number]

/** One signed artifact declaration before download or extraction. */
export interface UpdateArtifact {
  /** Application form allowed to install this artifact. */
  readonly consumer: UpdateArtifactConsumer
  /** Operating-system target. */
  readonly platform: UpdatePlatform
  /** CPU target. */
  readonly arch: UpdateArchitecture
  /** Installer or archive family. */
  readonly format: UpdateArtifactFormat
  /** HTTPS release location retained only during verification. */
  readonly url: string
  /** Lowercase SHA-256 digest of the downloaded artifact. */
  readonly sha256: string
  /** Safe archive member paths a later extractor must verify against the artifact. */
  readonly members: readonly string[]
}

/** Exact fields signed for one update release. */
export interface UpdateManifestPayload {
  /** Current signed-manifest grammar version. */
  readonly schemaVersion: 1
  /** Frozen application identity. */
  readonly applicationId: string
  /** Release channel carrying this candidate. */
  readonly channel: UpdateChannel
  /** Candidate semantic version. */
  readonly version: string
  /** All target-specific artifacts for this candidate. */
  readonly artifacts: readonly UpdateArtifact[]
}

/** Detached Ed25519 signature attached to one manifest payload. */
export interface UpdateManifestSignature {
  /** Fixed public-key signature algorithm. */
  readonly algorithm: 'ed25519'
  /** Trusted public-key identifier. */
  readonly keyId: string
  /** Base64url-encoded detached signature. */
  readonly value: string
}

/** One signed update manifest. */
export interface SignedUpdateManifest extends UpdateManifestPayload {
  /** Detached signature over {@link canonicalizeSignedUpdateManifest}. */
  readonly signature: UpdateManifestSignature
}

/** Trusted release origins and Ed25519 public keys. */
export interface UpdateTrust {
  /** Exact HTTPS origins allowed for release artifacts. */
  readonly allowedOrigins: readonly string[]
  /** PEM-encoded public keys keyed by their signed manifest identifier. */
  readonly publicKeys: Readonly<Record<string, string>>
}

/** Request context supplied for one update check. */
export interface UpdateManifestPolicy extends UpdateTrust {
  /** Frozen application identity expected by this installation. */
  readonly appId: string
  /** Installed semantic version that candidates must exceed. */
  readonly currentVersion: string
  /** Runtime-owned release channel selected by the user. */
  readonly channel: UpdateChannel
  /** Application form making this request. */
  readonly consumer: UpdateArtifactConsumer
  /** Current operating-system target. */
  readonly platform: NodeJS.Platform
  /** Current CPU target. */
  readonly arch: string
  /** Exact installer or archive family this client can install automatically. */
  readonly format: UpdateArtifactFormat
  /** Candidate relation accepted for this authenticated manifest lookup. Defaults to a newer release. */
  readonly versionMode?: 'newer' | 'current'
}

/** Secret-free selected artifact returned to a later staging owner. */
export interface RedactedUpdateArtifact {
  /** Verified candidate semantic version. */
  readonly version: string
  /** Verified selected channel. */
  readonly channel: UpdateChannel
  /** Verified application form allowed to install this artifact. */
  readonly consumer: UpdateArtifactConsumer
  /** Verified operating-system target. */
  readonly platform: UpdatePlatform
  /** Verified CPU target. */
  readonly arch: UpdateArchitecture
  /** Verified artifact family. */
  readonly format: UpdateArtifactFormat
  /** Verified SHA-256 digest. */
  readonly sha256: string
  /** Verified archive members in deterministic order. */
  readonly members: readonly string[]
}

/**
 * One artifact selected by a verified signed manifest, retained only by the
 * downloader that owns the following installation transaction.
 */
export interface VerifiedUpdateArtifact extends RedactedUpdateArtifact {
  /** HTTPS location authenticated by the verified signed manifest. */
  readonly url: string
}

/** Stable reason an update manifest was rejected without reflecting input. */
export type UpdateManifestRejectionCode =
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

/** Outcome of one signed manifest verification. */
export type UpdateManifestVerification =
  | { readonly kind: 'accepted'; readonly artifact: VerifiedUpdateArtifact }
  | { readonly kind: 'rejected'; readonly code: UpdateManifestRejectionCode }

/** Empty shipped trust configuration: no production update source is accepted by default. */
export const EMPTY_UPDATE_TRUST: UpdateTrust = Object.freeze({
  allowedOrigins: Object.freeze([]),
  publicKeys: Object.freeze({}),
})

/**
 * Produces the exact bytes an Ed25519 signer and verifier use for one payload.
 * @param payload - typed signed fields without a signature.
 * @returns UTF-8 canonical bytes independent of artifact or member ordering.
 */
export function canonicalizeSignedUpdateManifest(payload: UpdateManifestPayload): Buffer {
  const artifacts = orderedArtifacts(payload.artifacts).map(artifact => ({
    consumer: artifact.consumer,
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
 * Verifies and selects exactly one signed update artifact without mutating local state.
 * @param input - untrusted decoded manifest JSON.
 * @param policy - trusted request and compiled trust policy.
 * @returns one accepted redacted artifact or a stable rejection code.
 */
export function verifySignedUpdateManifest(input: unknown, policy: UpdateManifestPolicy): UpdateManifestVerification {
  if (policy.allowedOrigins.length === 0 || Object.keys(policy.publicKeys).length === 0) return rejected('unconfigured-trust-root')
  let manifest: SignedUpdateManifest | undefined
  try { manifest = parseManifest(input) } catch { return rejected('malformed-manifest') }
  if (manifest === undefined) return rejected('malformed-manifest')
  if (!verifySignature(manifest, policy.publicKeys)) return rejected('signature-invalid')
  if (manifest.applicationId !== policy.appId) return rejected('application-mismatch')
  if (manifest.channel !== policy.channel) return rejected('channel-mismatch')
  if (!matchesVersionMode(manifest.version, policy.currentVersion, policy.versionMode)) return rejected('version-not-newer')
  const target = selectTarget(manifest.artifacts, policy.consumer, policy.platform, policy.arch, policy.format)
  if (target.kind === 'ambiguous') return rejected('artifact-ambiguous')
  if (target.kind === 'none') return rejected('target-mismatch')
  if (!isAllowedArtifactUrl(target.artifact.url, policy.allowedOrigins)) return rejected('artifact-origin-invalid')
  if (!SHA256.test(target.artifact.sha256)) return rejected('digest-invalid')
  if (!hasSafeArchiveMembers(target.artifact.members)) return rejected('archive-path-invalid')
  return { kind: 'accepted', artifact: {
    version: manifest.version, channel: manifest.channel, consumer: target.artifact.consumer, platform: target.artifact.platform,
    arch: target.artifact.arch, format: target.artifact.format, url: target.artifact.url, sha256: target.artifact.sha256,
    members: [...target.artifact.members].sort(compareText),
  } }
}

function rejected(code: UpdateManifestRejectionCode): UpdateManifestVerification { return { kind: 'rejected', code } }

function parseManifest(input: unknown): SignedUpdateManifest | undefined {
  if (!isExactRecord(input, ['schemaVersion', 'applicationId', 'channel', 'version', 'artifacts', 'signature'])) return undefined
  if (input.schemaVersion !== 1 || !isBoundedText(input.applicationId, 256) || !isChannel(input.channel)
    || !isSemanticVersion(input.version) || !Array.isArray(input.artifacts)
    || input.artifacts.length === 0 || input.artifacts.length > 32) return undefined
  const artifacts: UpdateArtifact[] = []
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

function parseArtifact(input: unknown): UpdateArtifact | undefined {
  if (!isExactRecord(input, ['consumer', 'platform', 'arch', 'format', 'url', 'sha256', 'members'])) return undefined
  if (!isConsumer(input.consumer) || !isPlatform(input.platform) || !isArchitecture(input.arch) || !isFormat(input.format)
    || !isBoundedText(input.url, 2048) || !isBoundedText(input.sha256, 128)
    || !Array.isArray(input.members) || input.members.length === 0 || input.members.length > 4096) return undefined
  const members: string[] = []
  for (const member of input.members as unknown[]) {
    if (!isBoundedText(member, 512)) return undefined
    members.push(member)
  }
  return {
    consumer: input.consumer,
    platform: input.platform,
    arch: input.arch,
    format: input.format,
    url: input.url,
    sha256: input.sha256,
    members,
  }
}

function parseSignature(input: unknown): UpdateManifestSignature | undefined {
  if (!isExactRecord(input, ['algorithm', 'keyId', 'value']) || input.algorithm !== 'ed25519' || !isBoundedText(input.keyId, 128) || !isBoundedText(input.value, 256)) return undefined
  return { algorithm: 'ed25519', keyId: input.keyId, value: input.value }
}

function verifySignature(manifest: SignedUpdateManifest, publicKeys: Readonly<Record<string, string>>): boolean {
  const pem = publicKeys[manifest.signature.keyId]
  if (pem === undefined || !BASE64URL.test(manifest.signature.value)) return false
  let signature: Buffer
  try { signature = Buffer.from(manifest.signature.value, 'base64url') } catch { return false }
  if (signature.length !== 64) return false
  try { return verify(null, canonicalizeSignedUpdateManifest(manifest), createPublicKey(pem), signature) } catch { return false }
}

type TargetSelection = { readonly kind: 'selected'; readonly artifact: UpdateArtifact } | { readonly kind: 'none' } | { readonly kind: 'ambiguous' }

function selectTarget(
  artifacts: readonly UpdateArtifact[],
  consumer: UpdateArtifactConsumer,
  platform: NodeJS.Platform,
  arch: string,
  format: UpdateArtifactFormat,
): TargetSelection {
  if (!isPlatform(platform) || !isRuntimeArchitecture(arch) || !isFormat(format)) return { kind: 'none' }
  const matching = artifacts.filter(artifact => artifact.consumer === consumer && artifact.platform === platform
    && artifact.format === format && (artifact.arch === arch || artifact.arch === 'universal'))
  if (matching.length === 0) return { kind: 'none' }
  if (matching.length > 1) return { kind: 'ambiguous' }
  const target = matching[0]
  if (target === undefined || !formatMatchesConsumer(target.consumer, target.format, target.platform, target.arch)) return { kind: 'none' }
  return { kind: 'selected', artifact: target }
}

function isAllowedArtifactUrl(value: string, allowedOrigins: readonly string[]): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && allowedOrigins.includes(url.origin)
  } catch { return false }
}

function hasSafeArchiveMembers(members: readonly string[]): boolean {
  return new Set(members).size === members.length && members.every(isSafeArchiveMember)
}
function isSafeArchiveMember(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\u0000-\u001F\u007F]/u.test(value)) return false
  const segments = value.split('/')
  return segments.length > 0 && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}
function orderedArtifacts(artifacts: readonly UpdateArtifact[]): readonly UpdateArtifact[] {
  return [...artifacts].sort((left, right) => compareText(
    `${left.consumer}:${left.platform}:${left.arch}:${left.format}`,
    `${right.consumer}:${right.platform}:${right.arch}:${right.format}`,
  ))
}
function formatMatchesConsumer(
  consumer: UpdateArtifactConsumer,
  format: UpdateArtifactFormat,
  platform: UpdatePlatform,
  arch: UpdateArchitecture,
): boolean {
  if (consumer === 'cli') return format === 'zip' || format === 'tar.gz'
  if (platform === 'win32') return format === 'nsis'
  if (platform === 'darwin') return (format === 'dmg' || format === 'zip') && arch === 'universal'
  return arch !== 'universal' && (format === 'appimage' || format === 'deb')
}
function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return actual.length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key]
    return descriptor !== undefined && 'value' in descriptor
  })
}
function isBoundedText(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum }
function isChannel(value: unknown): value is UpdateChannel { return typeof value === 'string' && CHANNELS.includes(value as UpdateChannel) }
function isPlatform(value: unknown): value is UpdatePlatform { return typeof value === 'string' && PLATFORMS.includes(value as UpdatePlatform) }
function isArchitecture(value: unknown): value is UpdateArchitecture { return typeof value === 'string' && ARCHITECTURES.includes(value as UpdateArchitecture) }
function isConsumer(value: unknown): value is UpdateArtifactConsumer { return typeof value === 'string' && CONSUMERS.includes(value as UpdateArtifactConsumer) }
function isRuntimeArchitecture(value: unknown): value is Exclude<UpdateArchitecture, 'universal'> { return value === 'x64' || value === 'arm64' }
function isFormat(value: unknown): value is UpdateArtifactFormat { return typeof value === 'string' && FORMATS.includes(value as UpdateArtifactFormat) }
function isSemanticVersion(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && SEMANTIC_VERSION.test(value) }

interface SemanticVersion {
  readonly major: string
  readonly minor: string
  readonly patch: string
  readonly prerelease?: readonly string[]
}
function isStrictlyNewer(candidate: string, current: string): boolean {
  const parsedCandidate = parseSemanticVersion(candidate)
  const parsedCurrent = parseSemanticVersion(current)
  return parsedCandidate !== undefined && parsedCurrent !== undefined && compareSemanticVersion(parsedCandidate, parsedCurrent) > 0
}
function matchesVersionMode(candidate: string, current: string, mode: UpdateManifestPolicy['versionMode']): boolean {
  if (mode === 'current') return candidate === current && parseSemanticVersion(candidate) !== undefined
  return isStrictlyNewer(candidate, current)
}
function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = SEMANTIC_VERSION.exec(value)
  if (match === null) return undefined
  const [, major = '', minor = '', patch = '', prerelease] = match
  return { major, minor, patch, ...prerelease === undefined ? {} : { prerelease: prerelease.split('.') } }
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
  return left.length === right.length ? compareText(left, right) : left.length < right.length ? -1 : 1
}
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1 }
