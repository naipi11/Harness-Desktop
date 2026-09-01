/** Release-policy-backed update source for a standalone CLI bundle. */

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

const manifestMaximumBytes = 1_048_576
const artifactMaximumBytes = 1_073_741_824
const requestTimeoutMs = 30_000
const policyFilename = 'update-policy.json'

/** Source operations used after a static standalone release policy has loaded. */
export interface StandaloneUpdateSource {
  /** Immutable signature trust embedded in the standalone archive. */
  readonly trust: UpdateTrust
  /** Bounded product health window embedded in the same release policy as signature trust. */
  readonly healthCheckTimeoutMs: number
  /** @returns decoded untrusted manifest from the exact configured endpoint. */
  loadManifest(): Promise<unknown>
  /** @returns decoded signed manifest for the currently installed rollback artifact. */
  loadRollbackManifest(): Promise<unknown>
  /** @param artifact - manifest-authenticated artifact location. @returns bounded downloaded archive bytes. */
  download(artifact: VerifiedUpdateArtifact): Promise<Uint8Array>
}

/** Inputs for reading one standalone release policy and its remote manifest. */
export interface StandaloneUpdateSourceOptions {
  /** Root of the resolved standalone archive installation. */
  readonly root: string
  /** Exact stable CLI target for this invocation. */
  readonly target: ReleaseUpdateTarget
  /** Version of the installed standalone archive used to select its retained rollback manifest. */
  readonly currentVersion: string
  /** Optional fetch implementation for integration tests. */
  readonly fetch?: UpdateFetch
}

/**
 * Load the immutable release policy placed at a standalone bundle root.
 * @param options - resolved bundle root and exact runtime target.
 * @returns a source that fetches only policy-authorized manifests and artifacts.
 * @throws when the policy is absent, malformed, targetless, or cannot be read.
 */
export async function loadStandaloneUpdateSource(options: StandaloneUpdateSourceOptions): Promise<StandaloneUpdateSource> {
  const decoded = JSON.parse(await readFile(join(options.root, policyFilename), 'utf8')) as unknown
  const policy = parseReleaseUpdateConfiguration(decoded, productMetadata.appId)
  const endpoint = releaseManifestEndpoint(policy, options.target)
  const rollbackEndpoint = releaseRollbackManifestEndpoint(policy, { ...options.target, currentVersion: options.currentVersion })
  if (endpoint === undefined || rollbackEndpoint === undefined) throw new Error('standalone update policy omits this target')
  const sourceOptions = {
    allowedOrigins: policy.trust.allowedOrigins,
    timeoutMs: requestTimeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
  return {
    trust: policy.trust,
    healthCheckTimeoutMs: policy.healthCheckTimeoutMs,
    loadManifest: async () => await fetchAllowedUpdateJson(endpoint, { ...sourceOptions, maximumBytes: manifestMaximumBytes }),
    loadRollbackManifest: async () => await fetchAllowedUpdateJson(rollbackEndpoint, {
      ...sourceOptions,
      maximumBytes: manifestMaximumBytes,
    }),
    download: async artifact => await fetchAllowedUpdateBytes(artifact.url, { ...sourceOptions, maximumBytes: artifactMaximumBytes }),
  }
}
