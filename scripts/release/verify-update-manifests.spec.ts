import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeSignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateManifestPayload,
} from '@harness-desktop/dsh-update-policy'
import { writeUpdateManifests } from './build-update-manifest.ts'
import { verifyUpdateManifests, type UpdateManifestVerificationInput } from './verify-update-manifests.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface VerificationFixture {
  readonly input: UpdateManifestVerificationInput
  readonly artifactPath: string
  readonly manifestPath: string
  readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
}

async function fixture(format: 'zip' | 'tar.gz' = 'zip'): Promise<VerificationFixture> {
  const root = await mkdtemp(join(tmpdir(), 'harness-update-manifest-verify-'))
  roots.push(root)
  const pair = generateKeyPairSync('ed25519')
  const identifier = randomUUID().replaceAll('-', '')
  const keyId = `fixture-${identifier}`
  const privateKeyPath = join(root, 'private.pem')
  const publicKeyPath = join(root, 'public.pem')
  const artifactPath = join(root, `harness.${format}`)
  const outputDirectory = join(root, 'manifests')
  const origin = new URL(`https://${identifier}.invalid`).origin
  await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }))
  if (format === 'zip') {
    await writeFile(artifactPath, zipSync({ 'payload/harness.txt': Buffer.from('fixture artifact') }))
  } else {
    const stage = join(root, 'tar-stage')
    await mkdir(join(stage, 'payload'), { recursive: true })
    await writeFile(join(stage, 'payload', 'harness.txt'), 'fixture artifact')
    await tar.c({ cwd: stage, file: artifactPath, gzip: true, portable: true }, ['payload/harness.txt'])
  }
  const [name] = await writeUpdateManifests({
    currentVersion: '1.0.0',
    version: '1.1.0',
    keyId,
    signingKeyPath: privateKeyPath,
    outputDirectory,
    artifacts: [{
      channel: 'stable', consumer: 'cli', platform: 'win32', arch: 'x64', format, artifactPath,
      url: new URL(`harness.${format}`, `${origin}/`).href,
    }],
  })
  if (name === undefined) throw new Error('fixture manifest was not built')
  const manifestPath = join(outputDirectory, name)
  return {
    artifactPath,
    manifestPath,
    privateKey: pair.privateKey,
    input: {
      currentVersion: '1.0.0',
      keyId,
      verificationKeyPath: publicKeyPath,
      manifests: [{
        manifestPath,
        artifactPath,
        channel: 'stable',
        consumer: 'cli',
        platform: 'win32',
        arch: 'x64',
        format,
        allowedOrigins: [origin],
      }],
    },
  }
}

async function readManifest(path: string): Promise<SignedUpdateManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as SignedUpdateManifest
}

