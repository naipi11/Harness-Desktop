/** Build deterministic signed update manifests from named local artifacts. */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalizeSignedUpdateManifest,
  verifySignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateArchitecture,
  type UpdateArtifactConsumer,
  type UpdateArtifactFormat,
  type UpdateChannel,
  type UpdateManifestPayload,
  type UpdatePlatform,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'
import { inspectUpdateArtifact } from './verify-update-manifests.ts'

/** One local artifact selected for exactly one channel and target format. */
export interface UpdateManifestArtifactInput {
  readonly channel: UpdateChannel
  readonly consumer: UpdateArtifactConsumer
  readonly platform: UpdatePlatform
  readonly arch: UpdateArchitecture
  readonly format: UpdateArtifactFormat
  readonly artifactPath: string
  readonly url: string
}

/** Inputs for one deterministic manifest set. */
export interface UpdateManifestBuildInput {
  readonly currentVersion: string
  readonly version: string
  readonly keyId: string
  readonly signingKeyPath: string
  readonly outputDirectory: string
  readonly artifacts: readonly UpdateManifestArtifactInput[]
}

/** One complete manifest prepared in memory before any output is created. */
export interface BuiltUpdateManifest {
  readonly filename: string
  readonly manifest: SignedUpdateManifest
  readonly bytes: Buffer
}

const channelOrder: readonly UpdateChannel[] = ['stable', 'beta', 'nightly']

/**
 * Build and sign all manifests in memory before creating output files.
 * @param input - release version, local artifacts, and caller-supplied private-key file.
 * @returns deterministic filenames, values, and UTF-8 bytes.
 */
