/** CLI update command parsing and isolated update transaction behavior. */

import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
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
import { recoverStandalonePayload } from '../src/standalone-launcher.ts'
import type { StandaloneUpdateSource } from '../src/standalone-update-source.ts'
import type { WindowsStandaloneUpdatePlan } from '../src/windows-standalone-update.ts'

interface StandaloneFixture {
  readonly entryPath: string
  readonly expectedLiveVersion: string
  readonly manifest: SignedUpdateManifest
  readonly trust: UpdateTrust
  readonly bytes: Uint8Array
  readonly runtimeBytes: Uint8Array
  readonly envObservationPath?: string
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

  it('fails closed without candidate or filesystem I/O while production trust is empty', async () => {
    const fixture = await standaloneFixture('healthy', process.platform, true)
    const calls: string[] = []
    try {
      const before = await readFile(join(fixture.root, 'version'), 'utf8')
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        loadCandidate: async () => { calls.push('load'); throw new Error('empty trust must not load a candidate') },
        operations: forbiddenOperations(calls),
      })

      expect(result).toEqual({ kind: 'failed', code: 'unconfigured-update-source' })
      expect(calls).toEqual([])
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe(before)
    } finally {
      await fixture.close()
    }
  }, 60_000)

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
      await expect(readFile(`${fixture.root}.update.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it('reports retained cleanup failure after a healthy candidate instead of reporting fully applied', async () => {
    const fixture = await standaloneFixture('healthy')
    try {
      const result = await update(fixture, '1.0.0', '1.1.0', {
        rm: async (path, options) => {
          if (path.includes('.retained-')) throw new Error('fixture retained cleanup failure')
          await rm(path, options)
        },
      }, process.platform, async () => true)

      expect(result).toEqual({ kind: 'applied-with-cleanup-failure', code: 'retained-cleanup-failed', version: '1.1.0' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe('1.1.0')
      await expect(retainedVersions(fixture.root)).resolves.toEqual(['1.0.0'])
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

  it('hands a verified Windows candidate to a detached local scheduler before the CLI exits', async () => {
    const fixture = await standaloneFixture('healthy', 'win32', true)
    const scheduled: WindowsStandaloneUpdatePlan[] = []
    const source: StandaloneUpdateSource = {
      trust: fixture.trust,
      healthCheckTimeoutMs: 120_000,
      loadManifest: async () => fixture.manifest,
      loadRollbackManifest: async () => candidate(fixture, '1.0.0'),
      download: async () => fixture.bytes,
    }
    try {
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: 'win32',
        scheduleWindowsUpdate: async (plan) => { scheduled.push(plan) },
      })

      expect(result).toEqual({ kind: 'restart-scheduled', version: '1.1.0' })
      expect(scheduled).toEqual([expect.objectContaining({
        root: fixture.root,
        healthCheckTimeoutMs: 120_000,
      })])
      expect(JSON.stringify(scheduled[0])).not.toContain('https://')
      await expect(readFile(scheduled[0]!.lockPath, 'utf8')).resolves.toContain(`"token":"${scheduled[0]!.lockToken}"`)
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(join(scheduled[0]!.candidate, 'version'), 'utf8')).resolves.toBe('1.1.0')
    } finally {
      await fixture.close()
    }
  })

  it('hands the fixed launcher layout to Windows and recovers a crash before the first payload rename', async () => {
    const fixture = await durableStandaloneFixture()
    let scheduled: WindowsStandaloneUpdatePlan | undefined
    const source: StandaloneUpdateSource = {
      trust: fixture.trust,
      healthCheckTimeoutMs: 120_000,
      loadManifest: async () => fixture.manifest,
      loadRollbackManifest: async () => signedCandidate(fixture, fixture.bytes, '1.0.0'),
      download: async () => fixture.bytes,
    }
    try {
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: 'win32',
        scheduleWindowsUpdate: async (plan) => { scheduled = plan },
      })).resolves.toEqual({ kind: 'restart-scheduled', version: '1.1.0' })
      const plan = scheduled
      if (plan === undefined) throw new Error('durable Windows plan was not scheduled')
      const archiveRoot = dirname(dirname(fixture.root))
      expect(plan).toMatchObject({
        root: fixture.root,
        retained: join(archiveRoot, 'payload', 'retained'),
        failed: join(archiveRoot, 'payload', 'failed'),
        lockPath: join(archiveRoot, '.harness-update.lock'),
      })
      await expect(readFile(join(archiveRoot, '.harness-update.json'), 'utf8')).resolves.toContain('"phase":"prepared"')
      const lock = JSON.parse(await readFile(plan.lockPath, 'utf8')) as Record<string, unknown>
      await writeFile(plan.lockPath, `${JSON.stringify({ ...lock, processId: 2 ** 30, expiresAtMs: Date.now() - 1 })}\n`)

      await recoverStandalonePayload(archiveRoot)

      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(join(archiveRoot, '.harness-update.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.close()
    }
  }, 30_000)

  it('rejects a concurrent standalone transaction before staging and releases the lock after scheduler failure', async () => {
    const fixture = await standaloneFixture('healthy', 'win32', true)
    let scheduled: WindowsStandaloneUpdatePlan | undefined
    let enterScheduler: (() => void) | undefined
    const schedulerEntered = new Promise<void>((resolve) => { enterScheduler = resolve })
    let releaseScheduler: (() => void) | undefined
    const schedulerRelease = new Promise<void>((resolve) => { releaseScheduler = resolve })
    const source: StandaloneUpdateSource = {
      trust: fixture.trust,
      healthCheckTimeoutMs: 120_000,
      loadManifest: async () => fixture.manifest,
      loadRollbackManifest: async () => candidate(fixture, '1.0.0'),
      download: async () => fixture.bytes,
    }
    try {
      const first = runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: 'win32',
        scheduleWindowsUpdate: async (plan) => {
          scheduled = plan
          enterScheduler?.()
          await schedulerRelease
          throw new Error('fixture scheduler failure')
        },
      })
      await schedulerEntered
      const candidatesBefore = (await readdir(dirname(fixture.root))).filter(entry => entry.includes('.candidate-'))

      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: 'win32',
        scheduleWindowsUpdate: async () => { throw new Error('concurrent scheduler must not run') },
      })).resolves.toEqual({ kind: 'failed', code: 'transaction-failed' })
      expect((await readdir(dirname(fixture.root))).filter(entry => entry.includes('.candidate-'))).toEqual(candidatesBefore)
      await expect(readFile(scheduled!.lockPath, 'utf8')).resolves.toContain(`"token":"${scheduled!.lockToken}"`)

      releaseScheduler?.()
      await expect(first).resolves.toEqual({ kind: 'failed', code: 'transaction-failed' })
      await expect(readFile(`${fixture.root}.update.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(dirname(fixture.root))).filter(entry => entry.includes('.candidate-'))).toEqual([])
    } finally {
      releaseScheduler?.()
      await fixture.close()
    }
  })

  it('does not schedule a Windows replacement without a signed current-version rollback manifest', async () => {
    const fixture = await standaloneFixture('healthy', 'win32', true)
    const scheduled: WindowsStandaloneUpdatePlan[] = []
    const source: StandaloneUpdateSource = {
      trust: fixture.trust,
      healthCheckTimeoutMs: 120_000,
      loadManifest: async () => fixture.manifest,
      loadRollbackManifest: async () => { throw new Error('rollback manifest absent') },
      download: async () => fixture.bytes,
    }
    try {
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: 'win32',
        scheduleWindowsUpdate: async (plan) => { scheduled.push(plan) },
      })).resolves.toEqual({ kind: 'failed', code: 'candidate-rejected' })
      expect(scheduled).toEqual([])
    } finally {
      await fixture.close()
    }
  })

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

  it('restores declared Windows ZIP executable paths before the candidate health check', async () => {
    const fixture = await standaloneFixture('healthy', 'win32')
    const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = []
    try {
      const result = await update(fixture, '1.0.0', '1.1.0', {
        chmod: async (path, mode) => { chmodCalls.push({ path, mode }); await chmod(path, mode) },
      }, 'win32', async () => true)

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
      expect(chmodCalls.some(call => call.mode === 0o755 && /[\\/]runtime[\\/]node\.exe$/u.test(call.path))).toBe(true)
    } finally {
      await fixture.close()
    }
  }, 60_000)

  it('restores catalog-declared Windows ZIP executable paths before the candidate health check', async () => {
    const fixture = await standaloneFixture('healthy', 'win32', true)
    const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = []
    try {
      const catalog = catalogCandidate(fixture, '1.1.0', 'win32')
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => catalog,
        platform: 'win32',
        operations: {
          chmod: async (path, mode) => { chmodCalls.push({ path, mode }); await chmod(path, mode) },
        },
        healthCheck: async () => true,
      })

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
      expect(chmodCalls.some(call => call.mode === 0o755 && /[\\/]runtime[\\/]node\.exe$/u.test(call.path))).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  it.each([
    ['a path-traversal member', '../catalog-escape.txt'],
    ['a Windows-separated member', 'runtime\\node.exe'],
  ])('rejects a catalog ZIP with %s before writing the candidate', async (_name, unsafeMember) => {
    const fixture = await standaloneFixture('healthy', 'win32', true)
    try {
      const catalog = catalogCandidate(fixture, '1.1.0', 'win32', unsafeMember)
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => catalog,
        platform: 'win32',
        healthCheck: async () => true,
      })).resolves.toEqual({ kind: 'failed', code: 'candidate-rejected' })
    } finally {
      await fixture.close()
    }
  })

  it('selects a tar.gz target for Unix standalone updates and preserves its executable member through actual extraction', async () => {
    const fixture = await standaloneFixture('healthy', 'linux', true)
    try {
      const archive = await tarCandidate(fixture, '1.1.0', 0o755)
      const result = await runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => archive,
        platform: 'linux',
        operations: { stat: async () => ({ mode: 0o100755 }) },
        healthCheck: async () => true,
      })

      expect(result).toEqual({ kind: 'applied', version: '1.1.0' })
    } finally {
      await fixture.close()
    }
  })

  it.skipIf(process.platform === 'win32')('force-terminates a candidate that ignores SIGTERM after its bounded health window', async () => {
    const fixture = await standaloneFixture('ignores-sigterm', process.platform)
    try {
      const candidateArchive = await tarCandidate(
        fixture,
        '1.1.0',
        0o755,
        false,
        "process.on('SIGTERM', () => {}); process.stdout.write('Usage: harness\\n'); setInterval(() => {}, 1000)\n",
      )
      const rollbackArchive = await tarCandidate(fixture, '1.0.0', 0o755)
      const source: StandaloneUpdateSource = {
        trust: fixture.trust,
        healthCheckTimeoutMs: 100,
        loadManifest: async () => candidateArchive.manifest,
        loadRollbackManifest: async () => rollbackArchive.manifest,
        download: async () => candidateArchive.bytes,
      }
      const startedAt = Date.now()

      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: process.platform,
      })).resolves.toEqual({ kind: 'rolled-back', version: '1.1.0' })

      expect(Date.now() - startedAt).toBeLessThan(5_000)
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe(fixture.expectedLiveVersion)
    } finally {
      await fixture.close()
    }
  }, 10_000)

  it.skipIf(process.platform === 'win32')('does not commit a candidate that exits zero only after the health deadline', async () => {
    const fixture = await standaloneFixture('exits-zero-on-term', process.platform)
    try {
      const candidateArchive = await tarCandidate(
        fixture, '1.1.0', 0o755, false,
        "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('Usage: harness\\n'); setInterval(() => {}, 1000)\n",
      )
      const rollbackArchive = await tarCandidate(fixture, '1.0.0', 0o755)
      const source: StandaloneUpdateSource = {
        trust: fixture.trust,
        healthCheckTimeoutMs: 100,
        loadManifest: async () => candidateArchive.manifest,
        loadRollbackManifest: async () => rollbackArchive.manifest,
        download: async () => candidateArchive.bytes,
      }

      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: process.platform,
      })).resolves.toEqual({ kind: 'rolled-back', version: '1.1.0' })
      await expect(readFile(join(fixture.root, 'version'), 'utf8')).resolves.toBe(fixture.expectedLiveVersion)
    } finally {
      await fixture.close()
    }
  }, 10_000)

  it.skipIf(process.platform === 'win32')('rolls back after a healthy-looking leader exits with a live process-group descendant', async () => {
    const fixture = await standaloneFixture('leader-exits-with-descendant', process.platform)
    try {
      const candidateArchive = await tarCandidate(
        fixture, '1.1.0', 0o755, false,
        "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); child.unref(); process.stdout.write('Usage: harness\\n')\n",
      )
      const rollbackArchive = await tarCandidate(fixture, '1.0.0', 0o755)
      const source: StandaloneUpdateSource = {
        trust: fixture.trust,
        healthCheckTimeoutMs: 2_000,
        loadManifest: async () => candidateArchive.manifest,
        loadRollbackManifest: async () => rollbackArchive.manifest,
        download: async () => candidateArchive.bytes,
      }

      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        source,
        platform: process.platform,
      })).resolves.toEqual({ kind: 'rolled-back', version: '1.1.0' })
    } finally {
      await fixture.close()
    }
  }, 10_000)

  it('does not expose credential-shaped or DSH environment entries to the bundled health probe', async () => {
    const fixture = await standaloneFixture('observes-env')
    const names = ['DEEPSEEK_API_KEY', 'lowercase_token', 'SERVICE_PASSWORD', 'DSH_HEALTH_PROBE'] as const
    const previous = new Map(names.map(name => [name, process.env[name]] as const))
    try {
      for (const name of names) process.env[name] = `not-forwarded-${name}`
      await expect(runUpdateInvocation({
        entryPath: fixture.entryPath,
        version: '1.0.0',
        stdout: { write: () => true },
        trust: fixture.trust,
        loadCandidate: async () => ({ manifest: fixture.manifest, bytes: fixture.bytes }),
      })).resolves.toEqual({ kind: 'applied', version: '1.1.0' })
      const observed = JSON.parse(await readFile(fixture.envObservationPath!, 'utf8')) as Record<string, string>
      for (const name of names) expect(observed[name]).toBeUndefined()
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      await fixture.close()
    }
  }, 60_000)

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

  it('rejects a hostile tar.gz archive before materializing archive members', async () => {
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
  health: 'healthy' | 'unhealthy' | 'ignores-sigterm' | 'exits-zero-on-term' | 'leader-exits-with-descendant' | 'observes-env',
  target = process.platform,
  minimalArchive = false,
): Promise<StandaloneFixture> {
  const parent = await mkdtemp(join(tmpdir(), 'harness-cli-update-'))
  const stem = `bundle-${randomUUID()}`
  const root = join(parent, stem)
  const envObservationPath = join(parent, 'observed-env.json')
  const entryPath = join(root, 'cli', 'package', 'lib', 'update.js')
  const identifier = randomUUID().replaceAll('-', '')
  const keyPair = generateKeyPairSync('ed25519')
  const keyId = `key-${identifier}`
  const origin = new URL(`https://${identifier}.invalid`).origin
  const targetPlatform = target === 'win32' || target === 'darwin' || target === 'linux' ? target : platform()
  const members = ['version', `runtime/${target === 'win32' ? 'node.exe' : 'bin/node'}`, 'cli/package/lib/bin.js', 'manifest.json']
  const runtimeBytes = minimalArchive ? Buffer.from('node') : await readFile(process.execPath)
  const healthSource = (health === 'healthy'
    ? "process.stdout.write('Usage: harness\\n')\n"
    : health === 'ignores-sigterm'
      ? "process.on('SIGTERM', () => {})\nprocess.stdout.write('Usage: harness\\n')\nsetInterval(() => {}, 1_000)\n"
      : health === 'exits-zero-on-term'
        ? "process.on('SIGTERM', () => process.exit(0))\nprocess.stdout.write('Usage: harness\\n')\nsetInterval(() => {}, 1_000)\n"
        : health === 'leader-exits-with-descendant'
          ? "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); child.unref(); process.stdout.write('Usage: harness\\n')\n"
          : health === 'observes-env'
            ? "require('node:fs').writeFileSync(__ENV_FILE__, JSON.stringify(process.env)); process.stdout.write('Usage: harness\\n')\n"
            : 'process.exitCode = 1\n').replaceAll('__ENV_FILE__', JSON.stringify(envObservationPath))
  const files: Record<string, Uint8Array> = {
    version: Buffer.from('1.1.0'),
    [members[1]!]: runtimeBytes,
    'cli/package/lib/bin.js': Buffer.from(healthSource),
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
    entryPath, expectedLiveVersion: '1.0.0', manifest, bytes, runtimeBytes, root, envObservationPath, privateKey: keyPair.privateKey,
    trust: { allowedOrigins: [origin], publicKeys: { [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } },
    close: async () => { await rm(parent, { recursive: true, force: true }) },
  }
}

async function durableStandaloneFixture(): Promise<StandaloneFixture> {
  const fixture = await standaloneFixture('healthy', 'win32')
  const archiveRoot = join(dirname(fixture.root), `archive-${randomUUID()}`)
  const current = join(archiveRoot, 'payload', 'current')
  await mkdir(dirname(current), { recursive: true })
  await rename(fixture.root, current)
  const prefixed = Object.fromEntries(Object.entries(unzipSync(fixture.bytes)).map(([path, bytes]) => [
    `payload/current/${path}`,
    bytes,
  ]))
  const executable = 'payload/current/runtime/node.exe'
  const files: Record<string, Uint8Array> = {
    ...prefixed,
    'manifest.json': Buffer.from(JSON.stringify({ version: 3, executablePaths: [executable] })),
    'standalone-launcher.js': Buffer.from('export {}\n'),
  }
  const bytes = zipSync(files)
  const manifest = signedCandidate({ ...fixture, bytes }, bytes, '1.1.0')
  return {
    ...fixture,
    root: current,
    entryPath: join(current, 'cli', 'package', 'lib', 'update.js'),
    bytes,
    manifest,
  }
}

function signedCandidate(fixture: StandaloneFixture, bytes: Uint8Array, version: string): SignedUpdateManifest {
  const { signature: _signature, ...base } = fixture.manifest
  const artifact = base.artifacts[0]
  if (artifact === undefined) throw new Error('standalone fixture manifest has no artifact')
  const payload: UpdateManifestPayload = {
    ...base,
    version,
    artifacts: [{
      ...artifact,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      members: Object.keys(unzipSync(bytes)).toSorted(),
    }],
  }
  return {
    ...payload,
    signature: {
      ...fixture.manifest.signature,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), fixture.privateKey).toString('base64url'),
    },
  }
}

