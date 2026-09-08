/** Release-policy-backed update source for the packaged Desktop Main process. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  fetchAllowedUpdateBytes,
  fetchAllowedUpdateJson,
  parseReleaseUpdateConfiguration,
  releaseManifestEndpoint,
  releaseRollbackManifestEndpoint,
  type ReleaseUpdateTarget,
  type UpdateFetch,
  type UpdateTrust,
  type VerifiedUpdateArtifact,
} from '@harness-desktop/dsh-update-policy'
import type { DesktopUpdateChannel } from '@harness-desktop/dsh-host-local-runtime'

const manifestMaximumBytes = 1_048_576
const artifactMaximumBytes = 1_073_741_824
const requestTimeoutMs = 30_000
const policyFilename = 'update-policy.json'

/** Source operations that own authenticated remote Desktop update inputs. */
export interface DesktopUpdateSource {
  /** Immutable signature trust embedded beside the packaged Electron resources. */
  readonly trust: UpdateTrust
  /** Bounded health window embedded in the same release policy as signature trust. */
  readonly healthCheckTimeoutMs: number
  /** Bounded native-worker preparation window embedded in the same release policy as signature trust. */
  readonly nativeWorkerReadyTimeoutMs: number
  /** @param channel - Runtime-selected channel. @param signal - Main-owned shutdown cancellation. @returns one target manifest. */
  loadManifest(channel: DesktopUpdateChannel, signal?: AbortSignal): Promise<unknown>
  /** @param channel - Runtime channel. @param signal - Main-owned shutdown cancellation. @returns the retained installer manifest. */
  loadRollbackManifest(channel: DesktopUpdateChannel, signal?: AbortSignal): Promise<unknown>
  /** @param artifact - authenticated artifact. @param signal - Main-owned shutdown cancellation. @returns bounded installer bytes. */
  download(artifact: VerifiedUpdateArtifact, signal?: AbortSignal): Promise<Uint8Array>
}

/** Inputs for opening a release policy embedded in one packaged Desktop installation. */
export interface DesktopUpdateSourceOptions {
  /** Electron resource root that contains the immutable policy file. */
  readonly resourcesPath: string
  /** Current Desktop operating-system target. */
  readonly platform: NodeJS.Platform
  /** Current Desktop CPU target. */
  readonly arch: string
  /** Version of this installed Desktop release used to select its retained rollback manifest. */
  readonly currentVersion: string
  /** Optional fetch implementation for integration tests. */
  readonly fetch?: UpdateFetch
}

/**
 * Load the immutable public release policy installed beside Electron resources.
 * @param options - packaged resource root and exact current native target.
 * @returns a source that only fetches configured manifests and authenticated artifacts, or undefined when no policy is installed.
 * @throws when a policy is unreadable or invalid, or the native target is unsupported.
 */
export async function loadDesktopUpdateSource(options: DesktopUpdateSourceOptions): Promise<DesktopUpdateSource | undefined> {
  const target = desktopTarget(options.platform, options.arch)
  if (target === undefined) throw new Error('Desktop update target is unsupported')
  let text: string
  try {
    text = await readFile(join(options.resourcesPath, policyFilename), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const decoded = JSON.parse(text) as unknown
  const policy = parseReleaseUpdateConfiguration(decoded, productMetadata.appId)
  const sourceOptions = {
    allowedOrigins: policy.trust.allowedOrigins,
    timeoutMs: requestTimeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
  return {
    trust: policy.trust,
    healthCheckTimeoutMs: policy.healthCheckTimeoutMs,
    nativeWorkerReadyTimeoutMs: policy.nativeWorkerReadyTimeoutMs,
    loadManifest: async (channel, signal) => {
      const endpoint = releaseManifestEndpoint(policy, { ...target, channel })
      const rollbackEndpoint = releaseRollbackManifestEndpoint(policy, { ...target, channel, currentVersion: options.currentVersion })
      if (endpoint === undefined || rollbackEndpoint === undefined) throw new Error('Desktop update policy omits this target')
      return await fetchAllowedUpdateJson(endpoint, {
        ...sourceOptions, maximumBytes: manifestMaximumBytes, ...(signal === undefined ? {} : { signal }),
      })
    },
    loadRollbackManifest: async (channel, signal) => {
      const endpoint = releaseRollbackManifestEndpoint(policy, { ...target, channel, currentVersion: options.currentVersion })
      if (endpoint === undefined) throw new Error('Desktop rollback policy omits this target')
      return await fetchAllowedUpdateJson(endpoint, {
        ...sourceOptions, maximumBytes: manifestMaximumBytes, ...(signal === undefined ? {} : { signal }),
      })
    },
    download: async (artifact, signal) => await fetchAllowedUpdateBytes(artifact.url, {
      ...sourceOptions, maximumBytes: artifactMaximumBytes, ...(signal === undefined ? {} : { signal }),
    }),
  }
}

function desktopTarget(platform: NodeJS.Platform, arch: string): Omit<ReleaseUpdateTarget, 'channel'> | undefined {
  if (platform === 'win32' && arch === 'x64') {
    return { consumer: 'desktop', platform, arch, format: 'nsis' }
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return { consumer: 'desktop', platform, arch: 'universal', format: 'zip' }
  }
  if (platform === 'linux' && arch === 'x64') {
    return { consumer: 'desktop', platform, arch, format: 'appimage' }
  }
  return undefined
}
