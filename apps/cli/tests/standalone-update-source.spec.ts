/** Standalone archive release-policy source behavior. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpointKey,
  type ReleaseUpdateTarget,
  type UpdateFetch,
  type VerifiedUpdateArtifact,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { loadStandaloneUpdateSource } from '../src/standalone-update-source.ts'

const target: ReleaseUpdateTarget = {
  channel: 'stable', consumer: 'cli', platform: 'win32', arch: 'x64', format: 'zip',
}

describe('standalone release update source', () => {
  it('loads bundled public policy, then fetches only its manifest and verified artifact origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-update-policy-'))
    const keyPair = generateKeyPairSync('ed25519')
    const origin = 'https://updates.example.invalid'
    const manifestEndpoint = `${origin}/stable/cli/win32-x64.json`
    const rollbackEndpoint = `${origin}/stable/cli/win32-x64-rollback.json`
    const artifact: VerifiedUpdateArtifact = {
      version: '1.1.0', channel: 'stable', consumer: 'cli', platform: 'win32', arch: 'x64', format: 'zip',
      url: `${origin}/artifacts/harness.zip`, sha256: 'a'.repeat(64), members: ['manifest.json'],
    }
    const fetch = vi.fn<UpdateFetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url === manifestEndpoint) return new Response('{"schemaVersion":1}', { status: 200 })
      if (url === rollbackEndpoint) return new Response('{"rollback":true}', { status: 200 })
      if (url === artifact.url) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      throw new Error('unexpected update source URL')
    })
    try {
      await writeFile(join(root, 'update-policy.json'), `${JSON.stringify({
        schemaVersion: 3,
        applicationId: productMetadata.appId,
        trust: {
          allowedOrigins: [origin],
          publicKeys: { 'release-2026': keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        },
        healthCheckTimeoutMs: 120_000,
        nativeWorkerReadyTimeoutMs: 300_000,
        manifestEndpoints: { [releaseManifestEndpointKey(target)]: manifestEndpoint },
        rollbackManifestEndpoints: { [releaseRollbackManifestEndpointKey({ ...target, currentVersion: '1.0.0' })]: rollbackEndpoint },
      })}\n`)

      const source = await loadStandaloneUpdateSource({ root, target, currentVersion: '1.0.0', fetch })
      await expect(source.loadManifest()).resolves.toEqual({ schemaVersion: 1 })
      await expect(source.loadRollbackManifest()).resolves.toEqual({ rollback: true })
      await expect(source.download(artifact)).resolves.toEqual(new Uint8Array([1, 2, 3]))
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails before network I/O when the embedded policy is missing or misses the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-update-policy-'))
    const fetch = vi.fn<UpdateFetch>()
    try {
      await expect(loadStandaloneUpdateSource({ root, target, currentVersion: '1.0.0', fetch })).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not fetch a rollback manifest when this installed version has no configured endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-update-policy-'))
    const keyPair = generateKeyPairSync('ed25519')
    const origin = 'https://updates.example.invalid'
    const fetch = vi.fn<UpdateFetch>()
    try {
      await writeFile(join(root, 'update-policy.json'), `${JSON.stringify({
        schemaVersion: 3,
        applicationId: productMetadata.appId,
        trust: {
          allowedOrigins: [origin],
          publicKeys: { 'release-2026': keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        },
        healthCheckTimeoutMs: 120_000,
        nativeWorkerReadyTimeoutMs: 300_000,
        manifestEndpoints: { [releaseManifestEndpointKey(target)]: `${origin}/stable/cli/win32-x64.json` },
        rollbackManifestEndpoints: { [releaseRollbackManifestEndpointKey({ ...target, currentVersion: '1.0.0' })]: `${origin}/stable/cli/win32-x64-rollback.json` },
      })}\n`)
      await expect(loadStandaloneUpdateSource({ root, target, currentVersion: '1.0.1', fetch }))
        .rejects.toThrow('standalone update policy omits this target')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
