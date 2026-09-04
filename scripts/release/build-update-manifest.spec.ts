import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeSignedUpdateManifest,
  verifySignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateChannel,
} from '@harness-desktop/dsh-update-policy'
import {
  buildUpdateManifests,
  inventoryUpdateArtifacts,
  writeUpdateManifests,
  type UpdateManifestBuildInput,
  type UpdateManifestInventoryInput,
} from './build-update-manifest.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface BuildFixture {
  readonly root: string
  readonly artifactPath: string
  readonly privateKeyPath: string
  readonly publicKey: string
  readonly keyId: string
  readonly origin: string
}

async function fixture(members: Readonly<Record<string, Uint8Array>> = {
  'payload/harness.txt': Buffer.from('fixture artifact'),
}): Promise<BuildFixture> {
  const root = await mkdtemp(join(tmpdir(), 'harness-update-manifest-build-'))
  roots.push(root)
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'signing-key.pem')
  const artifactPath = join(root, 'harness.zip')
  const identifier = randomUUID().replaceAll('-', '')
  await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(artifactPath, zipSync(members))
  return {
    root,
    artifactPath,
    privateKeyPath,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: `fixture-${identifier}`,
    origin: new URL(`https://${identifier}.invalid`).origin,
  }
}

function input(
  subject: BuildFixture,
  outputDirectory: string,
  channels: readonly UpdateChannel[] = ['stable', 'beta', 'nightly'],
): UpdateManifestBuildInput {
  return {
    currentVersion: '1.0.0',
    version: '1.1.0',
    keyId: subject.keyId,
    signingKeyPath: subject.privateKeyPath,
    outputDirectory,
    artifacts: channels.map(channel => ({
      channel,
      consumer: 'cli',
      platform: 'win32',
      arch: 'x64',
      format: 'zip',
      artifactPath: subject.artifactPath,
      url: new URL(`harness-${channel}.zip`, `${subject.origin}/`).href,
    })),
  }
}

function inventoryInput(
  subject: BuildFixture,
  channels: readonly UpdateChannel[] = ['stable', 'beta', 'nightly'],
): UpdateManifestInventoryInput {
  const buildInput = input(subject, join(subject.root, 'unused-output'), channels)
  return {
    currentVersion: buildInput.currentVersion,
    version: buildInput.version,
    keyId: buildInput.keyId,
    artifacts: buildInput.artifacts,
  }
}

