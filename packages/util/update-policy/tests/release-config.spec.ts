/** Immutable public release configuration parsing. */

import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseReleaseUpdateConfiguration,
  releaseManifestEndpoint,
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpoint,
  releaseRollbackManifestEndpointKey,
  standaloneCliUpdateTarget,
  ReleaseUpdateConfigurationError,
  type ReleaseUpdateTarget,
} from '@harness-desktop/dsh-update-policy'

const keyPair = generateKeyPairSync('ed25519')
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const applicationId = 'io.github.example.harness'
const target: ReleaseUpdateTarget = {
  channel: 'stable', consumer: 'desktop', platform: 'win32', arch: 'x64', format: 'nsis',
}

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    applicationId,
    trust: {
      allowedOrigins: ['https://updates.example.invalid'],
      publicKeys: { 'release-2026': publicKey },
    },
    healthCheckTimeoutMs: 120_000,
    nativeWorkerReadyTimeoutMs: 300_000,
    manifestEndpoints: {
      [releaseManifestEndpointKey(target)]: 'https://updates.example.invalid/stable/desktop/win32-x64.json',
    },
    rollbackManifestEndpoints: {
      [releaseRollbackManifestEndpointKey({ ...target, currentVersion: '1.0.0' })]: 'https://updates.example.invalid/stable/desktop/win32-x64-rollback.json',
      [releaseRollbackManifestEndpointKey({ ...target, currentVersion: '1.0.1' })]: 'https://updates.example.invalid/stable/desktop/win32-x64-rollback-1.0.1.json',
    },
    ...overrides,
  }
}

