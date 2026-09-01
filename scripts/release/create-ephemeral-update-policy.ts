/** Create a CI-only public update policy for non-publishing artifact verification. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  parseReleaseUpdateConfiguration,
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpointKey,
  standaloneCliUpdateTarget,
  type ReleaseUpdateConfiguration,
  type ReleaseUpdateTarget,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'
import rootPackage from '../../package.json' with { type: 'json' }

const origin = 'https://updates.example.invalid'

/** Inputs required to generate one CI-only immutable public update policy. */
export interface EphemeralUpdatePolicyInput {
  /** Host platform whose release-artifact row is running. */
  readonly platform: NodeJS.Platform
  /** Host architecture whose release-artifact row is running. */
  readonly arch: string
  /** Installed application version whose rollback artifact must remain available. */
  readonly currentVersion: string
  /** Ephemeral Ed25519 public key trusted by the policy. */
  readonly publicKey: string
}

/**
 * Create the public update policy used only by one non-publishing CI artifact row.
 * @param input - runner, installed-version, and ephemeral-trust inputs.
 * @returns validated immutable policy for all artifacts produced by the row.
 */
export function createEphemeralUpdatePolicy(input: EphemeralUpdatePolicyInput): ReleaseUpdateConfiguration {
  const targets = ephemeralUpdateTargets(input.platform, input.arch)
  const manifestEndpoints = Object.fromEntries(targets.map(target => [
    releaseManifestEndpointKey(target), `${origin}/${releaseManifestEndpointKey(target)}.json`,
  ]))
  const rollbackManifestEndpoints = Object.fromEntries(targets.map(target => [
    releaseRollbackManifestEndpointKey({ ...target, currentVersion: input.currentVersion }),
    `${origin}/${releaseManifestEndpointKey(target)}/rollback/${input.currentVersion}.json`,
  ]))
  return parseReleaseUpdateConfiguration({
    schemaVersion: 3,
    applicationId: productMetadata.appId,
    trust: { allowedOrigins: [origin], publicKeys: { 'ci-ephemeral': input.publicKey } },
    healthCheckTimeoutMs: 120_000,
    nativeWorkerReadyTimeoutMs: 300_000,
    manifestEndpoints,
    rollbackManifestEndpoints,
  }, productMetadata.appId)
}

function ephemeralUpdateTargets(platform: NodeJS.Platform, arch: string): readonly ReleaseUpdateTarget[] {
  return [desktopTarget(platform, arch), ...cliTargets(platform, arch)]
}

function desktopTarget(platform: NodeJS.Platform, arch: string): ReleaseUpdateTarget {
  if (platform === 'win32' && arch === 'x64') {
    return { channel: 'stable', consumer: 'desktop', platform: 'win32', arch: 'x64', format: 'nsis' }
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return { channel: 'stable', consumer: 'desktop', platform: 'darwin', arch: 'universal', format: 'zip' }
  }
  if (platform === 'linux' && arch === 'x64') {
    return { channel: 'stable', consumer: 'desktop', platform: 'linux', arch: 'x64', format: 'appimage' }
  }
  throw new Error(`release: unsupported Desktop CI update policy target ${platform}/${arch}`)
}

function cliTargets(platform: NodeJS.Platform, arch: string): readonly ReleaseUpdateTarget[] {
  if (platform === 'darwin') {
    return ['arm64', 'x64'].map((targetArch) => {
      const target = standaloneCliUpdateTarget(platform, targetArch)
      if (target === undefined) throw new Error(`release: unsupported standalone CLI CI update policy target ${platform}/${targetArch}`)
      return target
    })
  }
  const target = standaloneCliUpdateTarget(platform, arch)
  if (target === undefined) {
    throw new Error(`release: unsupported standalone CLI CI update policy target ${platform}/${arch}`)
  }
  return [target]
}

async function main(): Promise<void> {
  const output = resolve(process.env.DSH_UPDATE_POLICY_OUTPUT ?? 'dist/release-input/update-policy.json')
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const policy = createEphemeralUpdatePolicy({
    platform: process.platform,
    arch: process.arch,
    currentVersion: rootPackage.version,
    publicKey,
  })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(policy)}\n`, { mode: 0o600 })
  process.stdout.write(`release: wrote CI-only public update policy to ${output}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
