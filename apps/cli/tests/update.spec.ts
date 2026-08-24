/** CLI update command parsing and isolated update transaction behavior. */

import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import * as tar from 'tar'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  canonicalizeSignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateManifestPayload,
  type UpdateTrust,
} from '@harness-desktop/dsh-update-policy'
import { parseProductArgs, ProductArgumentError } from '../src/args.ts'
import { runUpdateInvocation, type UpdateFileOperations, type UpdateInvocationResult } from '../src/update.ts'

interface StandaloneFixture {
  readonly entryPath: string
  readonly expectedLiveVersion: string
  readonly manifest: SignedUpdateManifest
  readonly trust: UpdateTrust
  readonly bytes: Uint8Array
  readonly root: string
  readonly privateKey: KeyObject
  close(): Promise<void>
}

describe('CLI update', () => {
  it('parses update without creating a task or Web lease', () => {
    expect(parseProductArgs(['update'], 'harness', '1.0.0')).toEqual({ mode: 'update' })
    expect(() => parseProductArgs(['update', 'extra'], 'harness', '1.0.0')).toThrow(ProductArgumentError)
  })

  it('prints the exact package-manager command without loading or mutating an npm installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-npm-layout-'))
    let stdout = ''
    const calls: string[] = []
    const entryPath = join(root, 'node_modules', '@harness-desktop', 'cli', 'lib', 'update.js')
    try {
      await mkdir(dirname(entryPath), { recursive: true })
      await writeFile(entryPath, '')
      const result = await runUpdateInvocation({
        entryPath,
        version: '1.0.0',
        stdout: { write(chunk: string): boolean { stdout += chunk; return true } },
        loadCandidate: async () => { calls.push('load'); throw new Error('npm update must not load an archive') },
        operations: forbiddenOperations(calls),
      })

      expect(result).toEqual({ kind: 'managed-by-npm' })
      expect(stdout).toBe('npm update -g @harness-desktop/cli\n')
      expect(calls).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for a resolved source layout instead of claiming npm ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-source-layout-'))
    let stdout = ''
    try {
      const result = await runUpdateInvocation({
        entryPath: join(root, 'lib', 'update.js'),
        version: '1.0.0',
        stdout: { write(chunk: string): boolean { stdout += chunk; return true } },
      })

      expect(result).toEqual({ kind: 'failed', code: 'unsupported-installation' })
      expect(stdout).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a standalone installation untouched while production trust is empty', async () => {
    const fixture = await standaloneFixture('healthy')
    try {
      const before = await readFile(join(fixture.root, 'version'), 'utf8')
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        loadCandidate: async () => { throw new Error('empty trust must not load a candidate') },
      })

      expect(result).toEqual({ kind: 'up-to-date', code: 'unconfigured-trust-root' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe(before)
    } finally {
      await fixture.close()
    }
  })

  it('verifies a supplied standalone archive then switches it using bundled Node only', async () => {
    const fixture = await standaloneFixture('healthy')
    try {
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => ({ manifest: fixture.manifest, bytes: fixture.bytes }),
      })

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe('1.1.0')
      await expect(retainedVersions(fixture.root)).resolves.toEqual([])
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it('restores the retained standalone installation when the bundled health check fails', async () => {
    const fixture = await standaloneFixture('unhealthy')
    try {
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => ({ manifest: fixture.manifest, bytes: fixture.bytes }),
      })

      expect(result).toEqual({ kind: 'rolled-back', version: '1.1.0' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe(fixture.expectedLiveVersion)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it('applies consecutive standalone updates without retaining stale transaction roots', async () => {
    const fixture = await standaloneFixture('healthy')
    try {
      await expect(update(fixture, '1.0.0', '1.1.0')).resolves.toEqual({ kind: 'applied', version: '1.1.0' })
      await expect(update(fixture, '1.1.0', '1.2.0')).resolves.toEqual({ kind: 'applied', version: '1.2.0' })
      await expect(retainedVersions(fixture.root)).resolves.toEqual([])
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it.each([3, 4])('keeps a live standalone root when rollback rename %i fails', async (failureCall) => {
    const fixture = await standaloneFixture('unhealthy')
    let renames = 0
    const harnessHome = process.env.HARNESS_HOME
    try {
      const result = await update(fixture, '1.0.0', '1.1.0', {
        rename: async (from, to) => {
          renames += 1
          if (renames === failureCall) throw new Error('fixture rollback rename failure')
          await rename(from, to)
        },
      })

      expect(result).toEqual({ kind: 'failed', code: 'transaction-failed' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe('1.1.0')
      await expect(retainedVersions(fixture.root)).resolves.toEqual(['1.0.0'])
      expect(process.env.HARNESS_HOME).toBe(harnessHome)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it('restores declared Unix ZIP executable paths before the candidate health check', async () => {
    const fixture = await standaloneFixture('healthy', 'linux')
    const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = []
    try {
      const result = await update(fixture, '1.0.0', '1.1.0', {
        chmod: async (path, mode) => { chmodCalls.push({ path, mode }); await chmod(path, mode) },
        stat: async () => ({ mode: 0o100755 }),
      }, 'linux', async () => true)

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
      expect(chmodCalls).toContainEqual(expect.objectContaining({
        path: expect.stringMatching(/[\\/]runtime[\\/]bin[\\/]node$/u), mode: 0o755,
      }))
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('preserves an executable tar.gz member through actual extraction', async () => {
    const fixture = await standaloneFixture('healthy', process.platform, true)
    try {
      const archive = await tarCandidate(fixture, '1.1.0', 0o755)
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => archive,
        platform: process.platform,
        healthCheck: async () => true,
      })

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
    } finally {
      await fixture.close()
    }
  })

  it('rejects a non-executable tar.gz member through actual extraction', async () => {
    const fixture = await standaloneFixture('healthy', 'linux', true)
    try {
      const archive = await tarCandidate(fixture, '1.1.0', 0o644)
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => archive,
        platform: 'linux',
        healthCheck: async () => { throw new Error('non-executable candidate must not reach health') },
      })).resolves.toEqual({ kind: 'failed', code: 'candidate-rejected' })
    } finally {
      await fixture.close()
    }
  }, 30_000)

  it('rejects an undeclared tar symlink without materializing archive members', async () => {
    const fixture = await standaloneFixture('healthy', 'linux', true)
    const rejectedCandidateContents: string[][] = []
    try {
      const archive = await tarCandidate(fixture, '1.1.0', 0o755, true)
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => archive,
        platform: 'linux',
        operations: {
          rm: async (path, options) => {
            rejectedCandidateContents.push((await readdir(path)).toSorted())
            await rm(path, options)
          },
          stat: async () => ({ mode: 0o100755 }),
        },
        healthCheck: async () => true,
      })).resolves.toEqual({ kind: 'failed', code: 'candidate-rejected' })
      expect(rejectedCandidateContents).toEqual([['.candidate.tar.gz']])
    } finally {
      await fixture.close()
    }
  }, 30_000)
})

async function standaloneFixture(
  health: 'healthy' | 'unhealthy',
  target = process.platform,
  minimalArchive = false,
): Promise<StandaloneFixture> {
  const parent = await mkdtemp(join(tmpdir(), 'harness-cli-update-'))
  const stem = `bundle-${randomUUID()}`
  const root = join(parent, stem)
  const entryPath = join(root, 'cli', 'package', 'lib', 'update.js')
  const identifier = randomUUID().replaceAll('-', '')
  const keyPair = generateKeyPairSync('ed25519')
  const keyId = `key-${identifier}`
  const origin = new URL(`https://${identifier}.invalid`).origin
  const targetPlatform = target === 'win32' || target === 'darwin' || target === 'linux' ? target : platform()
  const members = ['version', `runtime/${target === 'win32' ? 'node.exe' : 'bin/node'}`, 'cli/package/lib/bin.js', 'manifest.json']
  const files: Record<string, Uint8Array> = {
    version: Buffer.from('1.1.0'),
    [members[1]!]: minimalArchive ? Buffer.from('node') : await readFile(process.execPath),
    'cli/package/lib/bin.js': Buffer.from(health === 'healthy'
      ? "process.stdout.write('Usage: harness\\n')\n"
      : 'process.exitCode = 1\n'),
  }
  files['manifest.json'] = Buffer.from(JSON.stringify({ version: 2, executablePaths: [members[1]!] }))
  const bytes = zipSync(files)
  const digest = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'))
  const payload: UpdateManifestPayload = {
    schemaVersion: 1,
    applicationId: productMetadata.appId,
    channel: 'stable',
    version: '1.1.0',
    artifacts: [{
      consumer: 'cli', platform: targetPlatform, arch: architecture(), format: 'zip',
      url: new URL(`${randomUUID()}.zip`, `${origin}/`).href, sha256: digest, members,
    }],
  }
  const manifest: SignedUpdateManifest = {
    ...payload,
    signature: {
      algorithm: 'ed25519', keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
  await mkdir(dirname(entryPath), { recursive: true })
  await Promise.all([
    writeFile(entryPath, ''),
    writeFile(join(root, 'version'), '1.0.0'),
  ])
  return {
    entryPath, expectedLiveVersion: '1.0.0', manifest, bytes, root, privateKey: keyPair.privateKey,
    trust: { allowedOrigins: [origin], publicKeys: { [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } },
    close: async () => { await rm(parent, { recursive: true, force: true }) },
  }
}

function update(
  fixture: StandaloneFixture,
  currentVersion: string,
  candidateVersion: string,
  operations: Partial<UpdateFileOperations> = {},
  target = process.platform,
  healthCheck?: (root: string) => Promise<boolean>,
): Promise<UpdateInvocationResult> {
  return runUpdateInvocation({
    entryPath: fixture.entryPath,
    version: currentVersion,
    stdout: { write: () => true },
    trust: fixture.trust,
    loadCandidate: async () => ({ manifest: candidate(fixture, candidateVersion), bytes: fixture.bytes }),
    operations,
    platform: target,
    healthCheck,
  })
}

function candidate(fixture: StandaloneFixture, version: string): SignedUpdateManifest {
  const { signature: _signature, ...payload } = fixture.manifest
  return {
    ...payload,
    version,
    signature: {
      ...fixture.manifest.signature,
      value: sign(null, canonicalizeSignedUpdateManifest({ ...payload, version }), fixture.privateKey).toString('base64url'),
    },
  }
}

function forbiddenOperations(calls: string[]): Record<string, () => never> {
  return Object.fromEntries(['access', 'mkdir', 'readFile', 'rename', 'rm', 'writeFile', 'chmod', 'stat']
    .map(name => [name, () => { calls.push(name); throw new Error(`npm update called ${name}`) }]))
}

async function retainedVersions(root: string): Promise<readonly string[]> {
  const parent = dirname(root)
  const prefix = `${basename(root)}.retained-`
  const entries = await (await import('node:fs/promises')).readdir(parent)
  return Promise.all(entries.filter(entry => entry.startsWith(prefix))
    .map(entry => readFile(join(parent, entry, 'version'), 'utf8')))
}

async function tarCandidate(
  fixture: StandaloneFixture,
  version: string,
  executableMode: number,
  hostileLink = false,
): Promise<{ readonly manifest: SignedUpdateManifest; readonly bytes: Uint8Array }> {
  const output = await mkdtemp(join(tmpdir(), 'harness-cli-update-tar-output-'))
  const archive = join(output, 'candidate.tar.gz')
  const stage = await mkdtemp(join(tmpdir(), 'harness-cli-update-tar-stage-'))
  const members = ['version', 'runtime/bin/node', 'cli/package/lib/bin.js', 'manifest.json']
  try {
    await Promise.all([
      mkdir(join(stage, 'runtime', 'bin'), { recursive: true }),
      mkdir(join(stage, 'cli', 'package', 'lib'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(stage, 'version'), version),
      writeFile(join(stage, 'runtime', 'bin', 'node'), 'node'),
      writeFile(join(stage, 'cli', 'package', 'lib', 'bin.js'), "process.stdout.write('Usage: harness\\n')\n"),
      writeFile(join(stage, 'manifest.json'), JSON.stringify({ version: 2, executablePaths: ['runtime/bin/node'] })),
    ])
    if (hostileLink) await symlink('version', join(stage, 'undeclared-link'))
    const archiveEntries = hostileLink ? [...members, 'undeclared-link'] : members
    await tar.c({
      cwd: stage,
      file: archive,
      gzip: true,
      filter(path, entry) {
        const mutable = entry as { mode: number }
        mutable.mode = (mutable.mode & ~0o777) | (path.replaceAll('\\', '/') === 'runtime/bin/node' ? executableMode : 0o644)
        return true
      },
      mtime: new Date(0),
      portable: true,
      strict: true,
    }, archiveEntries)
    const bytes = await readFile(archive)
    const { signature: _signature, ...payload } = fixture.manifest
    const artifact = { ...payload.artifacts[0]!, format: 'tar.gz' as const, sha256: await digest(bytes), members }
    const unsigned: UpdateManifestPayload = { ...payload, version, artifacts: [artifact] }
    return {
      bytes,
      manifest: {
        ...unsigned,
        signature: {
          ...fixture.manifest.signature,
          value: sign(null, canonicalizeSignedUpdateManifest(unsigned), fixture.privateKey).toString('base64url'),
        },
      },
    }
  } finally {
    await Promise.all([
      rm(stage, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
    ])
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'))
}


function platform(): 'win32' | 'darwin' | 'linux' { return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'linux' }
function architecture(): 'x64' | 'arm64' { return process.arch === 'arm64' ? 'arm64' : 'x64' }