function expectConfigurationFailure(input: unknown, code: string): void {
  try {
    parseReleaseUpdateConfiguration(input, applicationId)
    throw new Error('expected configuration parsing to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseUpdateConfigurationError)
    expect((error as ReleaseUpdateConfigurationError).code).toBe(code)
  }
}

describe('release update configuration', () => {
  it.each([
    ['win32', 'x64', { channel: 'stable', consumer: 'cli', platform: 'win32', arch: 'x64', format: 'zip' }],
    ['darwin', 'arm64', { channel: 'stable', consumer: 'cli', platform: 'darwin', arch: 'arm64', format: 'tar.gz' }],
    ['linux', 'x64', { channel: 'stable', consumer: 'cli', platform: 'linux', arch: 'x64', format: 'tar.gz' }],
    ['freebsd', 'x64', undefined],
    ['linux', 'ia32', undefined],
  ] as const)('selects the standalone CLI archive target for %s/%s', (platform, arch, expected) => {
    expect(standaloneCliUpdateTarget(platform, arch)).toEqual(expected)
  })

  it('loads immutable trust and returns only an exact target endpoint', () => {
    const parsed = parseReleaseUpdateConfiguration(configuration(), applicationId)

    expect(parsed).toMatchObject({
      schemaVersion: 3,
      applicationId,
      trust: { allowedOrigins: ['https://updates.example.invalid'], publicKeys: { 'release-2026': publicKey } },
      healthCheckTimeoutMs: 120_000,
      nativeWorkerReadyTimeoutMs: 300_000,
    })
    expect(releaseManifestEndpoint(parsed, target)).toBe('https://updates.example.invalid/stable/desktop/win32-x64.json')
    expect(releaseRollbackManifestEndpoint(parsed, { ...target, currentVersion: '1.0.0' })).toBe('https://updates.example.invalid/stable/desktop/win32-x64-rollback.json')
    expect(releaseRollbackManifestEndpoint(parsed, { ...target, currentVersion: '1.0.1' })).toBe('https://updates.example.invalid/stable/desktop/win32-x64-rollback-1.0.1.json')
    expect(releaseRollbackManifestEndpoint(parsed, { ...target, currentVersion: '1.0.2' })).toBeUndefined()
    expect(releaseManifestEndpoint(parsed, { ...target, arch: 'arm64' })).toBeUndefined()
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.trust.publicKeys)).toBe(true)
  })

  it('fails when the embedded application identity differs from the running product', () => {
    expectConfigurationFailure(configuration({ applicationId: 'io.github.other.harness' }), 'release-policy-application-mismatch')
  })

  it.each([
    ['legacy schema version', () => configuration({ schemaVersion: 2 }), 'release-policy-malformed'],
    ['top-level extra field', () => ({ ...configuration(), unexpected: true }), 'release-policy-malformed'],
    ['missing trust field', () => ({ ...configuration(), trust: { allowedOrigins: ['https://updates.example.invalid'] } }), 'release-policy-trust-invalid'],
    ['duplicate allowed origin', () => configuration({ trust: { allowedOrigins: ['https://updates.example.invalid', 'https://updates.example.invalid'], publicKeys: { key: publicKey } } }), 'release-policy-trust-invalid'],
    ['non-HTTPS allowed origin', () => configuration({ trust: { allowedOrigins: ['http://updates.example.invalid'], publicKeys: { key: publicKey } } }), 'release-policy-trust-invalid'],
    ['origin with a path', () => configuration({ trust: { allowedOrigins: ['https://updates.example.invalid/releases'], publicKeys: { key: publicKey } } }), 'release-policy-trust-invalid'],
    ['invalid public key', () => configuration({ trust: { allowedOrigins: ['https://updates.example.invalid'], publicKeys: { key: 'not a PEM' } } }), 'release-policy-trust-invalid'],
    ['private key', () => configuration({ trust: { allowedOrigins: ['https://updates.example.invalid'], publicKeys: { key: privateKey } } }), 'release-policy-trust-invalid'],
    ['too-short product health timeout', () => configuration({ healthCheckTimeoutMs: 29_999 }), 'release-policy-malformed'],
    ['non-integer product health timeout', () => configuration({ healthCheckTimeoutMs: 60_000.5 }), 'release-policy-malformed'],
    ['too-short native worker readiness timeout', () => configuration({ nativeWorkerReadyTimeoutMs: 29_999 }), 'release-policy-malformed'],
    ['non-integer native worker readiness timeout', () => configuration({ nativeWorkerReadyTimeoutMs: 60_000.5 }), 'release-policy-malformed'],
    ['endpoint from another origin', () => configuration({ manifestEndpoints: { [releaseManifestEndpointKey(target)]: 'https://other.example.invalid/stable.json' } }), 'release-policy-endpoint-invalid'],
    ['endpoint with query', () => configuration({ manifestEndpoints: { [releaseManifestEndpointKey(target)]: 'https://updates.example.invalid/stable.json?token=bad' } }), 'release-policy-endpoint-invalid'],
    ['unsupported target format', () => configuration({ manifestEndpoints: { 'stable/desktop/win32/x64/dmg': 'https://updates.example.invalid/stable.json' } }), 'release-policy-target-invalid'],
    ['unrecognized target key', () => configuration({ manifestEndpoints: { 'stable/desktop/win32/x64/nsis/extra': 'https://updates.example.invalid/stable.json' } }), 'release-policy-target-invalid'],
    ['rollback endpoint without installed version', () => configuration({ rollbackManifestEndpoints: { [releaseManifestEndpointKey(target)]: 'https://updates.example.invalid/stable.json' } }), 'release-policy-target-invalid'],
    ['rollback endpoint with malformed installed version', () => configuration({ rollbackManifestEndpoints: { 'stable/desktop/win32/x64/nsis/not-semver': 'https://updates.example.invalid/stable.json' } }), 'release-policy-target-invalid'],
    ['rollback endpoint with numeric prerelease leading zero', () => configuration({ rollbackManifestEndpoints: { 'stable/desktop/win32/x64/nsis/1.0.0-01': 'https://updates.example.invalid/stable.json' } }), 'release-policy-target-invalid'],
  ])('rejects %s without reflecting input', (_label, build, code) => {
    expectConfigurationFailure(build(), code)
  })

  it('rejects non-plain records and throwing accessors as malformed policy', () => {
    class NonPlainRecord { readonly marker = true }
    expectConfigurationFailure(Object.assign(new NonPlainRecord(), configuration()), 'release-policy-malformed')
    const input = configuration()
    Object.defineProperty(input, 'applicationId', { enumerable: true, get() { throw new Error('untrusted accessor') } })
    expectConfigurationFailure(input, 'release-policy-malformed')
  })
})
