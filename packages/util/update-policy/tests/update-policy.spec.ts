/** Signed update manifest policy behavior. */

import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeSignedUpdateManifest,
  EMPTY_UPDATE_TRUST,
  verifySignedUpdateManifest,
} from '@harness-desktop/dsh-update-policy'
import type {
  SignedUpdateManifest,
  UpdateArtifact,
  UpdateChannel,
  UpdateManifestPayload,
  UpdateManifestPolicy,
} from '@harness-desktop/dsh-update-policy'

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

interface GeneratedFixture {
  readonly applicationId: string
  readonly keyId: string
  readonly origin: string
}

function generatedFixture(): GeneratedFixture {
  const identifier = randomUUID().replaceAll('-', '')
  return {
    applicationId: `application-${identifier}`,
    keyId: `key-${identifier}`,
    origin: generatedOrigin(identifier),
  }
}

function generatedOrigin(identifier = randomUUID().replaceAll('-', '')): string {
  return new URL(`https://${identifier}.invalid`).origin
}

function generatedMember(): string {
  return [randomUUID(), randomUUID()].join('/')
}

function artifact(fixture: GeneratedFixture, overrides: Partial<UpdateArtifact> = {}): UpdateArtifact {
  return {
    consumer: 'desktop',
    platform: targetPlatform,
    arch: targetArtifactArchitecture,
    format: targetFormat,
    url: new URL(randomUUID(), `${fixture.origin}/`).href,
    sha256: 'a'.repeat(64),
    members: [generatedMember()],
    ...overrides,
  }
}

function policy(fixture: GeneratedFixture, overrides: Partial<UpdateManifestPolicy> = {}): UpdateManifestPolicy {
  return {
    appId: fixture.applicationId,
    currentVersion,
    channel: 'stable',
    consumer: 'desktop',
    platform: targetPlatform,
    arch: targetArchitecture,
    format: targetFormat,
    allowedOrigins: [fixture.origin],
    publicKeys: { [fixture.keyId]: publicKey },
    ...overrides,
  }
}

function manifestPayload(
  fixture: GeneratedFixture,
  channel: UpdateChannel = 'stable',
  version = '1.1.0',
  artifacts: readonly UpdateArtifact[] = [artifact(fixture)],
): UpdateManifestPayload {
  return { schemaVersion: 1, applicationId: fixture.applicationId, channel, version, artifacts }
}

function signedManifest(
  fixture: GeneratedFixture,
  channel: UpdateChannel = 'stable',
  version = '1.1.0',
  artifacts: readonly UpdateArtifact[] = [artifact(fixture)],
): SignedUpdateManifest {
  const payload = manifestPayload(fixture, channel, version, artifacts)
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: fixture.keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
}

function expectRejected(input: unknown, selectedPolicy: UpdateManifestPolicy, code: string): void {
  const result = verifySignedUpdateManifest(input, selectedPolicy)
  expect(result).toEqual({ kind: 'rejected', code })
  expect(JSON.stringify(result)).not.toContain(selectedPolicy.allowedOrigins[0])
}

