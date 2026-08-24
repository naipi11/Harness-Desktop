/** Isolated signed Desktop update inputs and filesystem transaction adapter. */

import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalizeSignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateTrust,
} from '@harness-desktop/dsh-update-policy'
import { desktopReadyAcknowledgement } from '../../src/main/readiness.ts'
import type { StageAdapter, StagedDesktopCandidate } from '../../src/main/update/staged-install.ts'

/** Candidate launch result selected by one isolated fixture. */
export type FixtureLaunchResult = 'ready' | 'missing' | 'malformed' | 'failed'

/** Isolated failure behavior for one fixture-owned retention attempt. */
export interface DesktopUpdateFixtureOptions {
  /** Fail after the retained copy is complete but before it replaces the retained root. */
  readonly failRetain?: boolean
  /** Fail the retained-root publish after the selected staging attempt displaces its prior root. */
  readonly failRetainPublishOnStage?: number
  /** Fail publication of the prepared restored installation after it displaces the live root. */
  readonly failRestorePublish?: boolean
}

/** Runtime-only local update fixture without a committed release location or archive. */
export interface DesktopUpdateFixture {
  readonly adapter: StageAdapter
  readonly archive: Uint8Array
  readonly harnessSentinel: string
  readonly installationVersion: string
  readonly manifest: SignedUpdateManifest
  readonly retainedVersion: string
  readonly trust: UpdateTrust
  readonly calls: Readonly<Record<'load' | 'download' | 'inspect' | 'stage' | 'launch' | 'restore' | 'cleanup', number>>
  readonly loadManifest: () => Promise<unknown>
  readonly close: () => Promise<void>
}

interface FixtureArchive {
  readonly members: Readonly<Record<string, string>>
}

/**
 * Creates a per-test signed manifest, archive, and install tree under one random temporary root.
 * @param launchResult - child-process readiness behavior after the candidate switch.
 * @returns a fixture whose release values never leave the temporary root or in-memory test state.
 */
