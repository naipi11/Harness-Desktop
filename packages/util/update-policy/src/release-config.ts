/** Static, release-embedded trust and manifest endpoint policy. */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import type {
  UpdateArchitecture,
  UpdateArtifactConsumer,
  UpdateArtifactFormat,
  UpdateChannel,
  UpdatePlatform,
  UpdateTrust,
} from './index.ts'

const CHANNELS = ['stable', 'beta', 'nightly'] as const
const PLATFORMS = ['win32', 'darwin', 'linux'] as const
const ARCHITECTURES = ['x64', 'arm64', 'universal'] as const
const CONSUMERS = ['desktop', 'cli'] as const
const FORMATS = ['nsis', 'dmg', 'appimage', 'deb', 'zip', 'tar.gz'] as const
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u
const SEMANTIC_VERSION = new RegExp([
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)',
  '(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?',
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
].join(''))

/** One exact target that receives a separately signed update manifest. */
export interface ReleaseUpdateTarget {
  /** Release channel selected by the client. */
  readonly channel: UpdateChannel
  /** Application form consuming the selected artifact. */
  readonly consumer: UpdateArtifactConsumer
  /** Operating system for the target artifact. */
  readonly platform: UpdatePlatform
  /** CPU architecture declared by the target artifact. */
  readonly arch: UpdateArchitecture
  /** Installer or archive format declared by the target artifact. */
  readonly format: UpdateArtifactFormat
}

/** One platform-specific automatic-update target for a standalone CLI archive. */
export interface StandaloneCliUpdateTarget extends ReleaseUpdateTarget {
  /** Stable release channel owned by standalone CLI updates. */
  readonly channel: 'stable'
  /** Standalone CLI archive consumer. */
  readonly consumer: 'cli'
  /** Concrete operating-system target. */
  readonly platform: UpdatePlatform
  /** Concrete CPU target. */
  readonly arch: Exclude<UpdateArchitecture, 'universal'>
  /** Windows uses ZIP; macOS and Linux preserve executable modes in tar.gz. */
  readonly format: 'zip' | 'tar.gz'
}

/** One exact installed version whose retained rollback artifact must remain available. */
export interface ReleaseRollbackTarget extends ReleaseUpdateTarget {
  /** Semantic version of the currently installed distributable. */
  readonly currentVersion: string
}

/** Parsed public release configuration embedded into one distributable. */
export interface ReleaseUpdateConfiguration {
  /** Current fixed grammar version. */
  readonly schemaVersion: 3
  /** Application identity this immutable configuration serves. */
  readonly applicationId: string
  /** Static allowlist and Ed25519 verification keys. */
  readonly trust: UpdateTrust
  /** Bounded product health window enforced by a detached rollback watchdog. */
  readonly healthCheckTimeoutMs: number
  /** Bounded detached native-worker preparation window before Main may hand off an installer transition. */
  readonly nativeWorkerReadyTimeoutMs: number
  /** Exact target key to manifest endpoint mapping. */
  readonly manifestEndpoints: Readonly<Record<string, string>>
  /** Exact target key to the installed-version rollback manifest endpoint mapping. */
  readonly rollbackManifestEndpoints: Readonly<Record<string, string>>
}

/** Stable reason a release-embedded public configuration is unusable. */
export type ReleaseUpdateConfigurationErrorCode =
  | 'release-policy-malformed'
  | 'release-policy-application-mismatch'
  | 'release-policy-trust-invalid'
  | 'release-policy-target-invalid'
  | 'release-policy-endpoint-invalid'

/** Fixed, non-reflective error for a malformed release configuration. */
export class ReleaseUpdateConfigurationError extends Error {
  /** @param code - stable reason callers may render without input details. */
  constructor(readonly code: ReleaseUpdateConfigurationErrorCode) {
    super(code)
    this.name = 'ReleaseUpdateConfigurationError'
  }
}

/**
 * Produce the only valid key for a target-specific signed-manifest endpoint.
 * @param target - exact update consumer and artifact target.
 * @returns a stable slash-separated target key.
 */
export function releaseManifestEndpointKey(target: ReleaseUpdateTarget): string {
  return [target.channel, target.consumer, target.platform, target.arch, target.format].join('/')
}

/**
 * Produce the only valid key for an installed-version rollback manifest endpoint.
 * @param target - exact update target and installed version whose stable installer must remain fetchable.
 * @returns a stable slash-separated rollback target key.
 */
export function releaseRollbackManifestEndpointKey(target: ReleaseRollbackTarget): string {
  return [...releaseManifestEndpointKey(target).split('/'), target.currentVersion].join('/')
}

/**
 * Resolve the only automatic-update archive format for one standalone CLI host.
 * @param platform - current Node platform.
 * @param arch - current Node architecture.
 * @returns the exact stable CLI target, or undefined for an unsupported host.
 */
