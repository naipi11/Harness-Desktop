import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpointKey,
  type ReleaseUpdateTarget,
} from '@harness-desktop/dsh-update-policy'
import { createEphemeralUpdatePolicy } from './create-ephemeral-update-policy.ts'

const origin = 'https://updates.example.invalid'
const currentVersion = '1.0.1'
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()

describe('createEphemeralUpdatePolicy', () => {
  it('serves both macOS standalone CLI architectures and the universal Desktop ZIP from either Darwin runner', () => {
    for (const runnerArch of ['arm64', 'x64']) {
      const policy = createEphemeralUpdatePolicy({
        platform: 'darwin',
        arch: runnerArch,
        currentVersion,
        publicKey,
      })
      const targets: readonly ReleaseUpdateTarget[] = [
        { channel: 'stable', consumer: 'desktop', platform: 'darwin', arch: 'universal', format: 'zip' },
        { channel: 'stable', consumer: 'cli', platform: 'darwin', arch: 'arm64', format: 'tar.gz' },
        { channel: 'stable', consumer: 'cli', platform: 'darwin', arch: 'x64', format: 'tar.gz' },
      ]

      expect(Object.keys(policy.manifestEndpoints)).toEqual(targets.map(releaseManifestEndpointKey))
      expect(Object.keys(policy.rollbackManifestEndpoints)).toEqual(
        targets.map(target => releaseRollbackManifestEndpointKey({ ...target, currentVersion })),
      )
      for (const target of targets) {
        const candidate = releaseManifestEndpointKey(target)
        const rollback = releaseRollbackManifestEndpointKey({ ...target, currentVersion })
        expect(policy.manifestEndpoints[candidate]).toBe(`${origin}/${candidate}.json`)
        expect(policy.rollbackManifestEndpoints[rollback]).toBe(`${origin}/${candidate}/rollback/${currentVersion}.json`)
      }
    }
  })
})