export async function createDesktopUpdateFixture(
  launchResult: FixtureLaunchResult = 'ready',
  options: DesktopUpdateFixtureOptions = {},
): Promise<DesktopUpdateFixture> {
  const root = await mkdtemp(join(tmpdir(), 'harness-desktop-update-'))
  const installationRoot = join(root, 'installation')
  const stagingRoot = join(root, 'staging')
  const retainedRoot = join(root, 'retained')
  const harnessHome = join(root, 'harness-home')
  const installationVersion = join(installationRoot, 'version')
  const retainedVersion = join(retainedRoot, 'version')
  const harnessSentinel = join(harnessHome, 'sentinel')
  const member = `${randomUUID()}/desktop`
  const archive = Buffer.from(JSON.stringify({ members: { [member]: '1.1.0' } } satisfies FixtureArchive), 'utf8')
  const digest = createHash('sha256').update(archive).digest('hex')
  const identifier = randomUUID().replaceAll('-', '')
  const origin = new URL(`https://${identifier}.invalid`).origin
  const keyPair = generateKeyPairSync('ed25519')
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = `key-${identifier}`
  const payload = {
    schemaVersion: 1 as const,
    applicationId: `application-${identifier}`,
    channel: 'stable' as const,
    version: '1.1.0',
    artifacts: [{
      platform: platform(),
      arch: architecture(),
      format: format(),
      url: new URL(`${randomUUID()}.archive`, `${origin}/`).href,
      sha256: digest,
      members: [member],
    }],
  }
  const manifest: SignedUpdateManifest = {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
  const trust: UpdateTrust = { allowedOrigins: [origin], publicKeys: { [keyId]: publicKey } }
  const calls = { load: 0, download: 0, inspect: 0, stage: 0, launch: 0, restore: 0, cleanup: 0 }
  let staged: StagedDesktopCandidate | undefined
  await Promise.all([
    mkdir(installationRoot, { recursive: true }),
    mkdir(harnessHome, { recursive: true }),
  ])
  await Promise.all([
    writeFile(installationVersion, '1.0.0'),
    writeFile(harnessSentinel, 'keep'),
  ])

  const adapter: StageAdapter = {
    async download(): Promise<Uint8Array> {
      calls.download += 1
      return archive
    },
    async inspect(bytes): Promise<readonly string[]> {
      calls.inspect += 1
      return Object.keys(readArchive(bytes).members).sort()
    },
    async stage(candidate): Promise<void> {
      calls.stage += 1
      const retainedPendingRoot = join(root, `retained-pending-${randomUUID()}`)
      await rm(stagingRoot, { recursive: true, force: true })
      await mkdir(stagingRoot, { recursive: true })
      try {
        await cp(installationRoot, retainedPendingRoot, { recursive: true, errorOnExist: true })
        const [current, retained] = await Promise.all([
          readFile(installationVersion, 'utf8'),
          readFile(join(retainedPendingRoot, 'version'), 'utf8'),
        ])
        if (current !== retained || options.failRetain === true) throw new Error('fixture retention did not complete')
        await replaceDirectory(retainedPendingRoot, retainedRoot, options.failRetainPublishOnStage === calls.stage)
        const contents = Object.values(readArchive(candidate.bytes).members)
        await writeFile(join(stagingRoot, 'version'), contents[0] ?? '')
        staged = candidate
      } finally {
        await rm(retainedPendingRoot, { recursive: true, force: true })
      }
    },
    async launchCandidate(candidate): Promise<unknown> {
      calls.launch += 1
      if (staged !== candidate) throw new Error('fixture candidate was not staged')
      await rm(installationRoot, { recursive: true, force: true })
      await rename(stagingRoot, installationRoot)
      return await runCandidate(launchResult)
    },
    async restoreRetained(): Promise<void> {
      calls.restore += 1
      const restorePendingRoot = join(root, `restore-pending-${randomUUID()}`)
      try {
        await cp(retainedRoot, restorePendingRoot, { recursive: true, errorOnExist: true })
        const [retained, restored] = await Promise.all([
          readFile(retainedVersion, 'utf8'),
          readFile(join(restorePendingRoot, 'version'), 'utf8'),
        ])
        if (retained !== restored) throw new Error('fixture restore did not complete')
        await replaceDirectory(restorePendingRoot, installationRoot, options.failRestorePublish === true)
      } finally {
        await rm(restorePendingRoot, { recursive: true, force: true })
      }
    },
    async cleanup(): Promise<void> {
      calls.cleanup += 1
      staged = undefined
      await rm(stagingRoot, { recursive: true, force: true })
      await rm(retainedRoot, { recursive: true, force: true })
    },
  }
  return {
    adapter,
    archive,
    harnessSentinel,
    installationVersion,
    manifest,
    retainedVersion,
    trust,
    calls,
    async loadManifest(): Promise<unknown> {
      calls.load += 1
      return manifest
    },
    close: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

function readArchive(bytes: Uint8Array): FixtureArchive {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('fixture archive is malformed')
  const members = (parsed as Record<string, unknown>).members
  if (typeof members !== 'object' || members === null || Array.isArray(members)) throw new Error('fixture archive members are malformed')
  return { members: members as Record<string, string> }
}

function runCandidate(result: FixtureLaunchResult): Promise<unknown> {
  const acknowledgement = result === 'ready'
    ? JSON.stringify(desktopReadyAcknowledgement)
    : result === 'malformed'
      ? JSON.stringify({ kind: 'desktop-dashboard-ready', version: 2 })
      : ''
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1] ?? "")', acknowledgement], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (result === 'failed' || code !== 0) {
        reject(new Error('fixture candidate exited unsuccessfully'))
        return
      }
      resolve(output === '' ? undefined : JSON.parse(output))
    })
    if (result === 'failed') child.kill()
  })
}

function platform(): 'win32' | 'darwin' | 'linux' {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') return process.platform
  throw new Error('fixture platform is unsupported')
}

function architecture(): 'x64' | 'arm64' | 'universal' {
  if (process.platform === 'darwin') return 'universal'
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error('fixture architecture is unsupported')
}

function format(): 'nsis' | 'dmg' | 'appimage' {
  return process.platform === 'win32' ? 'nsis' : process.platform === 'darwin' ? 'dmg' : 'appimage'
}

/** Atomically publishes a prepared sibling while restoring the displaced target if publication fails. */
async function replaceDirectory(prepared: string, target: string, failPublish: boolean): Promise<void> {
  const displaced = `${target}.displaced-${randomUUID()}`
  let displacedExists = false
  try {
    try {
      await rename(target, displaced)
      displacedExists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      if (failPublish) throw new Error('fixture publication rename failed')
      await rename(prepared, target)
    } catch (error) {
      if (displacedExists) {
        await rename(displaced, target)
        displacedExists = false
      }
      throw error
    }
    if (displacedExists) await rm(displaced, { recursive: true, force: true })
  } finally {
    await rm(prepared, { recursive: true, force: true })
  }
}