describe('signed update manifest policy', () => {
  it('canonicalizes artifact and member ordering before signature verification', () => {
    const fixture = generatedFixture()
    const payload = manifestPayload(fixture, 'stable', '1.1.0', [
      artifact(fixture, { platform: 'win32', arch: 'x64', format: 'nsis', members: [generatedMember(), generatedMember()] }),
      artifact(fixture, { platform: 'darwin', arch: 'universal', format: 'dmg', members: [generatedMember(), generatedMember()] }),
    ])

    const canonical = JSON.parse(canonicalizeSignedUpdateManifest(payload).toString('utf8')) as UpdateManifestPayload
    expect(canonical.artifacts.map(candidate => candidate.platform)).toEqual(['darwin', 'win32'])
    expect(canonical.artifacts.flatMap(candidate => candidate.members)).toEqual([
      ...payload.artifacts[1]!.members.toSorted(),
      ...payload.artifacts[0]!.members.toSorted(),
    ])
  })

  it('accepts one newer signed artifact and retains its authenticated URL only for the downloader', () => {
    const fixture = generatedFixture()
    const result = verifySignedUpdateManifest(signedManifest(fixture), policy(fixture))

    expect(result).toMatchObject({ kind: 'accepted', artifact: { version: '1.1.0', channel: 'stable', sha256: 'a'.repeat(64) } })
    expect(result).toMatchObject({ kind: 'accepted', artifact: { url: expect.stringContaining(fixture.origin) as unknown } })
    expect(JSON.stringify(result)).not.toContain(fixture.keyId)
  })

  it('accepts only the exact installed version for an explicit retained rollback lookup', () => {
    const fixture = generatedFixture()

    expect(verifySignedUpdateManifest(signedManifest(fixture, 'stable', currentVersion), policy(fixture, { versionMode: 'current' })))
      .toMatchObject({ kind: 'accepted', artifact: { version: currentVersion } })
    expectRejected(signedManifest(fixture, 'stable', '1.1.0'), policy(fixture, { versionMode: 'current' }), 'version-not-newer')
  })

  it.each(['stable', 'beta', 'nightly'] as const)('accepts a valid %s manifest only for the selected channel', (channel) => {
    const fixture = generatedFixture()
    expect(verifySignedUpdateManifest(signedManifest(fixture, channel), policy(fixture, { channel }))).toMatchObject({
      kind: 'accepted', artifact: { channel },
    })
    expectRejected(signedManifest(fixture, channel), policy(fixture, { channel: channel === 'stable' ? 'beta' : 'stable' }), 'channel-mismatch')
  })

  it('accepts a universal macOS DMG for an Apple-Silicon policy target', () => {
    const fixture = generatedFixture()
    const manifest = signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, {
      platform: 'darwin', arch: 'universal', format: 'dmg',
    })])

    expect(verifySignedUpdateManifest(manifest, policy(fixture, { platform: 'darwin', arch: 'arm64', format: 'dmg' }))).toMatchObject({
      kind: 'accepted', artifact: { platform: 'darwin', arch: 'universal', format: 'dmg' },
    })
  })

  it('rejects multiple compatible macOS artifacts instead of selecting by manifest order', () => {
    const fixture = generatedFixture()
    const manifest = signedManifest(fixture, 'stable', '1.1.0', [
      artifact(fixture, { platform: 'darwin', arch: 'universal', format: 'dmg' }),
      artifact(fixture, { platform: 'darwin', arch: 'arm64', format: 'dmg' }),
    ])

    expectRejected(manifest, policy(fixture, { platform: 'darwin', arch: 'arm64', format: 'dmg' }), 'artifact-ambiguous')
  })

  it('selects the requested consumer before target ambiguity handling', () => {
    const fixture = generatedFixture()
    const desktop = artifact(fixture, { consumer: 'desktop' })
    const cliFormat = targetPlatform === 'win32' ? 'zip' : 'tar.gz'
    const cli = artifact(fixture, { consumer: 'cli', format: cliFormat })
    const manifest = signedManifest(fixture, 'stable', '1.1.0', [desktop, cli])

    expect(verifySignedUpdateManifest(manifest, policy(fixture, { consumer: 'desktop' }))).toMatchObject({
      kind: 'accepted', artifact: { consumer: 'desktop', format: targetFormat },
    })
    expect(verifySignedUpdateManifest(manifest, policy(fixture, { consumer: 'cli', format: cliFormat }))).toMatchObject({
      kind: 'accepted', artifact: { consumer: 'cli', format: cliFormat },
    })
  })

  it('ignores duplicate targets owned by another consumer', () => {
    const fixture = generatedFixture()
    const cliFormat = targetPlatform === 'win32' ? 'zip' : 'tar.gz'
    const manifest = signedManifest(fixture, 'stable', '1.1.0', [
      artifact(fixture, { consumer: 'desktop' }),
      artifact(fixture, { consumer: 'cli', format: cliFormat }),
      artifact(fixture, { consumer: 'cli', format: cliFormat }),
    ])

    expect(verifySignedUpdateManifest(manifest, policy(fixture, { consumer: 'desktop' }))).toMatchObject({
      kind: 'accepted', artifact: { consumer: 'desktop' },
    })
  })

  it('fails closed while the production trust configuration is empty', () => {
    const fixture = generatedFixture()
    expectRejected(signedManifest(fixture), { ...policy(fixture), ...EMPTY_UPDATE_TRUST }, 'unconfigured-trust-root')
  })

  it('returns malformed-manifest for non-plain records and throwing accessors', () => {
    const fixture = generatedFixture()
    class InheritedManifest { readonly marker = randomUUID() }
    expectRejected(Object.assign(new InheritedManifest(), signedManifest(fixture)), policy(fixture), 'malformed-manifest')

    const accessor = signedManifest(fixture)
    Object.defineProperty(accessor, 'schemaVersion', { enumerable: true, get() { throw new Error('untrusted accessor') } })
    expect(() => verifySignedUpdateManifest(accessor, policy(fixture))).not.toThrow()
    expectRejected(accessor, policy(fixture), 'malformed-manifest')
  })

  it.each([
    ['changed signature', (fixture: GeneratedFixture) => {
      const value = signedManifest(fixture)
      return { ...value, signature: { ...value.signature, value: `${value.signature.value}A` } }
    }, 'signature-invalid'],
    ['unknown key id', (fixture: GeneratedFixture) => {
      const value = signedManifest(fixture)
      return { ...value, signature: { ...value.signature, keyId: randomUUID() } }
    }, 'signature-invalid'],
    ['changed signed payload', (fixture: GeneratedFixture) => ({ ...signedManifest(fixture), version: '1.2.0' }), 'signature-invalid'],
    ['unknown manifest field', (fixture: GeneratedFixture) => ({ ...signedManifest(fixture), unexpected: true }), 'malformed-manifest'],
  ])('rejects %s without reflecting generated sensitive input', (_label, build, code) => {
    const fixture = generatedFixture()
    expectRejected(build(fixture), policy(fixture), code)
  })

  it('rejects a signed manifest for a different product, version, target, origin, digest, or archive member', () => {
    const fixture = generatedFixture()
    expectRejected(signPayload(fixture, { ...signedManifest(fixture), applicationId: randomUUID() }), policy(fixture), 'application-mismatch')
    expectRejected(signedManifest(fixture, 'stable', currentVersion), policy(fixture), 'version-not-newer')
    expectRejected(signedManifest(fixture, 'stable', '0.9.9'), policy(fixture), 'version-not-newer')
    expectRejected(signedManifest(fixture, 'stable', '1.1.0-01'), policy(fixture), 'malformed-manifest')
    expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, { arch: nonTargetArchitecture })]), policy(fixture), 'target-mismatch')
    expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, { url: differentProtocol(artifact(fixture).url) })]), policy(fixture), 'artifact-origin-invalid')
    expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, { url: new URL(randomUUID(), `${generatedOrigin()}/`).href })]), policy(fixture), 'artifact-origin-invalid')
    expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, { sha256: 'A'.repeat(64) })]), policy(fixture), 'digest-invalid')
    for (const members of unsafeMembers()) {
      expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture, { members })]), policy(fixture), 'archive-path-invalid')
    }
  })

  it('rejects duplicate matching target artifacts before artifact selection', () => {
    const fixture = generatedFixture()
    expectRejected(signedManifest(fixture, 'stable', '1.1.0', [artifact(fixture), artifact(fixture)]), policy(fixture), 'artifact-ambiguous')
  })
})

function signPayload(fixture: GeneratedFixture, payload: UpdateManifestPayload): SignedUpdateManifest {
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: fixture.keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
}

function differentProtocol(value: string): string {
  const url = new URL(value)
  url.protocol = 'http:'
  return url.href
}

function unsafeMembers(): readonly (readonly string[])[] {
  const segment = randomUUID()
  const separator = String.fromCharCode(47)
  const duplicate = [segment, segment].join(separator)
  return [
    [[String.fromCharCode(46, 46), segment].join(separator)],
    [[segment, randomUUID()].join(String.fromCharCode(58))],
    [[segment, randomUUID()].join(String.fromCharCode(92))],
    [[segment, String.fromCharCode(0), randomUUID()].join(separator)],
    [[segment, String.fromCharCode(1), randomUUID()].join(separator)],
    [duplicate, duplicate],
  ]
}

function currentPlatform(): UpdateArtifact['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') return process.platform
  throw new Error(`unsupported Desktop update test platform ${process.platform}`)
}

function currentArchitecture(): Exclude<UpdateArtifact['arch'], 'universal'> {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`unsupported Desktop update test architecture ${process.arch}`)
}