describe('writeUpdateManifests', () => {
  it('finishes credential-free artifact inventory before loading signing material', async () => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, 'ordered-signing-output')
    const expectedInspections = input(subject, outputDirectory).artifacts.length
    let inspections = 0
    let signingKeyLoaded = false

    await writeUpdateManifests(
      input(subject, outputDirectory),
      undefined,
      undefined,
      {
        async inspectArtifact(path, format) {
          expect(signingKeyLoaded).toBe(false)
          expect(path).toBe(subject.artifactPath)
          expect(format).toBe('zip')
          inspections += 1
          return {
            bytes: await readFile(path),
            members: ['payload/harness.txt'],
          }
        },
        async readSigningKey(path) {
          expect(inspections).toBe(expectedInspections)
          signingKeyLoaded = true
          return readFile(path)
        },
      },
    )

    expect(signingKeyLoaded).toBe(true)
    expect(inspections).toBe(expectedInspections)
  })

  it('signs only validated inventory bytes after the candidate path is unavailable', async () => {
    const subject = await fixture()
    const inventory = await inventoryUpdateArtifacts(inventoryInput(subject, ['stable']))
    expect(inventory.artifacts).toHaveLength(1)
    expect(inventory.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(inventory.artifacts[0]?.members).toEqual(['payload/harness.txt'])
    expect(Object.isFrozen(inventory)).toBe(true)
    expect(Object.isFrozen(inventory.artifacts)).toBe(true)
    expect(Object.isFrozen(inventory.artifacts[0]?.members)).toBe(true)
    await rm(subject.artifactPath)

    const manifests = buildUpdateManifests(inventory, await readFile(subject.privateKeyPath))

    expect(manifests).toHaveLength(1)
    expect(manifests[0]?.manifest.artifacts[0]).toMatchObject({
      sha256: inventory.artifacts[0]?.sha256,
      members: ['payload/harness.txt'],
    })
  })

  it('writes deterministic stable, beta, and nightly manifests with one explicit artifact each', async () => {
    const subject = await fixture()
    const first = join(subject.root, 'first')
    const second = join(subject.root, 'second')

    const firstNames = await writeUpdateManifests(input(subject, first))
    const secondNames = await writeUpdateManifests(input(subject, second))

    expect(firstNames).toEqual([
      join('ready', 'stable-cli-win32-x64-zip.json'),
      join('ready', 'beta-cli-win32-x64-zip.json'),
      join('ready', 'nightly-cli-win32-x64-zip.json'),
    ])
    expect(secondNames).toEqual(firstNames)
    for (const name of firstNames) {
      const firstBytes = await readFile(join(first, name))
      expect(await readFile(join(second, name))).toEqual(firstBytes)
      const manifest = JSON.parse(firstBytes.toString('utf8')) as SignedUpdateManifest
      expect(manifest.applicationId).toBe('io.github.naipi11.harness-desktop')
      expect(manifest.artifacts).toHaveLength(1)
      expect(manifest.artifacts[0]).toMatchObject({
        consumer: 'cli', platform: 'win32', arch: 'x64', format: 'zip', members: ['payload/harness.txt'],
      })
      expect(canonicalizeSignedUpdateManifest(manifest)).toEqual(canonicalizeSignedUpdateManifest({
        schemaVersion: manifest.schemaVersion,
        applicationId: manifest.applicationId,
        channel: manifest.channel,
        version: manifest.version,
        artifacts: manifest.artifacts,
      }))
      expect(verifySignedUpdateManifest(manifest, {
        appId: 'io.github.naipi11.harness-desktop',
        currentVersion: '1.0.0',
        channel: manifest.channel,
        consumer: 'cli',
        platform: 'win32',
        arch: 'x64',
        format: 'zip',
        allowedOrigins: [subject.origin],
        publicKeys: { [subject.keyId]: subject.publicKey },
      })).toMatchObject({ kind: 'accepted' })
    }
  })

  it('rejects duplicate channel, consumer, platform, architecture, and format targets before output', async () => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, 'duplicate-output')
    const buildInput = input(subject, outputDirectory, ['stable'])

    await expect(writeUpdateManifests({
      ...buildInput,
      artifacts: [buildInput.artifacts[0]!, { ...buildInput.artifacts[0]! }],
    })).rejects.toThrow('duplicate target stable/cli/win32/x64/zip')
    await expect(access(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('emits separate manifests for two formats without choosing a preference', async () => {
    const subject = await fixture()
    const stage = join(subject.root, 'tar-stage')
    const tarPath = join(subject.root, 'harness.tar.gz')
    await mkdir(join(stage, 'payload'), { recursive: true })
    await writeFile(join(stage, 'payload', 'harness.txt'), 'fixture artifact')
    await tar.c({ cwd: stage, file: tarPath, gzip: true, portable: true }, ['payload/harness.txt'])
    const outputDirectory = join(subject.root, 'two-formats')
    const buildInput = input(subject, outputDirectory, ['stable'])

    await expect(writeUpdateManifests({
      ...buildInput,
      artifacts: [
        buildInput.artifacts[0]!,
        {
          ...buildInput.artifacts[0]!,
          format: 'tar.gz',
          artifactPath: tarPath,
          url: new URL('harness.tar.gz', `${subject.origin}/`).href,
        },
      ],
    })).resolves.toEqual([
      join('ready', 'stable-cli-win32-x64-tar-gz.json'),
      join('ready', 'stable-cli-win32-x64-zip.json'),
    ])
  })

  it.each(['missing', 'invalid'] as const)('leaves no output for %s signing input', async (kind) => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, `${kind}-key-output`)
    const signingKeyPath = join(subject.root, `${kind}-key.pem`)
    if (kind === 'invalid') await writeFile(signingKeyPath, 'not a private key')

    await expect(writeUpdateManifests({
      ...input(subject, outputDirectory, ['stable']),
      signingKeyPath,
    })).rejects.toThrow('update manifest: signing key')
    await expect(access(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves no final or staged manifest set when a staged write fails', async () => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, 'atomic-output')
    let writes = 0

    await expect(writeUpdateManifests(input(subject, outputDirectory), async (path, bytes) => {
      writes += 1
      if (writes === 2) throw new Error('injected second manifest write failure')
      await writeFile(path, bytes, { flag: 'wx' })
    })).rejects.toThrow('injected second manifest write failure')

    expect(writes).toBe(2)
    await expect(access(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects and preserves a pre-existing output directory', async () => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, 'existing-output')
    const sentinel = join(outputDirectory, 'owned.txt')
    await mkdir(outputDirectory)
    await writeFile(sentinel, 'keep existing output')

    await expect(writeUpdateManifests(input(subject, outputDirectory, ['stable']))).rejects.toThrow(
      'output directory already exists',
    )
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep existing output')
    await expect(readdir(outputDirectory)).resolves.toEqual(['owned.txt'])
  })

  it('preserves a competitor that wins atomic final-root mkdir before staging', async () => {
    const subject = await fixture()
    const outputDirectory = join(subject.root, 'reservation-race-output')
    const sentinel = join(outputDirectory, 'competitor.txt')
    let reservations = 0
    let writes = 0

    await expect(writeUpdateManifests(
      input(subject, outputDirectory, ['stable']),
      async () => {
        writes += 1
        throw new Error('staging must not start after a lost reservation')
      },
      async (path) => {
        reservations += 1
        await mkdir(path)
        await writeFile(sentinel, 'competitor owns this output')
        throw Object.assign(new Error('simulated competing atomic mkdir'), { code: 'EEXIST' })
      },
    )).rejects.toThrow('output directory already exists')

    expect(reservations).toBe(1)
    expect(writes).toBe(0)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('competitor owns this output')
    await expect(readdir(outputDirectory)).resolves.toEqual(['competitor.txt'])
  })

  it('rejects unsafe archive members before signing or output', async () => {
    const subject = await fixture({ '../escape.txt': Buffer.from('unsafe') })
    const outputDirectory = join(subject.root, 'unsafe-member-output')
    let signingKeyReads = 0

    await expect(writeUpdateManifests(
      input(subject, outputDirectory, ['stable']),
      undefined,
      undefined,
      {
        async readSigningKey() {
          signingKeyReads += 1
          throw new Error('signing key must not be read for an invalid inventory')
        },
      },
    )).rejects.toThrow('archive-path-invalid')
    expect(signingKeyReads).toBe(0)
    await expect(access(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