export function standaloneCliUpdateTarget(platform: NodeJS.Platform, arch: string): StandaloneCliUpdateTarget | undefined {
  if (!isPlatform(platform) || (arch !== 'x64' && arch !== 'arm64')) return undefined
  return {
    channel: 'stable',
    consumer: 'cli',
    platform,
    arch,
    format: platform === 'win32' ? 'zip' : 'tar.gz',
  }
}

/**
 * Decode immutable public update policy packaged with an application release.
 * @param input - decoded JSON from the signed application payload.
 * @param applicationId - application identity expected by this installation.
 * @returns validated trust and exact target endpoints.
 * @throws {@link ReleaseUpdateConfigurationError} for a stable configuration failure.
 */
export function parseReleaseUpdateConfiguration(input: unknown, applicationId: string): ReleaseUpdateConfiguration {
  try {
    if (!isExactRecord(input, [
      'schemaVersion', 'applicationId', 'trust', 'healthCheckTimeoutMs', 'nativeWorkerReadyTimeoutMs', 'manifestEndpoints', 'rollbackManifestEndpoints',
    ]) || input.schemaVersion !== 3) {
      throw configurationError('release-policy-malformed')
    }
    if (typeof input.applicationId !== 'string' || input.applicationId.length === 0 || input.applicationId.length > 256) {
      throw configurationError('release-policy-malformed')
    }
    if (input.applicationId !== applicationId) throw configurationError('release-policy-application-mismatch')
    const trust = parseTrust(input.trust)
    const healthCheckTimeoutMs = parseHealthCheckTimeout(input.healthCheckTimeoutMs)
    const nativeWorkerReadyTimeoutMs = parseNativeWorkerReadyTimeout(input.nativeWorkerReadyTimeoutMs)
    const manifestEndpoints = parseManifestEndpoints(input.manifestEndpoints, trust.allowedOrigins)
    const rollbackManifestEndpoints = parseRollbackManifestEndpoints(input.rollbackManifestEndpoints, trust.allowedOrigins)
    return Object.freeze({
      schemaVersion: 3,
      applicationId,
      trust,
      healthCheckTimeoutMs,
      nativeWorkerReadyTimeoutMs,
      manifestEndpoints,
      rollbackManifestEndpoints,
    })
  } catch (error) {
    if (error instanceof ReleaseUpdateConfigurationError) throw error
    throw configurationError('release-policy-malformed')
  }
}

/**
 * Return the exact configured manifest endpoint for one target.
 * @param configuration - validated release configuration.
 * @param target - target whose manifest the caller needs.
 * @returns configured HTTPS endpoint, or undefined when this distribution does not support the target.
 */
export function releaseManifestEndpoint(
  configuration: ReleaseUpdateConfiguration,
  target: ReleaseUpdateTarget,
): string | undefined {
  return configuration.manifestEndpoints[releaseManifestEndpointKey(target)]
}

/**
 * Return the exact configured signed manifest that names the currently installed rollback artifact.
 * @param configuration - validated release configuration.
 * @param target - target whose retained compatible artifact the caller needs before an update.
 * @returns configured HTTPS endpoint, or undefined when the release cannot guarantee rollback for this target.
 */
export function releaseRollbackManifestEndpoint(
  configuration: ReleaseUpdateConfiguration,
  target: ReleaseRollbackTarget,
): string | undefined {
  return configuration.rollbackManifestEndpoints[releaseRollbackManifestEndpointKey(target)]
}

function parseTrust(input: unknown): UpdateTrust {
  if (!isExactRecord(input, ['allowedOrigins', 'publicKeys']) || !Array.isArray(input.allowedOrigins)
    || !isRecord(input.publicKeys)) {
    throw configurationError('release-policy-trust-invalid')
  }
  if (input.allowedOrigins.length === 0 || input.allowedOrigins.length > 32) throw configurationError('release-policy-trust-invalid')
  const allowedOrigins = input.allowedOrigins.map(parseOrigin)
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw configurationError('release-policy-trust-invalid')
  const publicKeys: Record<string, string> = {}
  const entries = Object.entries(input.publicKeys)
  if (entries.length === 0 || entries.length > 32) throw configurationError('release-policy-trust-invalid')
  for (const [keyId, pem] of entries) {
    if (!KEY_ID.test(keyId) || typeof pem !== 'string' || pem.length === 0 || pem.length > 16_384) {
      throw configurationError('release-policy-trust-invalid')
    }
    try {
      if (isPrivateKey(pem)) throw configurationError('release-policy-trust-invalid')
      const publicKey = createPublicKey(pem)
      if (publicKey.asymmetricKeyType !== 'ed25519') throw configurationError('release-policy-trust-invalid')
      publicKeys[keyId] = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    } catch (error) {
      if (error instanceof ReleaseUpdateConfigurationError) throw error
      throw configurationError('release-policy-trust-invalid')
    }
  }
  return Object.freeze({
    allowedOrigins: Object.freeze(allowedOrigins),
    publicKeys: Object.freeze(publicKeys),
  })
}