export async function buildUpdateManifests(
  input: UpdateManifestBuildInput,
): Promise<readonly BuiltUpdateManifest[]> {
  assertUniqueTargets(input.artifacts)
  if (input.artifacts.length === 0) throw new Error('update manifest: at least one artifact is required')

  const privateKeyBytes = await readFile(input.signingKeyPath).catch((error: unknown) => {
    throw new Error('update manifest: signing key file is unavailable', { cause: error })
  })
  let privateKey: ReturnType<typeof createPrivateKey>
  try {
    privateKey = createPrivateKey(privateKeyBytes)
  } catch (error) {
    throw new Error('update manifest: signing key file is invalid', { cause: error })
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('update manifest: signing key must be Ed25519')
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()

  const ordered = [...input.artifacts].sort(compareArtifactInputs)
  const built: BuiltUpdateManifest[] = []
  for (const artifactInput of ordered) {
    const inspected = await inspectUpdateArtifact(artifactInput.artifactPath, artifactInput.format)
    const payload: UpdateManifestPayload = {
      schemaVersion: 1,
      applicationId: productMetadata.appId,
      channel: artifactInput.channel,
      version: input.version,
      artifacts: [{
        consumer: artifactInput.consumer,
        platform: artifactInput.platform,
        arch: artifactInput.arch,
        format: artifactInput.format,
        url: artifactInput.url,
        sha256: createHash('sha256').update(inspected.bytes).digest('hex'),
        members: inspected.members,
      }],
    }
    const manifest: SignedUpdateManifest = {
      ...payload,
      signature: {
        algorithm: 'ed25519',
        keyId: input.keyId,
        value: sign(null, canonicalizeSignedUpdateManifest(payload), privateKey).toString('base64url'),
      },
    }
    const allowedOrigin = artifactOrigin(artifactInput.url)
    const verification = verifySignedUpdateManifest(manifest, {
      appId: productMetadata.appId,
      currentVersion: input.currentVersion,
      channel: artifactInput.channel,
      consumer: artifactInput.consumer,
      platform: artifactInput.platform,
      arch: artifactInput.arch === 'universal' ? 'x64' : artifactInput.arch,
      allowedOrigins: [allowedOrigin],
      publicKeys: { [input.keyId]: publicKey },
    })
    if (verification.kind === 'rejected') {
      throw new Error(`update manifest: shared policy rejected ${verification.code} for ${targetKey(artifactInput)}`)
    }
    const filename = manifestFilename(artifactInput)
    built.push({ filename, manifest, bytes: Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`) })
  }
  return built
}

/**
 * Write a fully validated manifest set without creating output for invalid signing input.
 * @param input - release version, local artifacts, private-key file, and output directory.
 * @returns deterministic manifest filenames.
 */
export async function writeUpdateManifests(
  input: UpdateManifestBuildInput,
): Promise<readonly string[]> {
  const manifests = await buildUpdateManifests(input)
  await mkdir(input.outputDirectory, { recursive: true })
  for (const manifest of manifests) {
    await writeFile(join(input.outputDirectory, manifest.filename), manifest.bytes)
  }
  return manifests.map(manifest => manifest.filename)
}

function assertUniqueTargets(artifacts: readonly UpdateManifestArtifactInput[]): void {
  const seen = new Set<string>()
  for (const artifact of artifacts) {
    const key = targetKey(artifact)
    if (seen.has(key)) throw new Error(`update manifest: duplicate target ${key}`)
    seen.add(key)
  }
}

function targetKey(artifact: UpdateManifestArtifactInput): string {
  return `${artifact.channel}/${artifact.consumer}/${artifact.platform}/${artifact.arch}/${artifact.format}`
}

function manifestFilename(artifact: UpdateManifestArtifactInput): string {
  return `${artifact.channel}-${artifact.consumer}-${artifact.platform}-${artifact.arch}-${artifact.format.replace('.', '-')}.json`
}

function compareArtifactInputs(left: UpdateManifestArtifactInput, right: UpdateManifestArtifactInput): number {
  const channelDifference = channelOrder.indexOf(left.channel) - channelOrder.indexOf(right.channel)
  return channelDifference !== 0 ? channelDifference : compareText(targetKey(left), targetKey(right))
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function artifactOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch (error) {
    throw new Error('update manifest: artifact URL is invalid', { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(
  input: unknown,
  base: string,
  signingKeyPath: string,
  outputDirectory: string,
): UpdateManifestBuildInput {
  if (!isRecord(input) || typeof input.currentVersion !== 'string' || typeof input.version !== 'string'
    || typeof input.keyId !== 'string' || !Array.isArray(input.artifacts)) {
    throw new Error('update manifest builder: input must contain currentVersion, version, keyId, and artifacts')
  }
  const artifacts = input.artifacts.map((artifact, index): UpdateManifestArtifactInput => {
    if (!isRecord(artifact) || typeof artifact.channel !== 'string' || typeof artifact.consumer !== 'string'
      || typeof artifact.platform !== 'string' || typeof artifact.arch !== 'string' || typeof artifact.format !== 'string'
      || typeof artifact.artifactPath !== 'string' || typeof artifact.url !== 'string') {
      throw new Error(`update manifest builder: artifacts[${index}] is invalid`)
    }
    return {
      channel: artifact.channel as UpdateChannel,
      consumer: artifact.consumer as UpdateArtifactConsumer,
      platform: artifact.platform as UpdatePlatform,
      arch: artifact.arch as UpdateArchitecture,
      format: artifact.format as UpdateArtifactFormat,
      artifactPath: resolve(base, artifact.artifactPath),
      url: artifact.url,
    }
  })
  return {
    currentVersion: input.currentVersion,
    version: input.version,
    keyId: input.keyId,
    signingKeyPath,
    outputDirectory,
    artifacts,
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--signing-key' || args[4] !== '--output') {
    throw new Error('usage: build-update-manifest.ts --input <config.json> --signing-key <private-key.pem> --output <directory>')
  }
  const configPath = resolve(args[1] ?? '')
  const keyPath = resolve(args[3] ?? '')
  const outputDirectory = resolve(args[5] ?? '')
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  const names = await writeUpdateManifests(parseConfig(parsed, dirname(configPath), keyPath, outputDirectory))
  process.stdout.write(`${names.map(name => join(outputDirectory, name)).join('\n')}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}
