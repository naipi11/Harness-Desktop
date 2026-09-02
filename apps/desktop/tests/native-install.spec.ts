/** Native Desktop installer staging and cross-restart health journal behavior. */

import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { DesktopUpdateOutcome } from '@harness-desktop/dsh-host-local-runtime'
import {
  canonicalizeSignedUpdateManifest,
  type SignedUpdateManifest,
  type UpdateManifestPayload,
  type VerifiedUpdateArtifact,
} from '@harness-desktop/dsh-update-policy'
import {
  mayCheckAutomaticDesktopUpdate,
  NativeDesktopInstallAdapter,
  isCurrentWatchdogHeartbeat,
  shouldAcknowledgeDashboardHealth,
  type NativeDesktopInstallOptions,
  type NativeInstallHeartbeatOperations,
} from '../src/main/update/native-install.ts'
import {
  nativeUpdateAppliedPath,
  nativeUpdateHeartbeatPath,
  nativeUpdateRolledBackPath,
  type NativeRollbackPlan,
  type NativeUpdateWatchPlan,
} from '../src/main/update/native-rollback.ts'
import type { DesktopUpdateSource } from '../src/main/update/release-source.ts'
import type { StagedDesktopCandidate } from '../src/main/update/staged-install.ts'
import { scheduleRequiredNativeRollback } from '../src/main/update/native-update-startup.ts'
import {
  NativeUpdateOutcomeRecorder,
  recordAndFinalizeNativeUpdateHealth,
} from '../src/main/update/native-update-outcome.ts'