async function writeSignedManifest(
  subject: VerificationFixture,
  payload: UpdateManifestPayload,
): Promise<void> {
  const original = await readManifest(subject.manifestPath)
  const manifest: SignedUpdateManifest = {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: original.signature.keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), subject.privateKey).toString('base64url'),
    },
  }
  await writeFile(subject.manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

describe('verifyUpdateManifests', () => {
  it('verifies a signed manifest against its named local artifact and caller-supplied public key', async () => {
    const subject = await fixture()
    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([])
  })

  it('verifies portable tar members without extracting the artifact', async () => {
    const subject = await fixture('tar.gz')
    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([])
  })

  it('rejects a bad signature through the shared signed-manifest parser', async () => {
    const subject = await fixture()
    const manifest = await readManifest(subject.manifestPath)
    const first = manifest.signature.value[0] === 'A' ? 'B' : 'A'
    await writeFile(subject.manifestPath, `${JSON.stringify({
      ...manifest,
      signature: { ...manifest.signature, value: `${first}${manifest.signature.value.slice(1)}` },
    }, undefined, 2)}\n`)

    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([
      expect.stringContaining('signature-invalid'),
    ])
  })

  it('rejects artifact bytes whose digest differs from the signed digest', async () => {
    const subject = await fixture()
    await writeFile(subject.artifactPath, zipSync({ 'payload/harness.txt': Buffer.from('changed artifact') }))

    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([
      expect.stringContaining('digest does not match'),
    ])
  })

  it('rejects actual archive members that differ from the signed member set', async () => {
    const subject = await fixture()
    const manifest = await readManifest(subject.manifestPath)
    await writeSignedManifest(subject, {
      schemaVersion: manifest.schemaVersion,
      applicationId: manifest.applicationId,
      channel: manifest.channel,
      version: manifest.version,
      artifacts: [{ ...manifest.artifacts[0]!, members: ['payload/other.txt'] }],
    })

    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([
      expect.stringContaining('members do not match'),
    ])
  })

  it('rejects a signed unsafe member before comparing the archive', async () => {
    const subject = await fixture()
    const manifest = await readManifest(subject.manifestPath)
    await writeSignedManifest(subject, {
      schemaVersion: manifest.schemaVersion,
      applicationId: manifest.applicationId,
      channel: manifest.channel,
      version: manifest.version,
      artifacts: [{ ...manifest.artifacts[0]!, members: ['../escape.txt'] }],
    })

    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([
      expect.stringContaining('archive-path-invalid'),
    ])
  })

  it('rejects a signed manifest containing any artifact beyond the exact expected target', async () => {
    const subject = await fixture()
    const manifest = await readManifest(subject.manifestPath)
    await writeSignedManifest(subject, {
      schemaVersion: manifest.schemaVersion,
      applicationId: manifest.applicationId,
      channel: manifest.channel,
      version: manifest.version,
      artifacts: [
        manifest.artifacts[0]!,
        {
          consumer: 'desktop',
          platform: 'linux',
          arch: 'x64',
          format: 'appimage',
          url: 'http://untrusted.invalid/extra.AppImage',
          sha256: 'not-a-digest',
          members: ['../escape.txt'],
        },
      ],
    })

    await expect(verifyUpdateManifests(subject.input)).resolves.toEqual([
      expect.stringContaining('must contain exactly one expected target artifact'),
    ])
  })

  it('rejects a digest mismatch before artifact inspection or execution', async () => {
    const subject = await fixture()
    const manifest = await readManifest(subject.manifestPath)
    const original = manifest.artifacts[0]!
    await writeSignedManifest(subject, {
      schemaVersion: manifest.schemaVersion,
      applicationId: manifest.applicationId,
      channel: manifest.channel,
      version: manifest.version,
      artifacts: [{
        ...original,
        consumer: 'desktop',
        platform: 'linux',
        arch: 'x64',
        format: 'appimage',
        sha256: '0'.repeat(64),
      }],
    })
    const target = subject.input.manifests[0]!
    let inspections = 0

    await expect(verifyUpdateManifests({
      ...subject.input,
      manifests: [{
        ...target,
        consumer: 'desktop',
        platform: 'linux',
        arch: 'x64',
        format: 'appimage',
      }],
    }, async () => {
      inspections += 1
      throw new Error('inspection or execution was reached')
    })).resolves.toEqual([
      expect.stringContaining('digest does not match'),
    ])
    expect(inspections).toBe(0)
  })

  it('inspects an immutable snapshot even when the caller path changes', async () => {
    const subject = await fixture()
    let inspections = 0

    await expect(verifyUpdateManifests(subject.input, async (snapshot, format) => {
      inspections += 1
      await writeFile(subject.artifactPath, zipSync({ 'payload/replaced.txt': Buffer.from('replacement') }))
      expect(format).toBe('zip')
      return Object.keys(unzipSync(snapshot)).filter(path => !path.endsWith('/'))
    })).resolves.toEqual([])
    expect(inspections).toBe(1)
  })

  it('rejects a candidate that cannot update from the declared rollback version', async () => {
    const subject = await fixture()

    await expect(verifyUpdateManifests({ ...subject.input, currentVersion: '1.1.0' })).resolves.toEqual([
      expect.stringContaining('version-not-newer'),
    ])
  })

  it('rejects duplicate expected target rules before reading manifests', async () => {
    const subject = await fixture()
    const target = subject.input.manifests[0]!

    await expect(verifyUpdateManifests({
      ...subject.input,
      manifests: [target, { ...target }],
    })).resolves.toEqual([
      expect.stringContaining('duplicate target stable/cli/win32/x64/zip'),
    ])
  })
})
