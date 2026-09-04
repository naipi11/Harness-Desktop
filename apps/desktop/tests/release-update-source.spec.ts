/** Packaged Desktop release-policy source behavior. */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import type { UpdateFetch } from '@harness-desktop/dsh-update-policy'
import { loadDesktopUpdateSource } from '../src/main/update/release-source.ts'

const keyPair = generateKeyPairSync('ed25519')
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const origin = 'https://updates.example.invalid'
const endpoint = `${origin}/stable/desktop/win32-x64.json`
const rollbackEndpoint = `${origin}/stable/desktop/win32-x64-rollback.json`
const artifact = `${origin}/stable/harness-desktop.exe`

function response(value: string): Response {
  return new Response(value, { status: 200, headers: { 'content-length': String(Buffer.byteLength(value)) } })
}

async function fixture(): Promise<{ readonly resourcesPath: string; close(): Promise<void> }> {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'harness-desktop-update-policy-'))
  await writeFile(join(resourcesPath, 'update-policy.json'), `${JSON.stringify({
    schemaVersion: 3,
    applicationId: productMetadata.appId,
    trust: { allowedOrigins: [origin], publicKeys: { 'release-test': publicKey } },
    healthCheckTimeoutMs: 120_000,
    nativeWorkerReadyTimeoutMs: 300_000,
    manifestEndpoints: { 'stable/desktop/win32/x64/nsis': endpoint },
    rollbackManifestEndpoints: { 'stable/desktop/win32/x64/nsis/1.0.0': rollbackEndpoint },
  })}\n`)
  return { resourcesPath, close: async () => { await rm(resourcesPath, { recursive: true, force: true }) } }
}

describe('Desktop release update source', () => {
  it('uses only a packaged public policy for the exact Runtime channel and verified artifact origin', async () => {
    const subject = await fixture()
    const requests: string[] = []
    const fetch: UpdateFetch = async (location) => {
      const request = String(location)
      requests.push(request)
      if (request === endpoint) return response('{"candidate":true}')
      if (request === rollbackEndpoint) return response('{"rollback":true}')
      return response('artifact')
    }
    try {
      const source = await loadDesktopUpdateSource({ resourcesPath: subject.resourcesPath, platform: 'win32', arch: 'x64', currentVersion: '1.0.0', fetch })

      await expect(source.loadManifest('stable')).resolves.toEqual({ candidate: true })
      await expect(source.loadRollbackManifest('stable')).resolves.toEqual({ rollback: true })
      await expect(source.download({
        version: '1.1.0', channel: 'stable', consumer: 'desktop', platform: 'win32', arch: 'x64', format: 'nsis',
        sha256: 'a'.repeat(64), members: ['Harness Desktop Setup.exe'], url: artifact,
      })).resolves.toEqual(new TextEncoder().encode('artifact'))
      expect(requests).toEqual([endpoint, rollbackEndpoint, artifact])
      expect(source.trust).toEqual({ allowedOrigins: [origin], publicKeys: { 'release-test': publicKey } })
    } finally {
      await subject.close()
    }
  })

  it('rejects an unsupported runtime target before reading or fetching a packaged policy', async () => {
    const subject = await fixture()
    let calls = 0
    try {
      await expect(loadDesktopUpdateSource({
        resourcesPath: subject.resourcesPath,
        platform: 'win32',
        arch: 'arm64',
        currentVersion: '1.0.0',
        fetch: async () => { calls += 1; return response('{}') },
      })).rejects.toThrow('Desktop update target is unsupported')
      expect(calls).toBe(0)
    } finally {
      await subject.close()
    }
  })

  it('does not fetch a rollback manifest when this installed version has no configured endpoint', async () => {
    const subject = await fixture()
    let calls = 0
    try {
      const source = await loadDesktopUpdateSource({
        resourcesPath: subject.resourcesPath,
        platform: 'win32',
        arch: 'x64',
        currentVersion: '1.0.1',
        fetch: async () => { calls += 1; return response('{}') },
      })

      await expect(source.loadManifest('stable')).rejects.toThrow('update policy omits this target')
      expect(calls).toBe(0)
    } finally {
      await subject.close()
    }
  })
})