function catalogCandidate(
  fixture: StandaloneFixture,
  version: string,
  target: 'win32' | 'darwin' | 'linux',
  extraMember?: string,
): { readonly manifest: SignedUpdateManifest; readonly bytes: Uint8Array } {
  const entries = unzipSync(fixture.bytes)
  const { 'manifest.json': _previousManifest, ...catalogFiles } = entries
  if (extraMember !== undefined) catalogFiles[extraMember] = Buffer.from('unsafe catalog fixture')
  const executablePaths = [target === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node']
  const files = {
    ...catalogFiles,
    'manifest.json': Buffer.from(JSON.stringify({
      version: 2,
      executablePaths,
      files: Object.fromEntries(Object.entries(catalogFiles).map(([path, bytes]) => [
        path,
        createHash('sha256').update(bytes).digest('hex'),
      ])),
    })),
  }
  const bytes = zipSync(files)
  const { signature: _signature, ...payload } = fixture.manifest
  const artifact = {
    ...payload.artifacts[0]!,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    members: ['manifest.json'],
  }
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
    ...(healthCheck === undefined ? {} : { healthCheck }),
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
  return Object.fromEntries(['access', 'mkdir', 'readFile', 'removeFile', 'rename', 'rm', 'writeFile', 'chmod', 'stat', 'createExclusiveFile']
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
  entrySource = "process.stdout.write('Usage: harness\\n')\n",
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
      writeFile(join(stage, 'runtime', 'bin', 'node'), fixture.runtimeBytes),
      writeFile(join(stage, 'cli', 'package', 'lib', 'bin.js'), entrySource),
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
