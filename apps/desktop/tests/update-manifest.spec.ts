/** Desktop Main-process update manifest verification. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  canonicalizeDesktopUpdateManifest,
  PRODUCTION_DESKTOP_UPDATE_TRUST,
  verifyDesktopUpdateManifest,
} from '../src/main/update/manifest.ts'
import type {
  DesktopUpdateArtifact,
  DesktopUpdateManifestPayload,
  DesktopUpdateManifestPolicy,
  SignedDesktopUpdateManifest,
} from '../src/main/update/manifest.ts'
import type { DesktopUpdateChannel } from '@harness-desktop/dsh-host-local-runtime'

const keyPair = generateKeyPairSync('ed25519')
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const currentVersion = '1.0.0'
const targetPlatform = currentPlatform()
const targetArchitecture = currentArchitecture()
const nonTargetArchitecture = targetArchitecture === 'x64' ? 'arm64' : 'x64'
const targetArtifactArchitecture = targetPlatform === 'darwin' ? 'universal' : targetArchitecture
const targetFormat = targetPlatform === 'win32'
  ? 'nsis'
  : targetPlatform === 'darwin'
    ? 'dmg'
    : 'appimage'

function artifact(overrides: Partial<DesktopUpdateArtifact> = {}): DesktopUpdateArtifact {
  return {
    platform: targetPlatform,
    arch: targetArtifactArchitecture,
    format: targetFormat,
    url: 'https://updates.example.test/harness-desktop-update',
    sha256: 'a'.repeat(64),
    members: ['payload/harness-desktop'],
    ...overrides,
  }
}

function policy(overrides: Partial<DesktopUpdateManifestPolicy> = {}): DesktopUpdateManifestPolicy {
  return {
    appId: productMetadata.appId,
    currentVersion,
    channel: 'stable',
    platform: targetPlatform,
    arch: targetArchitecture,
    allowedOrigins: ['https://updates.example.test'],
    publicKeys: { 'test-key': publicKey },
    ...overrides,
  }
}

function signedManifest(
  channel: DesktopUpdateChannel = 'stable',
  version = '1.1.0',
  artifacts: readonly DesktopUpdateArtifact[] = [artifact()],
): SignedDesktopUpdateManifest {
  const payload: DesktopUpdateManifestPayload = {
    schemaVersion: 1,
    applicationId: productMetadata.appId,
    channel,
    version,
    artifacts,
  }
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: 'test-key',
      value: sign(null, canonicalizeDesktopUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
}

function expectRejected(input: unknown, policyInput: DesktopUpdateManifestPolicy, code: string): void {
  const result = verifyDesktopUpdateManifest(input, policyInput)
  expect(result).toEqual({ kind: 'rejected', code })
  expect(JSON.stringify(result)).not.toMatch(/updates\.example|test-key|payload\/harness/u)
}

describe('Desktop update manifest policy', () => {
  it('canonicalizes artifact and member ordering before signature verification', () => {
    const payload: DesktopUpdateManifestPayload = {
      schemaVersion: 1,
      applicationId: productMetadata.appId,
      channel: 'stable',
      version: '1.1.0',
      artifacts: [
        artifact({
          platform: 'win32', arch: 'x64', format: 'nsis', url: 'https://updates.example.test/windows',
          sha256: 'b'.repeat(64), members: ['payload/z', 'payload/a'],
        }),
        artifact({
          platform: 'darwin', arch: 'universal', format: 'dmg', url: 'https://updates.example.test/macos',
          sha256: 'c'.repeat(64), members: ['Harness Desktop.app/z', 'Harness Desktop.app/a'],
        }),
      ],
    }

    expect(canonicalizeDesktopUpdateManifest(payload).toString('utf8')).toBe(JSON.stringify({
      schemaVersion: 1,
      applicationId: productMetadata.appId,
      channel: 'stable',
      version: '1.1.0',
      artifacts: [
        {
          platform: 'darwin', arch: 'universal', format: 'dmg', url: 'https://updates.example.test/macos',
          sha256: 'c'.repeat(64), members: ['Harness Desktop.app/a', 'Harness Desktop.app/z'],
        },
        {
          platform: 'win32', arch: 'x64', format: 'nsis', url: 'https://updates.example.test/windows',
          sha256: 'b'.repeat(64), members: ['payload/a', 'payload/z'],
        },
      ],
    }))
  })

  it('accepts one newer signed artifact without exposing its URL or signature', () => {
    const result = verifyDesktopUpdateManifest(signedManifest(), policy())

    expect(result).toEqual({
      kind: 'accepted',
      artifact: {
        version: '1.1.0',
        channel: 'stable',
        platform: targetPlatform,
        arch: targetArtifactArchitecture,
        format: targetFormat,
        sha256: 'a'.repeat(64),
        members: ['payload/harness-desktop'],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/updates\.example|test-key|ed25519/u)
  })

  it.each(['stable', 'beta', 'nightly'] as const)('accepts a valid %s manifest only for the selected channel', (channel) => {
    expect(verifyDesktopUpdateManifest(signedManifest(channel), policy({ channel }))).toMatchObject({
      kind: 'accepted', artifact: { channel },
    })
    const other = channel === 'stable' ? 'beta' : 'stable'
    expectRejected(signedManifest(channel), policy({ channel: other }), 'channel-mismatch')
  })

  it('accepts a universal macOS DMG for an Apple-Silicon policy target', () => {
    const manifest = signedManifest('stable', '1.1.0', [artifact({
      platform: 'darwin', arch: 'universal', format: 'dmg', members: ['Harness Desktop.app/Contents/MacOS/harness-desktop'],
    })])

    expect(verifyDesktopUpdateManifest(manifest, policy({ platform: 'darwin', arch: 'arm64' }))).toMatchObject({
      kind: 'accepted', artifact: { platform: 'darwin', arch: 'universal', format: 'dmg' },
    })
  })

  it('rejects multiple compatible macOS artifacts instead of selecting by manifest order', () => {
    const manifest = signedManifest('stable', '1.1.0', [
      artifact({ platform: 'darwin', arch: 'universal', format: 'dmg' }),
      artifact({ platform: 'darwin', arch: 'arm64', format: 'dmg' }),
    ])

    expectRejected(manifest, policy({ platform: 'darwin', arch: 'arm64' }), 'artifact-ambiguous')
  })

  it('fails closed while the production trust configuration is empty', () => {
    expectRejected(signedManifest(), { ...policy(), ...PRODUCTION_DESKTOP_UPDATE_TRUST }, 'unconfigured-trust-root')
  })

  it('returns malformed-manifest for non-plain records and throwing accessors', () => {
    class InheritedManifest {
      readonly marker = 'non-plain'
    }
    const inherited = Object.assign(new InheritedManifest(), signedManifest())
    expectRejected(inherited, policy(), 'malformed-manifest')

    const accessor = signedManifest()
    Object.defineProperty(accessor, 'schemaVersion', {
      enumerable: true,
      get() { throw new Error('untrusted accessor') },
    })
    expect(() => verifyDesktopUpdateManifest(accessor, policy())).not.toThrow()
    expectRejected(accessor, policy(), 'malformed-manifest')
  })

  it.each([
    ['changed signature', () => {
      const value = signedManifest()
      return { ...value, signature: { ...value.signature, value: `${value.signature.value}A` } }
    }, policy(), 'signature-invalid'],
    ['unknown key id', () => {
      const value = signedManifest()
      return { ...value, signature: { ...value.signature, keyId: 'unknown-key' } }
    }, policy(), 'signature-invalid'],
    ['changed signed payload', () => ({ ...signedManifest(), version: '1.2.0' }), policy(), 'signature-invalid'],
    ['unknown manifest field', () => ({ ...signedManifest(), unexpected: true }), policy(), 'malformed-manifest'],
  ])('rejects %s without reflecting sensitive input', (_label, build, selectedPolicy, code) => {
    const input = build()
    expectRejected(input, selectedPolicy, code)
  })

  it('rejects a signed manifest for a different product, version, target, origin, digest, or archive member', () => {
    const product = signedManifest()
    const wrongProduct: DesktopUpdateManifestPayload = { ...product, applicationId: 'io.example.other' }
    expectRejected(signPayload(wrongProduct), policy(), 'application-mismatch')
    expectRejected(signedManifest('stable', currentVersion), policy(), 'version-not-newer')
    expectRejected(signedManifest('stable', '0.9.9'), policy(), 'version-not-newer')
    expectRejected(signedManifest('stable', '1.1.0-01'), policy(), 'malformed-manifest')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ arch: nonTargetArchitecture })]), policy(), 'target-mismatch')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ url: 'http://updates.example.test/a' })]), policy(), 'artifact-origin-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ url: 'https://other.example.test/a' })]), policy(), 'artifact-origin-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ sha256: 'A'.repeat(64) })]), policy(), 'digest-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['../escape'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['C:/escape'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['payload\\escape'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['payload/a:alternate-stream'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['payload/\u0000nul'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['payload/\u0001control'] })]), policy(), 'archive-path-invalid')
    expectRejected(signedManifest('stable', '1.1.0', [artifact({ members: ['payload/a', 'payload/a'] })]), policy(), 'archive-path-invalid')
  })

  it('rejects duplicate matching target artifacts before artifact selection', () => {
    expectRejected(signedManifest('stable', '1.1.0', [artifact(), artifact()]), policy(), 'artifact-ambiguous')
  })
})

function signPayload(payload: DesktopUpdateManifestPayload): SignedDesktopUpdateManifest {
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: 'test-key',
      value: sign(null, canonicalizeDesktopUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
}

function currentPlatform(): DesktopUpdateArtifact['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform
  }
  throw new Error(`unsupported Desktop update test platform ${process.platform}`)
}

function currentArchitecture(): Exclude<DesktopUpdateArtifact['arch'], 'universal'> {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`unsupported Desktop update test architecture ${process.arch}`)
}