const appId = 'io.github.example.harness'
const origin = 'https://updates.example.invalid'
const keyPair = generateKeyPairSync('ed25519')
const candidateLaunchNonce = '0123456789abcdef0123456789abcdef'
const keyId = 'release-test'
const trust = {
  allowedOrigins: [origin],
  publicKeys: { [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
}

function hostNativePlatform(): NativeRollbackPlan['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') return process.platform
  throw new Error('native Desktop test host platform is unsupported')
}

function artifact(version: string, bytes: Uint8Array, platform: 'win32' | 'linux' = 'win32'): VerifiedUpdateArtifact {
  const linux = platform === 'linux'
  return {
    version,
    channel: 'stable',
    consumer: 'desktop',
    platform,
    arch: 'x64',
    format: linux ? 'appimage' : 'nsis',
    url: `${origin}/${version}/${linux ? 'Harness-Desktop.AppImage' : 'Harness-Desktop-Setup.exe'}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    members: [linux ? 'AppRun' : 'Harness Desktop Setup.exe'],
  }
}

function manifest(selected: VerifiedUpdateArtifact): SignedUpdateManifest {
  const payload: UpdateManifestPayload = {
    schemaVersion: 1,
    applicationId: appId,
    channel: 'stable',
    version: selected.version,
    artifacts: [{
      consumer: selected.consumer,
      platform: selected.platform,
      arch: selected.arch,
      format: selected.format,
      url: selected.url,
      sha256: selected.sha256,
      members: selected.members,
    }],
  }
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, canonicalizeSignedUpdateManifest(payload), keyPair.privateKey).toString('base64url'),
    },
  }
}

function source(rollback: VerifiedUpdateArtifact, rollbackBytes: Uint8Array): DesktopUpdateSource {
  return {
    trust,
    healthCheckTimeoutMs: 120_000,
    nativeWorkerReadyTimeoutMs: 300_000,
    loadManifest: async () => { throw new Error('native staging receives the candidate from DesktopUpdateService') },
    loadRollbackManifest: async () => manifest(rollback),
    download: async (selected) => {
      if (selected.url !== rollback.url) throw new Error('unexpected artifact download')
      return rollbackBytes
    },
  }
}

function candidate(artifact: VerifiedUpdateArtifact, bytes: Uint8Array): StagedDesktopCandidate {
  return { artifact, bytes }
}

async function adapter(
  storageDirectory: string,
  currentVersion: string,
  rollback: VerifiedUpdateArtifact,
  rollbackBytes: Uint8Array,
  restartPlans: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = [],
  simulateWatchdogHeartbeat = true,
  workerReadyTimeouts: number[] = [],
  healthCheckTimeoutMs = 30_000,
  heartbeatOperations?: NativeInstallHeartbeatOperations,
  launchNonce: string | undefined = candidateLaunchNonce,
  restartError?: Error,
  nativeWorkerReadyTimeoutMs = 300_000,
  platform: NodeJS.Platform = 'win32',
  restartObserver?: (
    plan: NativeRollbackPlan | NativeUpdateWatchPlan,
    afterWorkerReady: (() => Promise<void>) | undefined,
  ) => Promise<void>,
): Promise<NativeDesktopInstallAdapter> {
  const options: NativeDesktopInstallOptions & { readonly candidateLaunchNonce?: string } = {
    appId,
    source: source(rollback, rollbackBytes),
    storageDirectory,
    platform,
    arch: 'x64',
    currentVersion,
    applicationPath: 'C:\\Harness Desktop\\harness-desktop.exe',
    healthCheckTimeoutMs,
    nativeWorkerReadyTimeoutMs,
    ...(launchNonce === undefined ? {} : { candidateLaunchNonce: launchNonce }),
    requestRestart: async (plan, workerReadyTimeoutMs, afterWorkerReady) => {
      restartPlans.push(plan)
      workerReadyTimeouts.push(workerReadyTimeoutMs)
      if (restartError !== undefined) throw restartError
      if (simulateWatchdogHeartbeat && 'journalPath' in plan) {
        await writeFile(
          nativeUpdateHeartbeatPath(plan.rollbackArtifactPath, plan.transactionId, hostNativePlatform()),
          `${plan.transactionId}:${candidateLaunchNonce}:${String(Date.now())}\n`,
        )
      }
      if (restartObserver !== undefined) await restartObserver(plan, afterWorkerReady)
      else await afterWorkerReady?.()
    },
  }
  let testNow = 0
  const deterministicOperations: NativeInstallHeartbeatOperations = heartbeatOperations ?? {
    monotonicNow: () => testNow,
    wallNow: () => Date.now(),
    read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }),
    delay: async () => { testNow += healthCheckTimeoutMs },
  }
  return new NativeDesktopInstallAdapter(options, deterministicOperations)
}

describe('NativeDesktopInstallAdapter', () => {
  it('parses one strict Windows launch nonce argument', async () => {
    const module = await import('../src/main/update/native-install.ts') as typeof import('../src/main/update/native-install.ts') & {
      readonly parseNativeUpdateLaunchNonce?: (arguments_: readonly string[]) => string | undefined
    }
    expect(module.parseNativeUpdateLaunchNonce).toBeTypeOf('function')
    if (module.parseNativeUpdateLaunchNonce === undefined) return

    expect(module.parseNativeUpdateLaunchNonce([
      'harness-desktop.exe',
      `--dsh-native-update-launch-nonce=${candidateLaunchNonce}`,
    ])).toBe(candidateLaunchNonce)
    expect(module.parseNativeUpdateLaunchNonce(['harness-desktop.exe'])).toBeUndefined()
    expect(module.parseNativeUpdateLaunchNonce([
      `--dsh-native-update-launch-nonce=${candidateLaunchNonce}`,
      `--dsh-native-update-launch-nonce=${'f'.repeat(32)}`,
    ])).toBeUndefined()
    expect(module.parseNativeUpdateLaunchNonce([
      '--dsh-native-update-launch-nonce=NOT-HEX',
    ])).toBeUndefined()
  })

  it('keeps the non-Windows transaction heartbeat startup and future timestamp bounds', () => {
    const transactionId = '11111111-1111-4111-8111-111111111111'
    expect(isCurrentWatchdogHeartbeat(
      `${transactionId}:1700000000100\n`, transactionId, 1700000000100, 1700000000200, 'linux',
    )).toBe(true)
    expect(isCurrentWatchdogHeartbeat(
      `${transactionId}:1700000000099\n`, transactionId, 1700000000100, 1700000000200, 'linux',
    )).toBe(false)
    expect(isCurrentWatchdogHeartbeat(
      `${transactionId}:1700000000201\n`, transactionId, 1700000000100, 1700000000200, 'darwin',
    )).toBe(false)
  })

  it('rejects a Windows heartbeat for another transaction when the launch nonce matches', () => {
    const expectedTransactionId = '11111111-1111-4111-8111-111111111111'

    expect(isCurrentWatchdogHeartbeat(
      `22222222-2222-4222-8222-222222222222:${candidateLaunchNonce}:1700000000100\n`,
      expectedTransactionId,
      1700000000200,
      1700000000200,
      'win32',
      candidateLaunchNonce,
    )).toBe(false)
  })

  it.each([
    [{ kind: 'none' }, true],
    [{ kind: 'applied', version: '1.1.0', channel: 'stable' }, true],
    [{ kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'rollback-required', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'recovery-blocked', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'rolled-back', version: '1.1.0', channel: 'stable' }, false],
  ] as const)('permits a new automatic check for %o only when the previous update did not roll back', (health, expected) => {
    expect(mayCheckAutomaticDesktopUpdate(health)).toBe(expected)
  })

  it.each([
    [{ kind: 'none' }, false],
    [{ kind: 'applied', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable' }, true],
    [{ kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable' }, true],
    [{ kind: 'rollback-required', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'recovery-blocked', version: '1.1.0', channel: 'stable' }, false],
    [{ kind: 'rolled-back', version: '1.1.0', channel: 'stable' }, false],
  ] as const)('acknowledges worker-owned startup health for %o only while it can still settle', (health, expected) => {
    expect(shouldAcknowledgeDashboardHealth(health)).toBe(expected)
  })

  it('arms a local-only external installer plan and commits only after the next Dashboard health acknowledgement', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    const workerReadyTimeouts: number[] = []
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes, watches, true, workerReadyTimeouts)
      const staged = candidate(next, nextBytes)

      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      expect(watches).toEqual([expect.objectContaining({
        candidateArtifactPath: expect.stringContaining(next.sha256) as unknown,
        candidateSha256: next.sha256,
        rollbackSha256: current.sha256,
      })])
      expect(workerReadyTimeouts).toEqual([300_000])
      const journal = await readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8')
      expect(journal).not.toContain(origin)
      expect(journal).not.toContain(next.url)
      expect(JSON.stringify(watches[0])).not.toContain(origin)
      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable',
      })
      await expect(subject.acknowledgeDashboardHealth('1.1.0')).resolves.toEqual({
        kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .resolves.toMatch(/"phase":"applied".*"candidateProcess"/u)
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('records only a fixed worker scheduling failure stage when diagnostics are explicitly enabled', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes, 'linux')
    const next = artifact('1.1.0', nextBytes, 'linux')
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, [], false, [], 30_000, undefined,
        candidateLaunchNonce, new Error('private path and token must not be recorded'), 300_000, 'linux',
      )
      const staged = candidate(next, nextBytes)
      const previous = process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS
      process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS = '1'
      try {
        await subject.stage(staged)
        await expect(subject.scheduleInstall(staged)).rejects.toThrow('private path and token')
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS')
        else process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS = previous
      }
      const workers = join(storageDirectory, 'native-updates', 'workers')
      const receipts = (await readdir(workers)).filter(name => name.startsWith('native-update-failure-stage-'))
      expect(receipts).toHaveLength(1)
      await expect(readFile(join(workers, receipts[0]!), 'utf8')).resolves.toBe('schedule-worker\n')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('retries a transient Windows journal replacement sharing conflict before native handoff', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const readyPath = join(storageDirectory, 'journal-lock.ready')
    const releasePath = join(storageDirectory, 'journal-lock.release')
    let locker: ReturnType<typeof spawn> | undefined
    try {
      const heartbeatOperations: NativeInstallHeartbeatOperations = {
        monotonicNow: () => performance.now(),
        wallNow: () => Date.now(),
        read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }),
        delay: async (milliseconds) => { await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) }) },
      }
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes, [], false, [], 30_000, heartbeatOperations)
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        `$Stream = [IO.File]::Open(${powershellLiteral(journalPath)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`,
        `[IO.File]::WriteAllText(${powershellLiteral(readyPath)}, 'ready')`,
        `while (-not (Test-Path -LiteralPath ${powershellLiteral(releasePath)})) { Start-Sleep -Milliseconds 25 }`,
        '$Stream.Dispose()',
      ].join('; ')
      locker = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      const deadline = Date.now() + 5_000
      while (!await readFile(readyPath).then(() => true).catch(() => false)) {
        if (Date.now() >= deadline) throw new Error('journal lock fixture did not become ready')
        await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
      }
      const release = new Promise<void>((resolveRelease) => {
        setTimeout(() => {
          void writeFile(releasePath, 'release', { flag: 'wx' }).then(
            () => { resolveRelease() },
            () => { resolveRelease() },
          )
        }, 100)
      })

      await expect(subject.scheduleInstall(staged)).resolves.toBeUndefined()
      await release
      await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase":"awaiting-dashboard-health"')
    } finally {
      if (locker !== undefined && locker.exitCode === null) {
        locker.kill()
        const activeLocker = locker
        await new Promise<void>((resolveExit) => { activeLocker.once('exit', () => { resolveExit() }) })
      }
      await rm(storageDirectory, { recursive: true, force: true })
    }
  }, 15_000)

  it.runIf(process.platform === 'win32')('fails closed when a Windows journal replacement sharing conflict outlives the handoff budget', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const readyPath = join(storageDirectory, 'journal-lock.ready')
    let locker: ReturnType<typeof spawn> | undefined
    try {
      const heartbeatOperations: NativeInstallHeartbeatOperations = {
        monotonicNow: () => performance.now(),
        wallNow: () => Date.now(),
        read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }),
        delay: async (milliseconds) => { await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) }) },
      }
      const restartPlans: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, restartPlans, false, [], 30_000,
        heartbeatOperations, candidateLaunchNonce, undefined, 50,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = [
        `$Stream = [IO.File]::Open(${powershellLiteral(journalPath)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`,
        `[IO.File]::WriteAllText(${powershellLiteral(readyPath)}, 'ready')`,
        'Start-Sleep -Seconds 30',
        '$Stream.Dispose()',
      ].join('; ')
      locker = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      const deadline = Date.now() + 5_000
      while (!await readFile(readyPath).then(() => true).catch(() => false)) {
        if (Date.now() >= deadline) throw new Error('journal lock fixture did not become ready')
        await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
      }

      await expect(subject.scheduleInstall(staged)).rejects.toMatchObject({ code: 'EPERM' })
      await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase":"staged"')
      expect(restartPlans).toEqual([])
      expect((await readdir(join(storageDirectory, 'native-updates'))).some(name => name.includes('.staging-'))).toBe(false)
    } finally {
      if (locker !== undefined && locker.exitCode === null) {
        locker.kill()
        const activeLocker = locker
        await new Promise<void>((resolveExit) => { activeLocker.once('exit', () => { resolveExit() }) })
      }
      await rm(storageDirectory, { recursive: true, force: true })
    }
  }, 15_000)

  it('settles the current launch when the worker commit marker appears after Dashboard acknowledgement', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    let now = 0
    let markerPath: string | undefined
    let transactionId: string | undefined
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => now,
      wallNow: () => Date.now(),
      read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }),
      delay: async (milliseconds) => {
        now += milliseconds
        if (markerPath !== undefined && transactionId !== undefined) {
          await writeFile(markerPath, `${transactionId}\n`, { flag: 'wx' })
          markerPath = undefined
        }
      },
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, [], true, [], 30_000, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-dashboard-health' })
      const journal = JSON.parse(await readFile(
        join(storageDirectory, 'native-updates', 'pending-native-update.json'),
        'utf8',
      )) as { readonly transactionId: string }
      transactionId = journal.transactionId
      markerPath = nativeUpdateAppliedPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        transactionId,
        hostNativePlatform(),
      )

      await expect(subject.acknowledgeDashboardHealth('1.1.0')).resolves.toEqual({
        kind: 'applied', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .resolves.toContain('"phase":"applied"')
      await subject.finalizeDashboardHealth({ kind: 'applied', version: '1.1.0', channel: 'stable' })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('settles an applied journal when the worker marker appears during a later same-process acknowledgement', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    let now = 0
    let markerPath: string | undefined
    let transactionId: string | undefined
    let publishDuringNextWait = false
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => now,
      wallNow: () => Date.now(),
      read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }),
      delay: async (milliseconds) => {
        now += milliseconds
        if (publishDuringNextWait && markerPath !== undefined && transactionId !== undefined) {
          await writeFile(markerPath, `${transactionId}\n`, { flag: 'wx' })
          markerPath = undefined
        }
      },
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, [], true, [], 100, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-dashboard-health' })
      const journal = JSON.parse(await readFile(
        join(storageDirectory, 'native-updates', 'pending-native-update.json'),
        'utf8',
      )) as { readonly transactionId: string }
      transactionId = journal.transactionId
      markerPath = nativeUpdateAppliedPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        transactionId,
        hostNativePlatform(),
      )

      await expect(subject.acknowledgeDashboardHealth('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-worker-commit' })
      publishDuringNextWait = true
      await expect(subject.acknowledgeDashboardHealth('1.1.0')).resolves.toEqual({
        kind: 'applied', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .resolves.toContain('"phase":"applied"')
      await subject.finalizeDashboardHealth({ kind: 'applied', version: '1.1.0', channel: 'stable' })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('replays retained applied health after a Runtime outcome write fails across process startup', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
    let writes = 0
    const runtime = {
      getDesktopUpdateChannel: async () => 'stable' as const,
      getDesktopUpdateLastOutcome: async () => undefined,
      recordDesktopUpdateOutcome: async (_outcome: DesktopUpdateOutcome) => {
        writes += 1
        if (writes === 1) throw new Error('settings unavailable')
      },
    }
    const recorder = new NativeUpdateOutcomeRecorder()
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await expect(first.acknowledgeDashboardHealth('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-worker-commit' })
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { readonly transactionId: string }
      await writeFile(nativeUpdateAppliedPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        journal.transactionId,
        hostNativePlatform(),
      ), `${journal.transactionId}\n`, { flag: 'wx' })
      const applied = await first.acknowledgeDashboardHealth('1.1.0')
      expect(applied).toMatchObject({ kind: 'applied' })

      await expect(recordAndFinalizeNativeUpdateHealth(
        recorder,
        runtime,
        applied,
        '1.1.0',
        async (health) => { await first.finalizeDashboardHealth(health) },
      )).rejects.toThrow('settings unavailable')
      await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase":"applied"')

      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      const replayed = await restarted.beginDashboardHealthCheck('1.1.0')
      expect(replayed).toEqual({ kind: 'applied', version: '1.1.0', channel: 'stable' })
      await recordAndFinalizeNativeUpdateHealth(
        recorder,
        runtime,
        replayed,
        '1.1.0',
        async (health) => { await restarted.finalizeDashboardHealth(health) },
      )
      expect(writes).toBe(2)
      await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it.each(['dashboard-health-checking', 'applied'] as const)(
    'blocks a third-version startup with a retained %s journal without recording rollback',
    async (phase) => {
      const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
      const currentBytes = Buffer.from('stable-1.0.0')
      const nextBytes = Buffer.from('candidate-1.1.0')
      const current = artifact('1.0.0', currentBytes)
      const next = artifact('1.1.0', nextBytes)
      const outcomes: DesktopUpdateOutcome[] = []
      let finalized = false
      const runtime = {
        getDesktopUpdateChannel: async () => 'stable' as const,
        getDesktopUpdateLastOutcome: async () => undefined,
        recordDesktopUpdateOutcome: async (outcome: DesktopUpdateOutcome) => { outcomes.push(outcome) },
      }
      try {
        const candidateAdapter = await adapter(storageDirectory, '1.0.0', current, currentBytes)
        const staged = candidate(next, nextBytes)
        await candidateAdapter.stage(staged)
        await candidateAdapter.scheduleInstall(staged)
        await candidateAdapter.beginDashboardHealthCheck('1.1.0')
        if (phase === 'applied') await candidateAdapter.acknowledgeDashboardHealth('1.1.0')

        const thirdVersion = await adapter(storageDirectory, '2.0.0', current, currentBytes)
        const health = await thirdVersion.beginDashboardHealthCheck('2.0.0')
        expect(health).toEqual({ kind: 'recovery-blocked', version: '1.1.0', channel: 'stable' })
        await recordAndFinalizeNativeUpdateHealth(
          new NativeUpdateOutcomeRecorder(),
          runtime,
          health,
          '2.0.0',
          async () => { finalized = true },
        )
        expect(outcomes).toEqual([])
        expect(finalized).toBe(false)
        await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
          .resolves.toContain(`"phase":"${phase}"`)
      } finally {
        await rm(storageDirectory, { recursive: true, force: true })
      }
    },
  )

  it.each(['applied-marker', 'heartbeat', 'candidate-cache', 'rollback-cache'] as const)(
    'resumes cleanup-pending after a crash removed %s without deleting unknown worker entries',
    async (missing) => {
      const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
      const currentBytes = Buffer.from('stable-1.0.0')
      const nextBytes = Buffer.from('candidate-1.1.0')
      const current = artifact('1.0.0', currentBytes)
      const next = artifact('1.1.0', nextBytes)
      const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
      try {
        const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)
        const staged = candidate(next, nextBytes)
        await subject.stage(staged)
        await subject.scheduleInstall(staged)
        await subject.beginDashboardHealthCheck('1.1.0')
        await subject.acknowledgeDashboardHealth('1.1.0')
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown> & { readonly transactionId: string }
        const workers = join(storageDirectory, 'native-updates', 'workers')
        const appliedMarker = join(workers, `native-update-applied-${journal.transactionId}.json`)
        const heartbeat = join(workers, `native-update-heartbeat-${journal.transactionId}.json`)
        const rolledBackMarker = join(workers, `native-update-rolled-back-${journal.transactionId}.json`)
        const unknown = join(workers, 'unknown-worker-residue.txt')
        await writeFile(appliedMarker, `${journal.transactionId}\n`, { flag: 'wx' })
        await writeFile(rolledBackMarker, `${journal.transactionId}\n`, { flag: 'wx' })
        await writeFile(unknown, 'retain me\n', { flag: 'wx' })
        await writeFile(journalPath, `${JSON.stringify({ ...journal, phase: 'cleanup-pending' })}\n`)
        const missingPath = missing === 'applied-marker' ? appliedMarker
          : missing === 'heartbeat' ? heartbeat
            : missing === 'candidate-cache' ? join(storageDirectory, 'native-updates', next.sha256)
              : join(storageDirectory, 'native-updates', current.sha256)
        await rm(missingPath, { recursive: true, force: true })

        const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
        await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({ kind: 'none' })
        for (const path of [appliedMarker, heartbeat, rolledBackMarker, journalPath]) {
          await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await expect(readFile(unknown, 'utf8')).resolves.toBe('retain me\n')
      } finally {
        await rm(storageDirectory, { recursive: true, force: true })
      }
    },
  )

  it('requires rollback when a candidate restarts without a post-launch watchdog heartbeat', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes, [], false, [], 100)
      const staged = candidate(next, nextBytes)

      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('schedules rollback after a restarted candidate reports a missing watchdog heartbeat', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes, [], false, [], 100)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)

      const rollbackPlans: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes, rollbackPlans, false, [], 100)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
      await expect(restarted.scheduleRollback()).resolves.toEqual({ kind: 'rollback-scheduled' })
      expect(rollbackPlans).toHaveLength(1)
      expect(rollbackPlans[0]).not.toHaveProperty('journalPath')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('schedules rollback after an applied candidate loses its watchdog heartbeat before worker commit', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await expect(first.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-dashboard-health' })
      await expect(first.acknowledgeDashboardHealth('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-worker-commit' })
      const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
      const pending = JSON.parse(await readFile(journalPath, 'utf8')) as { readonly transactionId: string }
      await unlink(nativeUpdateHeartbeatPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        pending.transactionId,
        hostNativePlatform(),
      ))

      const rollbackPlans: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes, rollbackPlans, false, [], 100)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
      await expect(restarted.scheduleRollback()).resolves.toEqual({ kind: 'rollback-scheduled' })
      expect(rollbackPlans).toHaveLength(1)
      expect(rollbackPlans[0]).not.toHaveProperty('journalPath')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('rejects rollback scheduling for an awaiting candidate without a matching failed health check', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)

      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      await expect(restarted.scheduleRollback()).rejects.toThrow('native Desktop rollback is not authorized')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('rejects rollback scheduling for an applied candidate without a matching failed health check', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await first.acknowledgeDashboardHealth('1.1.0')

      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      await expect(restarted.scheduleRollback()).rejects.toThrow('native Desktop rollback is not authorized')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('continues with settled applied health when worker completion appears before rollback scheduling', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await first.acknowledgeDashboardHealth('1.1.0')
      const pending = JSON.parse(await readFile(journalPath, 'utf8')) as { readonly transactionId: string }
      const rollbackArtifactPath = join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe')
      await unlink(nativeUpdateHeartbeatPath(rollbackArtifactPath, pending.transactionId, hostNativePlatform()))

      const rollbackPlans: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes, rollbackPlans, false, [], 100)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'rollback-required' })
      await writeFile(nativeUpdateAppliedPath(rollbackArtifactPath, pending.transactionId, hostNativePlatform()), `${pending.transactionId}\n`)

      const resolution = await scheduleRequiredNativeRollback(restarted)
      expect(resolution).toEqual({
        result: 'continue',
        health: { kind: 'applied', version: '1.1.0', channel: 'stable' },
      })
      if (resolution.result !== 'continue') throw new Error('expected applied native update health')
      await restarted.finalizeDashboardHealth(resolution.health)
      await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(rollbackPlans).toEqual([])
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a heartbeat whose private-file read completes after the policy deadline', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    let heartbeat: string | undefined
    const monotonicTimes = [0, 0, 101]
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => monotonicTimes.shift() ?? 101,
      wallNow: () => Date.now(),
      read: async () => heartbeat,
      delay: async () => {},
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 100, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      const watch = watches[0]
      if (watch === undefined || !('journalPath' in watch)) throw new Error('expected a native update watch plan')
      heartbeat = `${watch.transactionId}:${candidateLaunchNonce}:${String(Date.now())}\n`
      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('bounds a missing-heartbeat wait when the wall clock moves backward', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const monotonicTimes = [0, 0, 0, 50, 50, 100]
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => monotonicTimes.shift() ?? 100,
      wallNow: () => 1,
      read: async () => undefined,
      delay: async () => {},
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, [], false, [], 100, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('does not reject a current heartbeat early when the wall clock jumps forward', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    const writtenAt = Date.now()
    let transactionId: string | undefined
    let reads = 0
    let wallClockJumped = false
    const monotonicTimes = [0, 0, 0, 50, 50]
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => monotonicTimes.shift() ?? 50,
      wallNow: () => wallClockJumped ? writtenAt + 60_000 : writtenAt,
      read: async () => {
        if (transactionId === undefined) throw new Error('transaction is not armed')
        if (reads++ === 0) {
          wallClockJumped = true
          return undefined
        }
        return `${transactionId}:${candidateLaunchNonce}:${String(writtenAt)}\n`
      },
      delay: async () => {},
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 100, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      const watch = watches[0]
      if (watch === undefined || !('journalPath' in watch)) throw new Error('expected a native update watch plan')
      transactionId = watch.transactionId
      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a watchdog heartbeat timestamp from the future', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 100)
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      const watch = watches[0]
      if (watch === undefined || !('journalPath' in watch)) throw new Error('expected a native update watch plan')
      await writeFile(
        nativeUpdateHeartbeatPath(watch.rollbackArtifactPath, watch.transactionId, hostNativePlatform()),
        `${watch.transactionId}:${candidateLaunchNonce}:${String(Date.now() + 60_000)}\n`,
      )

      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('accepts a current watchdog heartbeat that arrives after candidate startup work exceeds one second', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    const liveHeartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => performance.now(),
      wallNow: () => Date.now(),
      read: async path => await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }),
      delay: async (milliseconds) => {
        await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
      },
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 30_000, liveHeartbeatOperations,
      )
      const staged = candidate(next, nextBytes)

      await subject.stage(staged)
      await subject.scheduleInstall(staged)
      const watch = watches[0]
      if (watch === undefined || !('journalPath' in watch)) throw new Error('expected a native update watch plan')
      const heartbeatWritten = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          writeFile(
            nativeUpdateHeartbeatPath(watch.rollbackArtifactPath, watch.transactionId, hostNativePlatform()),
            `${watch.transactionId}:${candidateLaunchNonce}:${String(Date.now())}\n`,
          ).then(resolve, reject)
        }, 1_500)
      })

      const health = subject.beginDashboardHealthCheck('1.1.0')
      await heartbeatWritten
      await expect(health).resolves.toEqual({
        kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('accepts the matching launch nonce even when the candidate epoch estimate is later than the worker sample', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    const writtenAt = Date.now() - 10
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => 0,
      wallNow: () => writtenAt + 10,
      read: async () => {
        const watch = watches[0]
        if (watch === undefined || !('journalPath' in watch)) return undefined
        return `${watch.transactionId}:${candidateLaunchNonce}:${String(writtenAt)}\n`
      },
      delay: async () => {},
    }
    try {
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 100, heartbeatOperations,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'awaiting-dashboard-health', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing', undefined],
    ['wrong', 'fedcba9876543210fedcba9876543210'],
    ['replayed', '11111111111111111111111111111111'],
  ] as const)('rejects a %s Windows launch nonce heartbeat', async (_label, heartbeatNonce) => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    const now = Date.now()
    let monotonicNow = 0
    const heartbeatOperations: NativeInstallHeartbeatOperations = {
      monotonicNow: () => monotonicNow,
      wallNow: () => now,
      read: async () => {
        const watch = watches[0]
        if (watch === undefined || !('journalPath' in watch)) return undefined
        return heartbeatNonce === undefined
          ? `${watch.transactionId}:${String(now)}\n`
          : `${watch.transactionId}:${heartbeatNonce}:${String(now)}\n`
      },
      delay: async (milliseconds) => { monotonicNow += milliseconds },
    }
    try {
      const expectedLaunchNonce = heartbeatNonce === '11111111111111111111111111111111'
        ? '22222222222222222222222222222222'
        : candidateLaunchNonce
      const subject = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, watches, false, [], 1, heartbeatOperations,
        expectedLaunchNonce,
      )
      const staged = candidate(next, nextBytes)
      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      await expect(subject.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('retains a verified rollback artifact when a restarted candidate never reaches Dashboard health', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await expect(first.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'awaiting-dashboard-health' })
      await markCandidateAsExited(storageDirectory)

      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'))).resolves.toEqual(currentBytes)
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('requires rollback when a recycled candidate process identifier has a different startup identity', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await markCandidateWithRecycledStart(storageDirectory)

      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'rollback-required', version: '1.1.0', channel: 'stable',
      })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('records the failed candidate identity for the already-armed watchdog when health is missed', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await markCandidateAsExited(storageDirectory)

      const recoveries: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const restarted = await adapter(storageDirectory, '1.1.0', current, currentBytes, recoveries)
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'rollback-required' })
      await restarted.scheduleRollback()

      expect(recoveries).toEqual([expect.objectContaining({
        rollbackArtifactPath: expect.stringContaining(current.sha256) as unknown,
        rollbackSha256: current.sha256,
        rollbackFormat: 'nsis',
      })])
      expect(recoveries[0]).not.toHaveProperty('candidateArtifactPath')

      const journal = JSON.parse(await readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8')) as {
        readonly phase: unknown
        readonly candidateProcess: unknown
      }
      expect(journal.phase).toBe('rollback-scheduled')
      expect(journal.candidateProcess).toEqual(expect.objectContaining({
        processId: process.pid,
        executablePath: process.execPath,
      }))
      const retainedRollbackPath = join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe')
      const rollbackTransaction = JSON.parse(await readFile(
        join(storageDirectory, 'native-updates', 'pending-native-update.json'),
        'utf8',
      )) as { readonly transactionId: string }
      await writeFile(
        nativeUpdateRolledBackPath(retainedRollbackPath, rollbackTransaction.transactionId, hostNativePlatform()),
        `${rollbackTransaction.transactionId}\n`,
        { flag: 'wx' },
      )
      const restored = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const health = await restored.beginDashboardHealthCheck('1.0.0')
      expect(health).toEqual({
        kind: 'rolled-back', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .resolves.toContain('"phase":"rollback-scheduled"')
      await restored.finalizeDashboardHealth(health)
      await expect(readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('publishes a non-Windows rollback handoff only after its fresh worker is ready', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = {
      ...artifact('1.0.0', currentBytes),
      platform: 'darwin' as const,
      arch: 'universal' as const,
      format: 'zip' as const,
      url: `${origin}/1.0.0/Harness-Desktop.zip`,
      members: ['Harness Desktop.app'],
    }
    const next = {
      ...artifact('1.1.0', nextBytes),
      platform: 'darwin' as const,
      arch: 'universal' as const,
      format: 'zip' as const,
      url: `${origin}/1.1.0/Harness-Desktop.zip`,
      members: ['Harness Desktop.app'],
    }
    const observedPhases: unknown[] = []
    const restartObserver = async (
      plan: NativeRollbackPlan | NativeUpdateWatchPlan,
      afterWorkerReady: (() => Promise<void>) | undefined,
    ): Promise<void> => {
      if ('journalPath' in plan) {
        expect(afterWorkerReady).toBeUndefined()
        return
      }
      const readPhase = async (): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await readFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'utf8')) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
        return (parsed as { readonly phase?: unknown }).phase
      }
      observedPhases.push(await readPhase())
      expect(afterWorkerReady).toBeTypeOf('function')
      await afterWorkerReady?.()
      observedPhases.push(await readPhase())
    }
    try {
      const first = await adapter(
        storageDirectory, '1.0.0', current, currentBytes, [], false, [], 30_000, undefined, undefined, undefined, 300_000, 'darwin', restartObserver,
      )
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)

      const recoveries: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
      const restarted = await adapter(
        storageDirectory, '1.1.0', current, currentBytes, recoveries, false, [], 30_000, undefined, undefined, undefined, 300_000, 'darwin', restartObserver,
      )
      await expect(restarted.beginDashboardHealthCheck('1.1.0')).resolves.toMatchObject({ kind: 'rollback-required' })
      await expect(restarted.scheduleRollback()).resolves.toEqual({ kind: 'rollback-scheduled' })

      expect(observedPhases).toEqual(['awaiting-dashboard-health', 'rollback-scheduled'])
      expect(recoveries).toHaveLength(1)
      expect(recoveries[0]).not.toHaveProperty('journalPath')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('retains an applied journal until its detached watchdog records the matching completion marker', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const journalPath = join(storageDirectory, 'native-updates', 'pending-native-update.json')
    try {
      const first = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      const staged = candidate(next, nextBytes)
      await first.stage(staged)
      await first.scheduleInstall(staged)
      await first.beginDashboardHealthCheck('1.1.0')
      await first.acknowledgeDashboardHealth('1.1.0')
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { readonly transactionId: string }

      const beforeObservation = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      await expect(beforeObservation.beginDashboardHealthCheck('1.1.0')).resolves.toEqual({
        kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable',
      })
      await expect(beforeObservation.acknowledgeDashboardHealth('1.1.0')).resolves.toEqual({
        kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase":"applied"')
      await expect(beforeObservation.stage(candidate(
        artifact('1.2.0', Buffer.from('candidate-1.2.0')),
        Buffer.from('candidate-1.2.0'),
      ))).rejects.toThrow('transaction has not settled')
      await expect(beforeObservation.finalizeDashboardHealth({
        kind: 'applied', version: '1.1.0', channel: 'stable',
      })).rejects.toThrow('lacks worker completion proof')
      await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase":"applied"')

      const marker = nativeUpdateAppliedPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        journal.transactionId,
        hostNativePlatform(),
      )
      const heartbeat = nativeUpdateHeartbeatPath(
        join(storageDirectory, 'native-updates', current.sha256, 'candidate.exe'),
        journal.transactionId,
        hostNativePlatform(),
      )
      await mkdir(join(storageDirectory, 'native-updates', 'workers'), { recursive: true })
      await writeFile(marker, `${journal.transactionId}\n`)
      const afterObservation = await adapter(storageDirectory, '1.1.0', current, currentBytes)
      const health = await afterObservation.beginDashboardHealthCheck('1.1.0')
      expect(health).toEqual({
        kind: 'applied', version: '1.1.0', channel: 'stable',
      })
      await afterObservation.finalizeDashboardHealth(health)
      await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(heartbeat, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('arms a detached watchdog before native installation so a candidate that never reaches Main is rolled back', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const watches: Array<NativeRollbackPlan | NativeUpdateWatchPlan> = []
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes, watches)
      const staged = candidate(next, nextBytes)

      await subject.stage(staged)
      await subject.scheduleInstall(staged)

      expect(watches).toEqual([expect.objectContaining({
        candidateVersion: '1.1.0',
        rollbackSha256: current.sha256,
        healthCheckTimeoutMs: 30_000,
      })])
      expect(watches[0]).toHaveProperty('journalPath', expect.stringContaining('pending-native-update.json'))
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed when a persisted native health journal is malformed', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    try {
      await mkdir(join(storageDirectory, 'native-updates'))
      await writeFile(join(storageDirectory, 'native-updates', 'pending-native-update.json'), 'not-json\n')
      const subject = await adapter(
        storageDirectory,
        '1.0.0',
        artifact('1.0.0', Buffer.from('stable')),
        Buffer.from('stable'),
      )

      await expect(subject.beginDashboardHealthCheck('1.0.0')).rejects.toThrow('journal is malformed')
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a link-shaped native update root before it stages any installer bytes', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const sentinel = join(outside, 'must-not-change.txt')
    try {
      await writeFile(sentinel, 'outside bytes')
      await symlink(outside, join(storageDirectory, 'native-updates'), directoryLinkType())
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)

      await expect(subject.stage(candidate(next, nextBytes))).rejects.toThrow('cache root is not a private directory')
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('outside bytes')
    } finally {
      await unlink(join(storageDirectory, 'native-updates')).catch(() => undefined)
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a link-shaped artifact cache entry without following it', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const sentinel = join(outside, 'must-not-change.txt')
    try {
      await mkdir(join(storageDirectory, 'native-updates'))
      await writeFile(sentinel, 'outside bytes')
      await symlink(outside, join(storageDirectory, 'native-updates', next.sha256), directoryLinkType())
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)

      await expect(subject.stage(candidate(next, nextBytes))).rejects.toThrow('cache entry is not a private directory')
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('outside bytes')
    } finally {
      await unlink(join(storageDirectory, 'native-updates', next.sha256)).catch(() => undefined)
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a link-shaped cached installer file without reading its target', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const cacheDirectory = join(storageDirectory, 'native-updates', next.sha256)
    const outsideInstaller = join(outside, 'candidate.exe')
    try {
      await mkdir(cacheDirectory, { recursive: true })
      await writeFile(outsideInstaller, nextBytes)
      await symlink(outsideInstaller, join(cacheDirectory, 'candidate.exe'), 'file')
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)

      await expect(subject.stage(candidate(next, nextBytes))).rejects.toThrow('cache is not a private regular file')
      await expect(readFile(outsideInstaller)).resolves.toEqual(nextBytes)
    } finally {
      await unlink(join(cacheDirectory, 'candidate.exe')).catch(() => undefined)
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a link-shaped update journal instead of interpreting its target as local state', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const journal = join(storageDirectory, 'native-updates', 'pending-native-update.json')
    const outsideJournal = join(outside, 'pending-native-update.json')
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      await subject.stage(candidate(next, nextBytes))
      await rm(journal, { force: true })
      await writeFile(outsideJournal, '{"schemaVersion":1}\n')
      await symlink(outsideJournal, journal, 'file')

      await expect(subject.beginDashboardHealthCheck('1.0.0')).rejects.toThrow('journal cannot be read')
      await expect(readFile(outsideJournal, 'utf8')).resolves.toBe('{"schemaVersion":1}\n')
    } finally {
      await unlink(journal).catch(() => undefined)
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('unlinks a link-shaped cached artifact instead of recursively removing its target', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const staged = candidate(next, nextBytes)
    const cachePath = join(storageDirectory, 'native-updates', next.sha256)
    const sentinel = join(outside, 'must-not-change.txt')
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      await subject.stage(staged)
      await rm(cachePath, { recursive: true, force: true })
      await writeFile(sentinel, 'outside bytes')
      await symlink(outside, cachePath, directoryLinkType())

      await subject.cleanup(staged)

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('outside bytes')
      await expect(lstat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('leaves an unexpected nested link in place rather than recursively traversing its target during cleanup', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
    const outside = await mkdtemp(join(tmpdir(), 'harness-native-update-outside-'))
    const currentBytes = Buffer.from('stable-1.0.0')
    const nextBytes = Buffer.from('candidate-1.1.0')
    const current = artifact('1.0.0', currentBytes)
    const next = artifact('1.1.0', nextBytes)
    const staged = candidate(next, nextBytes)
    const nestedLink = join(storageDirectory, 'native-updates', next.sha256, 'unexpected')
    const sentinel = join(outside, 'must-not-change.txt')
    try {
      const subject = await adapter(storageDirectory, '1.0.0', current, currentBytes)
      await subject.stage(staged)
      await writeFile(sentinel, 'outside bytes')
      await symlink(outside, nestedLink, directoryLinkType())

      await subject.cleanup(staged)

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('outside bytes')
      expect((await lstat(nestedLink)).isSymbolicLink()).toBe(true)
    } finally {
      await unlink(nestedLink).catch(() => undefined)
      await rm(storageDirectory, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** @returns a directory link type that exercises Windows reparse points and POSIX directory links. */
function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

/** Model a later candidate launch without reusing this test runner's live process identity. */
async function markCandidateAsExited(storageDirectory: string): Promise<void> {
  const path = join(storageDirectory, 'native-updates', 'pending-native-update.json')
  const journal = JSON.parse(await readFile(path, 'utf8')) as {
    candidateProcess: { processId: number }
  }
  await writeFile(path, `${JSON.stringify({
    ...journal,
    candidateProcess: { ...journal.candidateProcess, processId: process.pid + 1 },
  })}\n`)
}

/** Model a process identifier that was recycled after the candidate Main stopped. */
async function markCandidateWithRecycledStart(storageDirectory: string): Promise<void> {
  const path = join(storageDirectory, 'native-updates', 'pending-native-update.json')
  const journal = JSON.parse(await readFile(path, 'utf8')) as {
    candidateProcess: { startedBeforeMs: number }
  }
  await writeFile(path, `${JSON.stringify({
    ...journal,
    candidateProcess: { ...journal.candidateProcess, startedBeforeMs: journal.candidateProcess.startedBeforeMs + 1 },
  })}\n`)
}