function isPrivateKey(pem: string): boolean {
  try {
    createPrivateKey(pem)
    return true
  } catch { return false }
}

function parseManifestEndpoints(input: unknown, allowedOrigins: readonly string[]): Readonly<Record<string, string>> {
  if (!isRecord(input)) throw configurationError('release-policy-endpoint-invalid')
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.length > 64) throw configurationError('release-policy-endpoint-invalid')
  const endpoints: Record<string, string> = {}
  for (const [key, value] of entries) {
    const target = parseTargetKey(key)
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      throw configurationError('release-policy-endpoint-invalid')
    }
    const endpoint = parseEndpoint(value, allowedOrigins)
    const expected = releaseManifestEndpointKey(target)
    if (key !== expected || Object.hasOwn(endpoints, key)) throw configurationError('release-policy-target-invalid')
    endpoints[key] = endpoint
  }
  return Object.freeze(endpoints)
}

function parseRollbackManifestEndpoints(input: unknown, allowedOrigins: readonly string[]): Readonly<Record<string, string>> {
  if (!isRecord(input)) throw configurationError('release-policy-endpoint-invalid')
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.length > 64) throw configurationError('release-policy-endpoint-invalid')
  const endpoints: Record<string, string> = {}
  for (const [key, value] of entries) {
    const target = parseRollbackTargetKey(key)
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      throw configurationError('release-policy-endpoint-invalid')
    }
    const endpoint = parseEndpoint(value, allowedOrigins)
    const expected = releaseRollbackManifestEndpointKey(target)
    if (key !== expected || Object.hasOwn(endpoints, key)) throw configurationError('release-policy-target-invalid')
    endpoints[key] = endpoint
  }
  return Object.freeze(endpoints)
}

function parseHealthCheckTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 30_000 || value > 600_000) {
    throw configurationError('release-policy-malformed')
  }
  return value
}

/** Parse an independent bounded window for copy-and-hash preparation before a native installer transition. */
function parseNativeWorkerReadyTimeout(value: unknown): number {
  return parseHealthCheckTimeout(value)
}

function parseTargetKey(key: string): ReleaseUpdateTarget {
  const fields = key.split('/')
  if (fields.length !== 5) throw configurationError('release-policy-target-invalid')
  const [channel, consumer, platform, arch, format] = fields
  if (!isChannel(channel) || !isConsumer(consumer) || !isPlatform(platform) || !isArchitecture(arch) || !isFormat(format)
    || !formatMatchesConsumer(consumer, format, platform, arch)) {
    throw configurationError('release-policy-target-invalid')
  }
  return { channel, consumer, platform, arch, format }
}

function parseRollbackTargetKey(key: string): ReleaseRollbackTarget {
  const fields = key.split('/')
  if (fields.length !== 6) throw configurationError('release-policy-target-invalid')
  const currentVersion = fields[5]
  if (currentVersion === undefined || !isSemanticVersion(currentVersion)) {
    throw configurationError('release-policy-target-invalid')
  }
  return { ...parseTargetKey(fields.slice(0, 5).join('/')), currentVersion }
}

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw configurationError('release-policy-trust-invalid')
  let url: URL
  try { url = new URL(value) } catch { throw configurationError('release-policy-trust-invalid') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '' && url.pathname !== '/')) {
    throw configurationError('release-policy-trust-invalid')
  }
  return url.origin
}

function parseEndpoint(value: string, allowedOrigins: readonly string[]): string {
  let url: URL
  try { url = new URL(value) } catch { throw configurationError('release-policy-endpoint-invalid') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || !allowedOrigins.includes(url.origin)) {
    throw configurationError('release-policy-endpoint-invalid')
  }
  return url.href
}

function configurationError(code: ReleaseUpdateConfigurationErrorCode): ReleaseUpdateConfigurationError {
  return new ReleaseUpdateConfigurationError(code)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return actual.length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key]
    return descriptor !== undefined && 'value' in descriptor
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
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

function isChannel(value: string | undefined): value is UpdateChannel {
  return value !== undefined && CHANNELS.includes(value as UpdateChannel)
}

function isConsumer(value: string | undefined): value is UpdateArtifactConsumer {
  return value !== undefined && CONSUMERS.includes(value as UpdateArtifactConsumer)
}

function isPlatform(value: string | undefined): value is UpdatePlatform {
  return value !== undefined && PLATFORMS.includes(value as UpdatePlatform)
}

function isArchitecture(value: string | undefined): value is UpdateArchitecture {
  return value !== undefined && ARCHITECTURES.includes(value as UpdateArchitecture)
}

function isFormat(value: string | undefined): value is UpdateArtifactFormat {
  return value !== undefined && FORMATS.includes(value as UpdateArtifactFormat)
}
function isSemanticVersion(value: string): boolean {
  return value.length <= 128 && SEMANTIC_VERSION.test(value)
}
