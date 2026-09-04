/** Installed native update acceptance through the detached rollback worker on each release runner. */

import { expect, test } from '@playwright/test'
import { extractFile } from '@electron/asar'
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { type ChildProcess } from 'node:child_process'
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import { createRuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import {
  canonicalizeSignedUpdateManifest,
  parseReleaseUpdateConfiguration,
  releaseManifestEndpointKey,
  releaseRollbackManifestEndpointKey,
  type SignedUpdateManifest,
  type UpdateArtifact,
  type UpdateManifestPayload,
} from '@harness-desktop/dsh-update-policy'
import {
  prepareNativeUpdateWindowsInstallation,
  type NativeUpdateWindowsInstallation,
} from './support/installed-artifact-fixture.ts'
import { launchDesktopExecutableRuntimeFixture, type DesktopRuntimeFixture } from './support/runtime-fixture.ts'
import { exactWindowsTestProcessIds, runBoundedTestCommand } from './support/bounded-test-command.ts'
import { candidateLaunchObserved } from './support/native-candidate-evidence.ts'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const nativeUpdateRootPrefix = 'harness-desktop-native-update-e2e-'
const candidateVersion = '1.0.1'
// The stable artifact is rebuilt with the current source as a test identity; it is not the published v1.0.0 tag.
const stableVersion = '1.0.0'
const healthTimeoutMs = 30_000
const windowsObservedHealthTimeoutMs = 120_000
const nativeWorkerReadyTimeoutMs = 300_000
const nativeHandoffTimeoutMs = nativeWorkerReadyTimeoutMs + 30_000
const nativeRollbackSettlementTimeoutMs = 900_000
const nativeUpdateE2eTimeoutMs = 1_800_000
const windowsTarget: NativeUpdateTarget = {
  platform: 'win32',
  arch: 'x64',
  format: 'nsis',
  artifactExtension: 'exe',
}

test.describe('native update handoff observation', () => {
  test('keeps launcher stage diagnostics disabled unless independently opted in', () => {
    const previous = process.env.DSH_NATIVE_UPDATE_STAGE_PROBE
    try {
      Reflect.deleteProperty(process.env, 'DSH_NATIVE_UPDATE_STAGE_PROBE')
      expect(buildEnvironment({ DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS: '1' }).DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS).toBeUndefined()
      process.env.DSH_NATIVE_UPDATE_STAGE_PROBE = '1'
      expect(buildEnvironment({}).DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS).toBe('1')
      expect(nativeUpdateStageSummary([
        'native-update-stage-readiness-marker-33333333-3333-4333-8333-333333333333.json',
        'native-update-stage-prepare-33333333-3333-4333-8333-333333333333.json',
        'native-update-stage-readiness-image-33333333-3333-4333-8333-333333333333.json',
        'native-update-stage-prepare-not-an-identity.json',
      ])).toBe('prepare>readiness-image>readiness-marker')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'DSH_NATIVE_UPDATE_STAGE_PROBE')
      else process.env.DSH_NATIVE_UPDATE_STAGE_PROBE = previous
    }
  })

  test('reports a Runtime installation failure that arrives before delayed handoff', async () => {
    const failure = Promise.reject(new Error('native update e2e: Runtime recorded an installation failure before handoff'))
    await expect(raceNativeHandoffAndFailure(async () => {
      await delay(25)
      return 'handoff'
    }, failure)).rejects.toThrow('Runtime recorded an installation failure before handoff')
  })

  test('distinguishes candidate replacement, identity heartbeat, and later recovery', () => {
    expect(classifyNativeCandidateStage({
      installed: 'candidate', heartbeat: false, applied: false, failure: 'absent',
    })).toBe('candidate-replaced-before-heartbeat')
    expect(classifyNativeCandidateStage({
      installed: 'candidate', heartbeat: true, applied: false, failure: 'absent',
    })).toBe('candidate-launched-before-applied')
    expect(classifyNativeCandidateStage({
      installed: 'stable', heartbeat: true, applied: false, failure: 'watching-candidate',
    })).toBe('recovery-after-candidate-launch')
  })

  test('identifies only processes whose APPIMAGE exactly names the isolated AppImage', async () => {
    const appImagePath = '/tmp/harness-desktop-native-update-linux-probe/Harness Desktop.AppImage'
    const environments = new Map<number, Uint8Array | undefined>([
      [101, Buffer.from(`APPIMAGE=${appImagePath}\0CHILD=renderer\0`, 'utf8')],
      [102, Buffer.from(`APPIMAGE=${appImagePath}.previous\0`, 'utf8')],
      [103, Buffer.from(`OTHER=APPIMAGE=${appImagePath}\0`, 'utf8')],
      [104, undefined],
      [105, Buffer.from(`APPIMAGE=${appImagePath}\0`, 'utf8')],
    ])
    const liveStat = `101 (Harness Desktop) ${['S', ...Array<string>(18).fill('0'), '101'].join(' ')}`
    const zombieStat = `105 (Harness Desktop) ${['Z', ...Array<string>(18).fill('0'), '105'].join(' ')}`

    await expect(exactLinuxAppImageProcessIds(appImagePath, {
      async listProcessIds() { return ['101', '102', '103', '104', '105', 'not-a-process'] },
      async readEnvironment(processId) { return environments.get(processId) },
      async readStat(processId) { return processId === 105 ? zombieStat : processId === 101 ? liveStat : undefined },
    })).resolves.toEqual([101])
  })

  test('requires the exact Linux AppImage path below its isolated temporary root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-desktop-native-update-linux-'))
    try {
      await expect(assertOwnedLinuxAppImagePath(join(root, 'Harness Desktop.AppImage'))).resolves.toBeUndefined()
      await expect(assertOwnedLinuxAppImagePath(join(root, 'other.AppImage'))).rejects.toThrow('refusing Linux AppImage cleanup outside its owned temporary root')
      await expect(assertOwnedLinuxAppImagePath(join(tmpdir(), 'not-owned', 'Harness Desktop.AppImage'))).rejects.toThrow('refusing Linux AppImage cleanup outside its owned temporary root')
    } finally {
      await removeOwnedNativeInstallationRoot(root, 'linux')
    }
  })

  test('rejects a reused or zombie Linux PID before cleanup sends SIGKILL', () => {
    const reference = { processId: 101, startTicks: '12345' }
    expect(isSameLiveLinuxProcess(reference, { state: 'S', startTicks: '12345' })).toBe(true)
    expect(isSameLiveLinuxProcess(reference, { state: 'S', startTicks: '12346' })).toBe(false)
    expect(isSameLiveLinuxProcess(reference, { state: 'Z', startTicks: '12345' })).toBe(false)
    expect(isSameLiveLinuxProcess(reference, undefined)).toBe(false)
  })

  test('stops a mounted Linux AppImage process that keeps the exact outer APPIMAGE path', async () => {
    test.skip(process.platform !== 'linux', 'requires Linux procfs')
    const root = await mkdtemp(join(tmpdir(), 'harness-desktop-native-update-linux-'))
    const appImagePath = join(root, 'Harness Desktop.AppImage')
    const child = execa(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      env: { ...process.env, APPIMAGE: appImagePath },
      reject: false,
      windowsHide: true,
    })
    try {
      const processId = child.pid
      if (processId === undefined) throw new Error('native update e2e: Linux AppImage cleanup fixture has no process identifier')
      await expect.poll(() => nativeProcessIsAlive(processId), { timeout: 5_000 }).toBe(true)

      await stopExactPosixProcesses(appImagePath)

      await expect.poll(() => nativeProcessIsAlive(processId), { timeout: 5_000 }).toBe(false)
    } finally {
      child.kill('SIGKILL')
      await child
      await removeOwnedNativeInstallationRoot(root, 'linux')
    }
  })

  test('accepts only one fixed schedule failure stage receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-native-update-stage-'))
    try {
      await mkdir(join(root, 'workers'))
      await writeFile(
        join(root, 'workers', 'native-update-failure-stage-schedule-worker-33333333-3333-4333-8333-333333333333.json'),
        'schedule-worker\n',
        { flag: 'wx', mode: 0o600 },
      )
      await expect(readNativeUpdateFailureStageSummary(root)).resolves.toBe('schedule-worker')
      await writeFile(
        join(root, 'workers', 'native-update-failure-stage-schedule-plan-44444444-4444-4444-8444-444444444444.json'),
        'schedule-plan\n',
        { flag: 'wx', mode: 0o600 },
      )
      await expect(readNativeUpdateFailureStageSummary(root)).resolves.toBe('ambiguous')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts only one fixed candidate worker stage receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-native-update-stage-'))
    try {
      await mkdir(join(root, 'workers'))
      await writeFile(
        join(root, 'workers', 'native-update-worker-stage-candidate-launch-33333333-3333-4333-8333-333333333333.json'),
        'candidate-launch\n',
        { flag: 'wx', mode: 0o600 },
      )
      await expect(readNativeWorkerDiagnosticStageSummary(root)).resolves.toBe('candidate-launch')
      await writeFile(
        join(root, 'workers', 'native-update-worker-stage-candidate-identity-44444444-4444-4444-8444-444444444444.json'),
        'candidate-identity\n',
        { flag: 'wx', mode: 0o600 },
      )
      await expect(readNativeWorkerDiagnosticStageSummary(root)).resolves.toBe('ambiguous')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test.describe('installed Windows native update rollback', () => {
  test.skip(process.platform !== 'win32' || process.env.DSH_RUN_NATIVE_UPDATE_E2E !== '1',
    'requires the Windows release job and its isolated native installer environment')
  test.setTimeout(nativeUpdateE2eTimeoutMs)

  test('restores the retained NSIS release after a candidate never acknowledges Dashboard health', async () => {
    const root = await mkdtemp(join(tmpdir(), nativeUpdateRootPrefix))
    let server: LocalUpdateServer | undefined
    let installation: NativeUpdateWindowsInstallation | undefined
    let fixture: Awaited<ReturnType<NativeUpdateWindowsInstallation['launch']>> | undefined
    let updatesDirectory: string | undefined
    try {
      server = await createLocalUpdateServer(root, windowsTarget)
      const appId = `com.deepseek.harness.native-update-e2e.${randomUUID().replaceAll('-', '')}`
      const policyPath = join(root, 'stable-policy.json')
      await server.writePolicy(policyPath)
      // The valid candidate omits this policy, so it can never attach to the pending journal and acknowledge Dashboard health.
      const candidateInstaller = await buildWindowsInstaller({
        outputDirectory: join(root, 'candidate'),
        appId,
        version: candidateVersion,
      })
      await expect(access(join(root, 'candidate', 'win-unpacked', 'resources', 'update-policy.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      const rollbackInstaller = await buildWindowsInstaller({
        outputDirectory: join(root, 'rollback'),
        appId,
        version: stableVersion,
        updatePolicyPath: policyPath,
      })
      await server.configure({
        candidate: await readFile(candidateInstaller),
        rollback: await readFile(rollbackInstaller),
      })

      installation = await prepareNativeUpdateWindowsInstallation(rollbackInstaller)
      fixture = await installation.launch(buildEnvironment({ NODE_EXTRA_CA_CERTS: server.certificatePath }))
      await expect(fixture.application.evaluate(() => process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS)).resolves
        .toBe(process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1' ? '1' : undefined)
      const desktopMainProcessId = await fixture.application.evaluate(() => process.pid)
      await expect(windowsProcessIsInJob(desktopMainProcessId)).resolves.toBe(true)
      const stateSentinelPath = join(fixture.runtime.harnessHome, 'native-update-state-sentinel.txt')
      const stateSentinel = `${randomUUID()}\n`
      await writeFile(stateSentinelPath, stateSentinel, { flag: 'wx', mode: 0o600 })
      const endpointPath = join(fixture.runtime.harnessHome, 'runtime-endpoint.json')
      const endpointBeforeUpdate = await readFile(endpointPath)
      const appAsarPath = installation.appAsarPath
      await observeNativeExitLifecycle(fixture)
      const pendingHandoff = observePendingNativeApplicationExit(
        fixture, fixture.runtime.platformHome, nativeHandoffTimeoutMs, desktopMainProcessId,
        async () => await installedPackageVersion(appAsarPath),
      )
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
      await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
      await waitForUpdateDownloadRoutes(server, windowsTarget)
      const { pending, handoff, transitions } = await pendingHandoff
      updatesDirectory = pending.updatesDirectory
      expect(handoff).toMatchObject({
        desktopMainAliveAfterExitEvent: false,
        workerParentMatchesDesktop: true,
      })
      const rollback = await waitForCandidateThenStable({
        installation: {
          version: async () => await installedPackageVersion(appAsarPath),
        },
        candidateArtifact: candidateInstaller,
        stableArtifact: rollbackInstaller,
        harnessHome: fixture.runtime.harnessHome,
        pending,
        journalPath: pending.journalPath,
        updatesDirectory: pending.updatesDirectory,
        desktopMainProcessId: handoff.desktopMainProcessId,
        desktopMainAliveAfterExitEvent: handoff.desktopMainAliveAfterExitEvent,
        desktopLifecycleAtExitEvent: handoff.desktopLifecycleAtExitEvent,
        workerParentMatchesDesktop: handoff.workerParentMatchesDesktop,
        transitions,
      })
      expect(rollback).toEqual({
        candidateObserved: true,
        version: stableVersion,
        outcome: 'rolled-back:health-check-failed',
      })
      await expect(readFile(stateSentinelPath, 'utf8')).resolves.toBe(stateSentinel)
      await expect(readFile(endpointPath)).resolves.toEqual(endpointBeforeUpdate)
      expect(server.requestPaths()).toEqual(expect.arrayContaining([...updateRouteNames(windowsTarget)]))
    } finally {
      const failures: unknown[] = []
      if (updatesDirectory !== undefined) {
        await waitForWindowsWorkerSettlement(updatesDirectory, nativeWorkerReadyTimeoutMs)
          .catch((error: unknown) => { failures.push(error) })
      }
      if (installation !== undefined) {
        await stopExactWindowsProcesses(installation.executablePath).catch((error: unknown) => { failures.push(error) })
        await installation.cleanup().catch((error: unknown) => { failures.push(error) })
      }
      if (fixture !== undefined) await fixture.close({ forceRuntimeShutdown: true }).catch((error: unknown) => { failures.push(error) })
      if (server !== undefined) await server.close().catch((error: unknown) => { failures.push(error) })
      await removeOwnedNativeUpdateRoot(root).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'installed Windows native update rollback cleanup failed')
    }
  })

  test('keeps a healthy installed NSIS candidate after the Dashboard acknowledges health', async () => {
    const root = await mkdtemp(join(tmpdir(), nativeUpdateRootPrefix))
    let server: LocalUpdateServer | undefined
    let installation: NativeUpdateWindowsInstallation | undefined
    let fixture: Awaited<ReturnType<NativeUpdateWindowsInstallation['launch']>> | undefined
    let updatesDirectory: string | undefined
    try {
      server = await createLocalUpdateServer(root, windowsTarget)
      const appId = `com.deepseek.harness.native-update-e2e.${randomUUID().replaceAll('-', '')}`
      const policyPath = join(root, 'healthy-policy.json')
      await server.writePolicy(policyPath)
      const candidateInstaller = await buildWindowsInstaller({
        outputDirectory: join(root, 'candidate'),
        appId,
        version: candidateVersion,
        updatePolicyPath: policyPath,
      })
      const stableInstaller = await buildWindowsInstaller({
        outputDirectory: join(root, 'stable'),
        appId,
        version: stableVersion,
        updatePolicyPath: policyPath,
      })
      await server.configure({
        candidate: await readFile(candidateInstaller),
        rollback: await readFile(stableInstaller),
      })

      installation = await prepareNativeUpdateWindowsInstallation(stableInstaller)
      expect(await installedPackageVersion(installation.appAsarPath)).toBe(stableVersion)
      fixture = await installation.launch(buildEnvironment({ NODE_EXTRA_CA_CERTS: server.certificatePath }))
      await expect(fixture.application.evaluate(() => process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS)).resolves
        .toBe(process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1' ? '1' : undefined)
      const desktopMainProcessId = await fixture.application.evaluate(() => process.pid)
      await expect(windowsProcessIsInJob(desktopMainProcessId)).resolves.toBe(true)
      const stateSentinelPath = join(fixture.runtime.harnessHome, 'native-update-state-sentinel.txt')
      const stateSentinel = `${randomUUID()}\n`
      await writeFile(stateSentinelPath, stateSentinel, { flag: 'wx', mode: 0o600 })
      const endpointPath = join(fixture.runtime.harnessHome, 'runtime-endpoint.json')
      const endpointBeforeUpdate = await readFile(endpointPath)
      const appAsarPath = installation.appAsarPath
      await observeNativeExitLifecycle(fixture)
      const pendingHandoff = observePendingNativeApplicationExit(
        fixture, fixture.runtime.platformHome, nativeHandoffTimeoutMs, desktopMainProcessId,
        async () => await installedPackageVersion(appAsarPath),
      )
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
      await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
      await waitForUpdateDownloadRoutes(server, windowsTarget)
      const { pending, handoff, transitions } = await pendingHandoff
      updatesDirectory = pending.updatesDirectory
      expect(handoff).toMatchObject({
        desktopMainAliveAfterExitEvent: false,
        workerParentMatchesDesktop: true,
      })

      await waitForWindowsHealthyCandidate({
        appAsarPath,
        executablePath: installation.executablePath,
        appliedPath: join(pending.updatesDirectory, 'workers', `native-update-applied-${pending.transactionId}.json`),
        transactionId: pending.transactionId,
        harnessHome: fixture.runtime.harnessHome,
        pending,
        transitions,
      })
      await waitForWindowsWorkerSettlement(pending.updatesDirectory)
      await expect(readDiagnosticExitReceipts(pending.updatesDirectory)).resolves.toEqual([])
      expect(fixture.runtime.child.exitCode).toBeNull()
      await expect(readFile(stateSentinelPath, 'utf8')).resolves.toBe(stateSentinel)
      await expect(readFile(endpointPath)).resolves.toEqual(endpointBeforeUpdate)
      expect(server.requestPaths()).toEqual(expect.arrayContaining([...updateRouteNames(windowsTarget)]))
    } finally {
      const failures: unknown[] = []
      if (updatesDirectory !== undefined) {
        await waitForWindowsWorkerSettlement(updatesDirectory, nativeWorkerReadyTimeoutMs)
          .catch((error: unknown) => { failures.push(error) })
      }
      if (installation !== undefined) {
        await stopExactWindowsProcesses(installation.executablePath).catch((error: unknown) => { failures.push(error) })
      }
      if (fixture !== undefined) await fixture.close({ forceRuntimeShutdown: true }).catch((error: unknown) => { failures.push(error) })
      if (installation !== undefined) await installation.cleanup().catch((error: unknown) => { failures.push(error) })
      if (server !== undefined) await server.close().catch((error: unknown) => { failures.push(error) })
      await removeOwnedNativeUpdateRoot(root).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'installed Windows healthy native update cleanup failed')
    }
  })
})

test.describe('installed macOS and Linux native update rollback', () => {
  test.skip(!isUnixNativeUpdateTarget() || process.env.DSH_RUN_NATIVE_UPDATE_E2E !== '1',
    'requires the macOS or Linux release job and its isolated native installer environment')
  test.setTimeout(nativeUpdateE2eTimeoutMs)

  test('restores the retained native release after a candidate never acknowledges Dashboard health', async () => {
    const target = currentUnixNativeUpdateTarget()
    const root = await mkdtemp(join(tmpdir(), nativeUpdateRootPrefix))
    let server: LocalUpdateServer | undefined
    let installation: NativeUpdateUnixInstallation | undefined
    let fixture: DesktopRuntimeFixture | undefined
    try {
      server = await createLocalUpdateServer(root, target)
      const appId = `com.deepseek.harness.native-update-e2e.${randomUUID().replaceAll('-', '')}`
      const policyPath = join(root, 'stable-policy.json')
      await server.writePolicy(policyPath)
      const candidate = await buildNativeArtifacts({
        outputDirectory: join(root, 'candidate'),
        appId,
        version: candidateVersion,
        target,
      })
      const rollback = await buildNativeArtifacts({
        outputDirectory: join(root, 'rollback'),
        appId,
        version: stableVersion,
        target,
        updatePolicyPath: policyPath,
      })
      await server.configure({
        candidate: await readFile(candidate.updateArtifact),
        rollback: await readFile(rollback.updateArtifact),
      })

      installation = await prepareUnixNativeInstallation(target, rollback.installationArtifact)
      const nativeInstallation = installation
      fixture = await nativeInstallation.launch(buildEnvironment({ NODE_EXTRA_CA_CERTS: server.certificatePath }))
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
      await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
      await observeNativeExitLifecycle(fixture)
      await waitForUpdateDownloadRoutes(server, target)
      const desktopMainProcessId = await fixture.application.evaluate(() => process.pid)
      const { pending, handoff } = await observePendingNativeApplicationExit(
        fixture,
        fixture.runtime.platformHome,
        nativeHandoffTimeoutMs,
        desktopMainProcessId,
        async () => await nativeInstallation.version(candidate.updateArtifact, rollback.updateArtifact),
      )
      await waitForCandidateThenStable({
        installation: nativeInstallation,
        candidateArtifact: candidate.updateArtifact,
        stableArtifact: rollback.updateArtifact,
        harnessHome: fixture.runtime.harnessHome,
        journalPath: pending.journalPath,
        updatesDirectory: pending.updatesDirectory,
        desktopMainProcessId: handoff.desktopMainProcessId,
        desktopMainAliveAfterExitEvent: handoff.desktopMainAliveAfterExitEvent,
        desktopLifecycleAtExitEvent: handoff.desktopLifecycleAtExitEvent,
        workerParentMatchesDesktop: handoff.workerParentMatchesDesktop,
      })
      expect(server.requestPaths()).toEqual(expect.arrayContaining([...updateRouteNames(target)]))
    } finally {
      const failures: unknown[] = []
      if (installation !== undefined) await installation.stop().catch((error: unknown) => { failures.push(error) })
      if (fixture !== undefined) await fixture.close({ forceRuntimeShutdown: true }).catch((error: unknown) => { failures.push(error) })
      if (installation !== undefined) await installation.cleanup().catch((error: unknown) => { failures.push(error) })
      if (server !== undefined) await server.close().catch((error: unknown) => { failures.push(error) })
      await removeOwnedNativeUpdateRoot(root).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'installed Unix native update rollback cleanup failed')
    }
  })

  test('keeps a healthy installed native candidate after the Dashboard acknowledges health', async () => {
    const target = currentUnixNativeUpdateTarget()
    const root = await mkdtemp(join(tmpdir(), nativeUpdateRootPrefix))
    let server: LocalUpdateServer | undefined
    let installation: NativeUpdateUnixInstallation | undefined
    let fixture: DesktopRuntimeFixture | undefined
    try {
      server = await createLocalUpdateServer(root, target)
      const appId = `com.deepseek.harness.native-update-e2e.${randomUUID().replaceAll('-', '')}`
      const policyPath = join(root, 'healthy-policy.json')
      await server.writePolicy(policyPath)
      const candidate = await buildNativeArtifacts({
        outputDirectory: join(root, 'candidate'),
        appId,
        version: candidateVersion,
        target,
        updatePolicyPath: policyPath,
      })
      const stable = await buildNativeArtifacts({
        outputDirectory: join(root, 'stable'),
        appId,
        version: stableVersion,
        target,
        updatePolicyPath: policyPath,
      })
      await server.configure({
        candidate: await readFile(candidate.updateArtifact),
        rollback: await readFile(stable.updateArtifact),
      })

      installation = await prepareUnixNativeInstallation(target, stable.installationArtifact)
      const nativeInstallation = installation
      expect(await nativeInstallation.version(candidate.updateArtifact, stable.updateArtifact)).toBe(stableVersion)
      fixture = await nativeInstallation.launch(buildEnvironment({ NODE_EXTRA_CA_CERTS: server.certificatePath }))
      await fixture.page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
      await expect(fixture.page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
      const stateSentinelPath = join(fixture.runtime.harnessHome, 'native-update-state-sentinel.txt')
      const stateSentinel = `${randomUUID()}\n`
      await writeFile(stateSentinelPath, stateSentinel, { flag: 'wx', mode: 0o600 })
      const endpointPath = join(fixture.runtime.harnessHome, 'runtime-endpoint.json')
      const endpointBeforeUpdate = await readFile(endpointPath)
      await observeNativeExitLifecycle(fixture)
      await waitForUpdateDownloadRoutes(server, target)
      const desktopMainProcessId = await fixture.application.evaluate(() => process.pid)
      const { pending } = await observePendingNativeApplicationExit(
        fixture,
        fixture.runtime.platformHome,
        nativeHandoffTimeoutMs,
        desktopMainProcessId,
        async () => await nativeInstallation.version(candidate.updateArtifact, stable.updateArtifact),
      )

      await waitForHealthyCandidate({
        installation: nativeInstallation,
        candidateArtifact: candidate.updateArtifact,
        stableArtifact: stable.updateArtifact,
        appliedPath: join(pending.updatesDirectory, 'workers', `native-update-applied-${pending.transactionId}.json`),
        transactionId: pending.transactionId,
        journalPath: pending.journalPath,
        harnessHome: fixture.runtime.harnessHome,
      })
      expect(fixture.runtime.child.exitCode).toBeNull()
      await expect(readFile(stateSentinelPath, 'utf8')).resolves.toBe(stateSentinel)
      await expect(readFile(endpointPath)).resolves.toEqual(endpointBeforeUpdate)
      expect(server.requestPaths()).toEqual(expect.arrayContaining([...updateRouteNames(target)]))
    } finally {
      const failures: unknown[] = []
      if (installation !== undefined) await installation.stop().catch((error: unknown) => { failures.push(error) })
      if (fixture !== undefined) await fixture.close({ forceRuntimeShutdown: true }).catch((error: unknown) => { failures.push(error) })
      if (installation !== undefined) await installation.cleanup().catch((error: unknown) => { failures.push(error) })
      if (server !== undefined) await server.close().catch((error: unknown) => { failures.push(error) })
      await removeOwnedNativeUpdateRoot(root).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'installed Unix healthy native update cleanup failed')
    }
  })
})

interface BuildWindowsInstallerOptions {
  readonly outputDirectory: string
  readonly appId: string
  readonly version: string
  readonly updatePolicyPath?: string
}

interface NativeUpdateTarget {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly arch: 'x64' | 'universal'
  readonly format: 'nsis' | 'zip' | 'appimage'
  readonly artifactExtension: 'exe' | 'zip' | 'AppImage'
}

interface BuildNativeArtifactsOptions {
  readonly outputDirectory: string
  readonly appId: string
  readonly version: string
  readonly target: NativeUpdateTarget
  readonly updatePolicyPath?: string
}

interface NativeUpdateArtifacts {
  readonly installationArtifact: string
  readonly updateArtifact: string
}

interface NativeUpdateUnixInstallation {
  readonly executablePath: string
  launch(environment: Readonly<Record<string, string>>): Promise<DesktopRuntimeFixture>
  version(candidateArtifact: string, stableArtifact: string): Promise<string>
  stop(): Promise<void>
  cleanup(): Promise<void>
}

interface NativeUpdateVersionInspection {
  version(candidateArtifact: string, stableArtifact: string): Promise<string>
}

/** Build an unsigned, test-identity NSIS installer without reading a production signing configuration. */
async function buildWindowsInstaller(options: BuildWindowsInstallerOptions): Promise<string> {
  const environment = buildEnvironment({
    DSH_DESKTOP_SIGNING_MODE: 'disabled',
    DSH_DESKTOP_UPDATE_POLICY: options.updatePolicyPath,
    // The test installer is authenticated by its locally signed manifest, not compression.
    // Electron Builder reads this documented 7z override before the generic config field.
    ELECTRON_BUILDER_COMPRESSION_LEVEL: '0',
  })
  const result = await execa('pnpm', [
    'exec',
    'electron-builder',
    '--config', 'electron-builder.config.mjs',
    '--win', 'nsis',
    '--publish', 'never',
    `--config.directories.output=${options.outputDirectory}`,
    `-c.appId=${options.appId}`,
    `-c.extraMetadata.version=${options.version}`,
  ], {
    cwd: desktopRoot,
    env: environment,
    reject: false,
    windowsHide: true,
  })
  if (result.exitCode !== 0) {
    throw new Error(`native update e2e: ${options.version} installer build exited ${String(result.exitCode)}`)
  }
  const installers = (await readdir(options.outputDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name === `Harness Desktop Setup ${options.version}.exe`)
  if (installers.length !== 1) {
    throw new Error(`native update e2e: expected one ${options.version} NSIS installer, found ${String(installers.length)}`)
  }
  if (options.updatePolicyPath !== undefined) {
    const policy = parseReleaseUpdateConfiguration(
      JSON.parse(await readFile(join(options.outputDirectory, 'win-unpacked', 'resources', 'update-policy.json'), 'utf8')) as unknown,
      productMetadata.appId,
    )
    expect(policy).toMatchObject({ schemaVersion: 3, nativeWorkerReadyTimeoutMs })
  }
  return join(options.outputDirectory, installers[0]!.name)
}

/** Build the two native files used by the macOS and Linux installed-update transactions. */
async function buildNativeArtifacts(options: BuildNativeArtifactsOptions): Promise<NativeUpdateArtifacts> {
  const environment = buildEnvironment({
    DSH_DESKTOP_SIGNING_MODE: 'disabled',
    DSH_DESKTOP_UPDATE_POLICY: options.updatePolicyPath,
  })
  const targetArguments = options.target.platform === 'darwin'
    ? ['--mac', 'dmg', 'zip']
    : ['--linux', 'AppImage']
  const result = await execa('pnpm', [
    'exec',
    'electron-builder',
    '--config', 'electron-builder.config.mjs',
    ...targetArguments,
    '--publish', 'never',
    `--config.directories.output=${options.outputDirectory}`,
    `-c.appId=${options.appId}`,
    `-c.extraMetadata.version=${options.version}`,
  ], {
    cwd: desktopRoot,
    env: environment,
    reject: false,
    windowsHide: true,
  })
  if (result.exitCode !== 0) {
    throw new Error(`native update e2e: ${options.version} ${options.target.platform} build exited ${String(result.exitCode)}`)
  }
  if (options.target.platform === 'darwin') {
    return {
      installationArtifact: await exactlyOneNativeArtifact(
        options.outputDirectory,
        `Harness Desktop-${options.version}-universal.dmg`,
      ),
      updateArtifact: await exactlyOneNativeArtifact(
        options.outputDirectory,
        `Harness Desktop-${options.version}-universal-mac.zip`,
      ),
    }
  }
  const appImage = await exactlyOneNativeArtifact(options.outputDirectory, `Harness Desktop-${options.version}.AppImage`)
  return { installationArtifact: appImage, updateArtifact: appImage }
}

async function exactlyOneNativeArtifact(directory: string, name: string): Promise<string> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name === name)
  if (entries.length !== 1 || entries[0] === undefined) {
    throw new Error(`native update e2e: expected one ${name}, found ${String(entries.length)}`)
  }
  return join(directory, entries[0].name)
}

function isUnixNativeUpdateTarget(): boolean {
  return process.platform === 'darwin' || (process.platform === 'linux' && process.arch === 'x64')
}

function currentUnixNativeUpdateTarget(): NativeUpdateTarget {
  if (process.platform === 'darwin') {
    return { platform: 'darwin', arch: 'universal', format: 'zip', artifactExtension: 'zip' }
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { platform: 'linux', arch: 'x64', format: 'appimage', artifactExtension: 'AppImage' }
  }
  throw new Error(`native update e2e: unsupported Unix runner ${process.platform}/${process.arch}`)
}

/** Prepare one writable macOS application bundle or AppImage at an exact test-owned path. */
async function prepareUnixNativeInstallation(
  target: NativeUpdateTarget,
  artifact: string,
): Promise<NativeUpdateUnixInstallation> {
  const root = await mkdtemp(join(tmpdir(), `harness-desktop-native-update-${target.platform}-`))
  try {
    if (target.platform === 'darwin') return await prepareMacNativeInstallation(root, artifact)
    if (target.platform === 'linux') return await prepareLinuxNativeInstallation(root, artifact)
    throw new Error('native update e2e: Windows installation must use NSIS')
  } catch (error) {
    if (target.platform === 'darwin' || target.platform === 'linux') {
      await removeOwnedNativeInstallationRoot(root, target.platform)
    }
    throw error
  }
}

async function prepareMacNativeInstallation(root: string, dmg: string): Promise<NativeUpdateUnixInstallation> {
  const mount = join(root, 'mount')
  const applications = join(root, 'Applications')
  const bundle = join(applications, 'Harness Desktop.app')
  await mkdir(mount)
  await mkdir(applications)
  let attached = false
  try {
    await execa('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { reject: true })
    attached = true
    await cp(await findMacApplication(mount), bundle, { recursive: true })
  } finally {
    if (attached) await execa('hdiutil', ['detach', mount], { reject: true })
  }
  const executablePath = join(bundle, 'Contents', 'MacOS', 'harness-desktop')
  const appAsarPath = join(bundle, 'Contents', 'Resources', 'app.asar')
  await access(executablePath)
  await access(appAsarPath)
  return {
    executablePath,
    async launch(environment) {
      return await launchDesktopExecutableRuntimeFixture({ executablePath, cwd: root, environment })
    },
    async version() { return await installedPackageVersion(appAsarPath) },
    async stop() { await stopExactPosixProcesses(executablePath) },
    async cleanup() {
      await stopExactPosixProcesses(executablePath)
      await removeOwnedNativeInstallationRoot(root, 'darwin')
    },
  }
}

async function findMacApplication(directory: string): Promise<string> {
  const found: string[] = []
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 2) return
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const path = join(current, entry.name)
      if (entry.name.endsWith('.app')) {
        found.push(path)
        continue
      }
      await visit(path, depth + 1)
    }
  }
  await visit(directory, 0)
  const application = found[0]
  if (found.length !== 1 || application === undefined) {
    throw new Error(`native update e2e: expected exactly one macOS application bundle, found ${String(found.length)}`)
  }
  return application
}

async function prepareLinuxNativeInstallation(root: string, appImage: string): Promise<NativeUpdateUnixInstallation> {
  const executablePath = join(root, 'Harness Desktop.AppImage')
  await copyFile(appImage, executablePath)
  await chmod(executablePath, 0o755)
  return {
    executablePath,
    async launch(environment) {
      return await launchDesktopExecutableRuntimeFixture({ executablePath, cwd: root, environment })
    },
    async version(candidateArtifact, stableArtifact) {
      const current = sha256(await readFile(executablePath))
      if (current === sha256(await readFile(candidateArtifact))) return candidateVersion
      if (current === sha256(await readFile(stableArtifact))) return stableVersion
      throw new Error('native update e2e: installed AppImage differs from both authenticated releases')
    },
    async stop() { await stopExactPosixProcesses(executablePath) },
    async cleanup() {
      await stopExactPosixProcesses(executablePath)
      await removeOwnedNativeInstallationRoot(root, 'linux')
    },
  }
}

/** Keep all production release variables except the test-controlled public policy and disabled signing mode. */
function buildEnvironment(overrides: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
      && entry[0] !== 'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS'
      && entry[0] !== 'DSH_NATIVE_UPDATE_STAGE_PROBE',
  ))
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS') continue
    if (value === undefined) Reflect.deleteProperty(environment, key)
    else environment[key] = value
  }
  if (process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1') environment.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS = '1'
  return environment
}

interface LocalUpdateServer {
  readonly certificatePath: string
  writePolicy(path: string): Promise<void>
  configure(artifacts: { readonly candidate: Uint8Array; readonly rollback: Uint8Array }): Promise<void>
  requestPaths(): readonly string[]
  close(): Promise<void>
}

/** Start a loopback-only HTTPS source whose private key never leaves the test-owned temporary directory. */
async function createLocalUpdateServer(root: string, target: NativeUpdateTarget): Promise<LocalUpdateServer> {
  const certificatePath = join(root, 'loopback-cert.pem')
  const privateKeyPath = join(root, 'loopback-key.pem')
  await createLoopbackCertificate(certificatePath, privateKeyPath)
  const certificate = await readFile(certificatePath)
  const privateKey = await readFile(privateKeyPath)
  const signingKey = generateKeyPairSync('ed25519')
  const publicKey = signingKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const requests: string[] = []
  let origin = ''
  let candidateManifest: SignedUpdateManifest | undefined
  let rollbackManifest: SignedUpdateManifest | undefined
  let candidateRollbackManifest: SignedUpdateManifest | undefined
  let candidateBytes: Uint8Array | undefined
  let rollbackBytes: Uint8Array | undefined
  const server = createServer({ cert: certificate, key: privateKey }, (request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname
    requests.push(path)
    if (path === '/candidate-manifest.json' && candidateManifest !== undefined) {
      writeJson(response, candidateManifest)
      return
    }
    if (path === '/rollback-manifest.json' && rollbackManifest !== undefined) {
      writeJson(response, rollbackManifest)
      return
    }
    if (path === '/candidate-rollback-manifest.json' && candidateRollbackManifest !== undefined) {
      writeJson(response, candidateRollbackManifest)
      return
    }
    if (path === `/candidate.${target.artifactExtension}` && candidateBytes !== undefined) {
      writeBytes(response, candidateBytes)
      return
    }
    if (path === `/rollback.${target.artifactExtension}` && rollbackBytes !== undefined) {
      writeBytes(response, rollbackBytes)
      return
    }
    response.writeHead(404, { 'cache-control': 'no-store' })
    response.end()
  })
  const port = await listenLoopback(server)
  origin = `https://127.0.0.1:${String(port)}`
  return {
    certificatePath,
    async writePolicy(path) {
      const candidateTarget = {
        channel: 'stable' as const,
        consumer: 'desktop' as const,
        platform: target.platform,
        arch: target.arch,
        format: target.format,
      }
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 3,
        applicationId: productMetadata.appId,
        trust: { allowedOrigins: [origin], publicKeys: { 'native-update-e2e': publicKey } },
        healthCheckTimeoutMs: target.platform === 'win32' ? windowsObservedHealthTimeoutMs : healthTimeoutMs,
        nativeWorkerReadyTimeoutMs,
        manifestEndpoints: {
          [releaseManifestEndpointKey(candidateTarget)]: `${origin}/candidate-manifest.json`,
        },
        rollbackManifestEndpoints: {
          [releaseRollbackManifestEndpointKey({ ...candidateTarget, currentVersion: stableVersion })]: `${origin}/rollback-manifest.json`,
          [releaseRollbackManifestEndpointKey({ ...candidateTarget, currentVersion: candidateVersion })]: `${origin}/candidate-rollback-manifest.json`,
        },
      })}\n`, { mode: 0o600 })
    },
    async configure(artifacts) {
      candidateBytes = artifacts.candidate
      rollbackBytes = artifacts.rollback
      candidateManifest = signedManifest(signingKey.privateKey, candidateVersion, {
        consumer: 'desktop',
        platform: target.platform,
        arch: target.arch,
        format: target.format,
        url: `${origin}/candidate.${target.artifactExtension}`,
        sha256: sha256(candidateBytes),
        members: [`candidate.${target.artifactExtension}`],
      })
      rollbackManifest = signedManifest(signingKey.privateKey, stableVersion, {
        consumer: 'desktop',
        platform: target.platform,
        arch: target.arch,
        format: target.format,
        url: `${origin}/rollback.${target.artifactExtension}`,
        sha256: sha256(rollbackBytes),
        members: [`rollback.${target.artifactExtension}`],
      })
      candidateRollbackManifest = signedManifest(signingKey.privateKey, candidateVersion, {
        consumer: 'desktop',
        platform: target.platform,
        arch: target.arch,
        format: target.format,
        url: `${origin}/candidate.${target.artifactExtension}`,
        sha256: sha256(candidateBytes),
        members: [`candidate.${target.artifactExtension}`],
      })
    },
    requestPaths: () => [...requests],
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
      })
    },
  }
}

/** Generate an ephemeral certificate with the exact loopback IP subject alternative name required by Node TLS. */
async function createLoopbackCertificate(certificatePath: string, privateKeyPath: string): Promise<void> {
  const openssl = await findOpenSsl()
  const result = await execa(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
    '-days', '1',
  ], { reject: false, windowsHide: true })
  if (result.exitCode !== 0) throw new Error('native update e2e: loopback certificate generation failed')
}

async function findOpenSsl(): Promise<string> {
  const candidates = process.platform === 'win32'
    ? [
      process.env.DSH_NATIVE_UPDATE_E2E_OPENSSL,
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'openssl.exe'),
    ]
    : [
      process.env.DSH_NATIVE_UPDATE_E2E_OPENSSL,
      '/usr/bin/openssl',
      '/opt/homebrew/opt/openssl@3/bin/openssl',
    ]
  for (const candidate of candidates) {
    if (candidate !== undefined && await access(candidate).then(() => true, () => false)) return candidate
  }
  throw new Error('native update e2e: OpenSSL is required to create a loopback-only test certificate')
}

function signedManifest(key: KeyObject, version: string, artifact: UpdateArtifact): SignedUpdateManifest {
  const payload: UpdateManifestPayload = {
    schemaVersion: 1,
    applicationId: productMetadata.appId,
    channel: 'stable',
    version,
    artifacts: [artifact],
  }
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId: 'native-update-e2e',
      value: sign(null, canonicalizeSignedUpdateManifest(payload), key).toString('base64url'),
    },
  }
}

function writeJson(response: import('node:http').ServerResponse, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(bytes)
}

function writeBytes(response: import('node:http').ServerResponse, bytes: Uint8Array): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/octet-stream',
  })
  response.end(bytes)
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('native update e2e: loopback HTTPS server did not expose a TCP port')
  return address.port
}

function updateRouteNames(target: NativeUpdateTarget): readonly string[] {
  return [
    '/candidate-manifest.json',
    '/rollback-manifest.json',
    `/candidate.${target.artifactExtension}`,
    `/rollback.${target.artifactExtension}`,
  ]
}

async function waitForUpdateDownloadRoutes(server: LocalUpdateServer, target: NativeUpdateTarget): Promise<void> {
  await expect.poll(() => updateRouteNames(target).every(path => server.requestPaths().includes(path)), { timeout: 90_000 }).toBe(true)
}

/** Observe authenticated replacement bytes and the stable Desktop's persisted rollback outcome. */
async function waitForCandidateThenStable(options: {
  readonly installation: NativeUpdateVersionInspection
  readonly candidateArtifact: string
  readonly stableArtifact: string
  readonly harnessHome: string
  readonly pending?: PendingNativeUpdateEvidence
  readonly journalPath: string
  readonly updatesDirectory: string
  readonly desktopMainProcessId: number
  readonly desktopMainAliveAfterExitEvent: boolean
  readonly desktopLifecycleAtExitEvent: string
  readonly workerParentMatchesDesktop: boolean | undefined
  readonly transitions?: NativeTransitionRecorder
}): Promise<{
  readonly candidateObserved: true
  readonly version: typeof stableVersion
  readonly outcome: 'rolled-back:health-check-failed'
}> {
  const client = await createRuntimeConnector({ input: { env: { HARNESS_HOME: options.harnessHome } } }).connect({ start: false })
  const deadline = Date.now() + nativeRollbackSettlementTimeoutMs
  let candidateObserved = false
  let lastVersion = 'unreadable'
  let lastOutcome = 'none'
  try {
    while (Date.now() < deadline) {
      await options.transitions?.record(options.pending)
      const version = await options.installation.version(options.candidateArtifact, options.stableArtifact).catch(() => undefined)
      if (version !== undefined) lastVersion = version
      const transactionHeartbeat = options.pending === undefined
        ? false
        : (await readNativeTransactionMarkers(options.pending)).heartbeat
      candidateObserved = candidateLaunchObserved({
        candidateVersion,
        installedVersion: version,
        previouslyObserved: candidateObserved,
        transactionHeartbeat,
      })
      const outcome = await client.getDesktopUpdateLastOutcome().catch(() => undefined)
      lastOutcome = nativeUpdateOutcomeSummary(outcome)
      const failurePhase = process.platform === 'win32'
        ? await readNativeWorkerFailurePhase(options.updatesDirectory)
        : undefined
      if (failurePhase !== undefined) {
        if (options.pending === undefined || options.transitions === undefined) {
          throw new Error('native update e2e: Windows transition observation is unavailable')
        }
        await options.transitions.record(options.pending, undefined, true)
        await waitForWindowsWorkerSettlement(options.updatesDirectory, nativeWorkerReadyTimeoutMs)
        throw new Error(
          `native update e2e: Windows watchdog failed during ${failurePhase}; transitions=${options.transitions.summary()}`,
        )
      }
      if (candidateObserved && version === stableVersion && isRolledBackOutcome(outcome)) {
        if (process.platform === 'win32') {
          if (options.pending === undefined || options.transitions === undefined) {
            throw new Error('native update e2e: Windows transition observation is unavailable')
          }
          await options.transitions.record(options.pending, undefined, true)
          await waitForWindowsWorkerSettlement(options.updatesDirectory)
          await expect(readDiagnosticExitReceipts(options.updatesDirectory)).resolves.toEqual([])
        }
        return { candidateObserved: true, version: stableVersion, outcome: 'rolled-back:health-check-failed' }
      }
      await delay(100)
    }
  } finally {
    await client.close()
  }
  const [phase, workerState] = await Promise.all([
    readNativeUpdatePhase(options.journalPath),
    readNativeWorkerState(options.updatesDirectory),
  ])
  const workerParentMatchesDesktop = await workerParentMatchesDesktopProcess(
    options.updatesDirectory,
    options.desktopMainProcessId,
  )
  if (process.platform === 'win32') {
    if (options.pending === undefined || options.transitions === undefined) {
      throw new Error('native update e2e: Windows transition observation is unavailable')
    }
    await options.transitions.record(options.pending, undefined, true)
    await waitForWindowsWorkerSettlement(options.updatesDirectory, nativeWorkerReadyTimeoutMs)
  }
  throw new Error(
    `native update e2e: did not observe candidate replacement followed by stable Dashboard rollback settlement; candidate-observed=${String(candidateObserved)}; version=${lastVersion}; outcome=${lastOutcome}; journal=${phase ?? 'unreadable'}; workers=${workerState}; worker-parent-matches-desktop=${String(workerParentMatchesDesktop)}; worker-parent-matched-at-handoff=${String(options.workerParentMatchesDesktop)}; main-alive-after-exit-event=${String(options.desktopMainAliveAfterExitEvent)}; lifecycle=${options.desktopLifecycleAtExitEvent}; transitions=${options.transitions?.summary() ?? 'not-collected'}`,
  )
}

/** Return only the fixed persisted outcome fields safe to include in an E2E failure. */
function nativeUpdateOutcomeSummary(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'none'
  const kind = (value as { readonly kind?: unknown }).kind
  const code = (value as { readonly code?: unknown }).code
  if (typeof kind !== 'string' || typeof code !== 'string'
    || !/^[a-z-]{1,64}$/u.test(kind) || !/^[a-z-]{1,64}$/u.test(code)) return 'unreadable'
  return `${kind}:${code}`
}

function isRolledBackOutcome(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { readonly version?: unknown }).version === candidateVersion
    && (value as { readonly kind?: unknown }).kind === 'rolled-back'
    && (value as { readonly code?: unknown }).code === 'health-check-failed'
    && (value as { readonly lastKnownGoodVersion?: unknown }).lastKnownGoodVersion === stableVersion
}

interface PendingNativeUpdateEvidence {
  readonly transactionId: string
  readonly updatesDirectory: string
  readonly journalPath: string
}

interface NativeTransitionRecorder {
  record(
    pending: PendingNativeUpdateEvidence | undefined,
    workerState?: Awaited<ReturnType<typeof windowsWorkerProcessState>>,
    force?: boolean,
  ): Promise<void>
  summary(): string
}

type NativeCandidateEvidenceStage =
  | 'before-candidate-replacement'
  | 'candidate-replaced-before-heartbeat'
  | 'candidate-launched-before-applied'
  | 'candidate-applied'
  | 'recovery-after-candidate-launch'

function classifyNativeCandidateStage(evidence: {
  readonly installed: 'stable' | 'candidate' | 'unreadable'
  readonly heartbeat: boolean
  readonly applied: boolean
  readonly failure: string
}): NativeCandidateEvidenceStage {
  if (evidence.installed === 'candidate' && evidence.applied) return 'candidate-applied'
  if (evidence.heartbeat) {
    if (evidence.installed === 'stable' || evidence.failure !== 'absent') {
      return 'recovery-after-candidate-launch'
    }
    return 'candidate-launched-before-applied'
  }
  if (evidence.installed === 'candidate') return 'candidate-replaced-before-heartbeat'
  return 'before-candidate-replacement'
}

/** Retain only distinct redacted transition tuples, never generated identities or paths. */
function createNativeTransitionRecorder(options: {
  readonly fixture: DesktopRuntimeFixture
  readonly harnessHome: string
  readonly desktopMainProcessId: number
  readonly installedVersion: () => Promise<string>
}): NativeTransitionRecorder {
  const transitions: string[] = []
  let lastSampleAt = 0
  let sampling: Promise<void> | undefined
  const record = async (
    pending: PendingNativeUpdateEvidence | undefined,
    workerState?: Awaited<ReturnType<typeof windowsWorkerProcessState>>,
    force = false,
  ): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastSampleAt < 500) return
    if (sampling !== undefined) {
      await sampling
      return
    }
    lastSampleAt = now
    sampling = (async () => {
      const [phase, state, outcome, failure, version, markers] = await Promise.all([
        pending === undefined ? Promise.resolve(undefined) : readNativeUpdatePhase(pending.journalPath),
        pending === undefined || process.platform !== 'win32'
          ? Promise.resolve(undefined)
          : workerState === undefined
            ? windowsWorkerProcessState(pending.updatesDirectory)
            : Promise.resolve(workerState),
        readNativeUpdateOutcome(options.harnessHome),
        pending === undefined || process.platform !== 'win32'
          ? Promise.resolve(undefined)
          : readNativeWorkerFailurePhase(pending.updatesDirectory),
        options.installedVersion().catch(() => 'unreadable'),
        pending === undefined
          ? Promise.resolve({ heartbeat: false, applied: false })
          : readNativeTransactionMarkers(pending),
      ])
      const tuple = [
        (() => {
          const installed = version === candidateVersion
            ? 'candidate'
            : version === stableVersion ? 'stable' : 'unreadable'
          return `candidate-stage:${classifyNativeCandidateStage({
            installed,
            heartbeat: markers.heartbeat,
            applied: markers.applied,
            failure: failure ?? 'absent',
          })}`
        })(),
        `phase:${phase ?? 'absent'}`,
        `worker:${state === undefined ? 'absent' : `${String(state.supervisors)}/${String(state.scripts)}/${state.supervisorRunning ? 'live' : 'stopped'}/${state.scriptRunning ? 'live' : 'stopped'}`}`,
        `main:${nativeProcessIsAlive(options.desktopMainProcessId) ? 'alive' : 'exited'}`,
        `outcome:${outcome}`,
        `failure:${failure ?? 'absent'}`,
        `heartbeat:${markers.heartbeat ? 'present' : 'absent'}`,
        `applied:${markers.applied ? 'present' : 'absent'}`,
        `installed:${version === candidateVersion ? 'candidate' : version === stableVersion ? 'stable' : 'unreadable'}`,
      ].join(',')
      if (transitions.at(-1) !== tuple && transitions.length < 16) transitions.push(tuple)
    })().finally(() => { sampling = undefined })
    await sampling
  }
  return { record, summary: () => transitions.join(' -> ') || 'none' }
}

async function readNativeTransactionMarkers(pending: PendingNativeUpdateEvidence): Promise<{
  readonly heartbeat: boolean
  readonly applied: boolean
}> {
  const workers = join(pending.updatesDirectory, 'workers')
  const heartbeatPath = join(workers, `native-update-heartbeat-${pending.transactionId}.json`)
  const appliedPath = join(workers, `native-update-applied-${pending.transactionId}.json`)
  const [heartbeat, applied] = await Promise.all([
    readFile(heartbeatPath, 'utf8').then(value => new RegExp(
      process.platform === 'win32'
        ? `^${pending.transactionId}:[0-9a-f]{32}:[0-9]{1,16}\\n$`
        : `^${pending.transactionId}:[0-9]{1,16}\\n$`, 'u',
    ).test(value)).catch(() => false),
    readFile(appliedPath, 'utf8').then(value => value === `${pending.transactionId}\n`).catch(() => false),
  ])
  return { heartbeat, applied }
}

/** Find the one Main-owned native journal below the isolated test profile before the stable process exits. */
async function waitForPendingNativeUpdate(
  platformHome: string,
  signal?: AbortSignal,
): Promise<PendingNativeUpdateEvidence> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('native update e2e: native handoff observation was cancelled')
    const journals = await findNamedFiles(platformHome, 'pending-native-update.json')
    if (journals.length > 1) throw new Error(`native update e2e: found ${String(journals.length)} pending native journals`)
    const journalPath = journals[0]
    if (journalPath !== undefined) {
      const value = await readFile(journalPath, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined)
      if (isPendingNativeUpdateEvidence(value)) {
        return { transactionId: value.transactionId, updatesDirectory: dirname(journalPath), journalPath }
      }
    }
    await delay(25)
  }
  throw new Error('native update e2e: pending native update journal was not published below the isolated profile')
}

async function findNamedFiles(root: string, filename: string): Promise<readonly string[]> {
  const matches: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name === filename) matches.push(path)
    }
  }
  return matches
}

function isPendingNativeUpdateEvidence(value: unknown): value is { readonly transactionId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const transactionId = (value as { readonly transactionId?: unknown }).transactionId
  return typeof transactionId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(transactionId)
}

interface NativeExitLifecycleEvidence {
  beforeQuit: number
  willQuit: number
  quit: number
  openWindows: number
  releaseNativeExit: boolean
}

/** Observe Main shutdown and hold the final Windows exit until the real private handoff is externally visible. */
async function observeNativeExitLifecycle(fixture: DesktopRuntimeFixture): Promise<void> {
  await fixture.application.evaluate(({ app }) => {
    const state = globalThis as typeof globalThis & {
      __HARNESS_NATIVE_UPDATE_EXIT_E2E__?: NativeExitLifecycleEvidence
    }
    const evidence: NativeExitLifecycleEvidence = {
      beforeQuit: 0,
      willQuit: 0,
      quit: 0,
      openWindows: 0,
      releaseNativeExit: process.platform !== 'win32',
    }
    state.__HARNESS_NATIVE_UPDATE_EXIT_E2E__ = evidence
    app.on('before-quit', (event) => {
      evidence.beforeQuit += 1
      if (!evidence.releaseNativeExit) event.preventDefault()
    })
    app.on('will-quit', () => { evidence.willQuit += 1 })
    app.on('quit', () => { evidence.quit += 1 })
  })
}

/** Release only the test-owned final-exit hold after production readiness and live process ownership are observed. */
async function releaseNativeExit(fixture: DesktopRuntimeFixture): Promise<void> {
  await fixture.application.evaluate(({ app }) => {
    const state = globalThis as typeof globalThis & {
      __HARNESS_NATIVE_UPDATE_EXIT_E2E__?: NativeExitLifecycleEvidence
    }
    const evidence = state.__HARNESS_NATIVE_UPDATE_EXIT_E2E__
    if (evidence === undefined) throw new Error('native update e2e: native exit observation is unavailable')
    evidence.releaseNativeExit = true
    app.quit()
  })
}

/** The first before-quit event occurs only after production worker readiness publishes the native exit action. */
async function nativeExitHasStarted(fixture: DesktopRuntimeFixture): Promise<boolean> {
  return await fixture.application.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __HARNESS_NATIVE_UPDATE_EXIT_E2E__?: NativeExitLifecycleEvidence
    }
    return (state.__HARNESS_NATIVE_UPDATE_EXIT_E2E__?.beforeQuit ?? 0) > 0
  })
}

/** Wait for native handoff and report only redacted state that distinguishes worker readiness from Main shutdown. */
async function waitForNativeApplicationExit(
  fixture: DesktopRuntimeFixture,
  pending: PendingNativeUpdateEvidence,
  timeoutMs: number,
  knownDesktopMainProcessId?: number,
  transitions?: NativeTransitionRecorder,
  signal?: AbortSignal,
): Promise<{
  readonly desktopMainProcessId: number
  readonly desktopMainAliveAfterExitEvent: boolean
  readonly desktopLifecycleAtExitEvent: string
  readonly workerParentMatchesDesktop: boolean | undefined
}> {
  const desktopMainProcessId = knownDesktopMainProcessId
    ?? await fixture.application.evaluate(() => process.pid)
  let workerParentMatchesDesktop: boolean | undefined
  if (process.platform === 'win32') {
    const handoffDeadline = Date.now() + timeoutMs
    const remainingHandoffMs = (): number => Math.max(1, handoffDeadline - Date.now())
    try {
      await expect.poll(
        async () => {
          if (signal?.aborted === true) throw new Error('native update e2e: native handoff observation was cancelled')
          const state = await windowsWorkerProcessState(pending.updatesDirectory)
          await transitions?.record(pending, state)
          return state
        },
        { timeout: Math.min(nativeWorkerReadyTimeoutMs, remainingHandoffMs()) },
      ).toEqual({
        supervisors: 1,
        scripts: 1,
        supervisorRunning: true,
        scriptRunning: true,
      })
      // Main exits only after the worker's policy-bounded readiness checks settle.
      await expect.poll(async () => {
        if (signal?.aborted === true) throw new Error('native update e2e: native handoff observation was cancelled')
        return await nativeExitHasStarted(fixture)
      }, { timeout: remainingHandoffMs() }).toBe(true)
      await expect(readDiagnosticExitReceipts(pending.updatesDirectory)).resolves.toEqual([])
      workerParentMatchesDesktop = await workerParentMatchesDesktopProcess(
        pending.updatesDirectory,
        desktopMainProcessId,
      )
    } finally {
      await releaseNativeExit(fixture)
    }
  } else {
    workerParentMatchesDesktop = await workerParentMatchesDesktopProcess(
      pending.updatesDirectory,
      desktopMainProcessId,
    )
  }
  let observedWorkerState = await readNativeWorkerState(pending.updatesDirectory)
  let observedLifecycle = await readNativeExitLifecycle(fixture)
  let readingWorkerState = false
  const workerStateSampler = setInterval(() => {
    if (readingWorkerState) return
    readingWorkerState = true
    void readNativeWorkerState(pending.updatesDirectory).then((state) => {
      observedWorkerState = state
    }).finally(() => { readingWorkerState = false })
  }, 1_000)
  const lifecycleSampler = setInterval(() => {
    void readNativeExitLifecycle(fixture).then((state) => {
      if (state !== 'unavailable') observedLifecycle = state
    })
  }, 1_000)
  const cancellationWait = waitForObservationCancellation(signal)
  try {
    await Promise.race([
      waitForChildExit(fixture.application.process(), timeoutMs),
      cancellationWait.promise,
    ])
    await transitions?.record(pending)
    return {
      desktopMainProcessId,
      desktopMainAliveAfterExitEvent: nativeProcessIsAlive(desktopMainProcessId),
      desktopLifecycleAtExitEvent: observedLifecycle,
      workerParentMatchesDesktop,
    }
  } catch (error) {
    const [phase, workerState, exitState, outcome] = await Promise.all([
      readNativeUpdatePhase(pending.journalPath),
      readNativeWorkerState(pending.updatesDirectory),
      readNativeExitLifecycle(fixture),
      readNativeUpdateOutcome(fixture.runtime.harnessHome),
    ])
    const message = error instanceof Error ? error.message : 'native update e2e: initial stable process did not exit for native installation'
    throw new Error(`${message}; journal=${phase ?? 'unreadable'}; workers=${workerState}; worker-observed=${observedWorkerState}; outcome=${outcome}; lifecycle=${exitState}`)
  } finally {
    cancellationWait.dispose()
    clearInterval(workerStateSampler)
    clearInterval(lifecycleSampler)
  }
}

function waitForObservationCancellation(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>
  dispose(): void
} {
  let rejectCancellation: ((error: Error) => void) | undefined
  const onAbort = (): void => {
    rejectCancellation?.(new Error('native update e2e: native handoff observation was cancelled'))
  }
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose() { signal?.removeEventListener('abort', onAbort) },
  }
}

/** Start observing the short-lived private handoff as soon as Main publishes its native journal. */
async function observePendingNativeApplicationExit(
  fixture: DesktopRuntimeFixture,
  platformHome: string,
  timeoutMs: number,
  desktopMainProcessId: number,
  installedVersion: () => Promise<string>,
): Promise<{
  readonly pending: PendingNativeUpdateEvidence
  readonly handoff: Awaited<ReturnType<typeof waitForNativeApplicationExit>>
  readonly transitions: NativeTransitionRecorder
}> {
  const failureObservation = observeNativeInstallFailure(fixture.runtime.harnessHome)
  const transitions = createNativeTransitionRecorder({
    fixture,
    harnessHome: fixture.runtime.harnessHome,
    desktopMainProcessId,
    installedVersion,
  })
  const cancellation = new AbortController()
  let pending: PendingNativeUpdateEvidence | undefined
  let handoffFlight: Promise<{
    readonly pending: PendingNativeUpdateEvidence
    readonly handoff: Awaited<ReturnType<typeof waitForNativeApplicationExit>>
    readonly transitions: NativeTransitionRecorder
  }> | undefined
  try {
    await transitions.record(undefined)
    return await raceNativeHandoffAndFailure(async () => {
      handoffFlight = (async () => {
        pending = await waitForPendingNativeUpdate(platformHome, cancellation.signal)
        await transitions.record(pending)
        const handoff = await waitForNativeApplicationExit(
          fixture, pending, timeoutMs, desktopMainProcessId, transitions, cancellation.signal,
        )
        return { pending, handoff, transitions }
      })()
      return await handoffFlight
    }, failureObservation.promise)
  } catch (error) {
    cancellation.abort()
    await handoffFlight?.catch(() => undefined)
    await transitions.record(pending, undefined, true)
    if (process.platform === 'win32' && pending !== undefined) {
      await waitForWindowsWorkerSettlement(pending.updatesDirectory, nativeWorkerReadyTimeoutMs)
    }
    const reason = error instanceof Error
      && error.message === 'native update e2e: Runtime recorded an installation failure before Main exited'
      ? error.message
      : 'native update e2e: native handoff observation failed'
    const stage = process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1' && pending !== undefined
      ? await readNativeUpdateStageSummary(pending.updatesDirectory)
      : undefined
    const failureStage = process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1' && pending !== undefined
      ? await readNativeUpdateFailureStageSummary(pending.updatesDirectory)
      : undefined
    throw new Error(`${reason}${stage === undefined ? '' : `; stage=${stage}`}${failureStage === undefined ? '' : `; failure-stage=${failureStage}`}; transitions=${transitions.summary()}`)
  } finally {
    failureObservation.stop()
  }
}

/** Check a locally observed Main process without exposing its identifier in a diagnostic. */
function nativeProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Read one journal phase without returning cache paths, digests, or process identifiers to the test report. */
async function readNativeUpdatePhase(journalPath: string): Promise<string | undefined> {
  const journal = await readFile(journalPath, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined)
  if (typeof journal !== 'object' || journal === null || Array.isArray(journal)) return undefined
  const phase = (journal as { readonly phase?: unknown }).phase
  return typeof phase === 'string' && /^[a-z-]{1,64}$/u.test(phase) ? phase : undefined
}

/** Summarize private worker files by type without exposing their generated identities. */
async function readNativeWorkerState(updatesDirectory: string): Promise<string> {
  const entries = await readdir(join(updatesDirectory, 'workers'), { withFileTypes: true }).catch(() => [])
  const names = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  return [
    `ready:${String(names.filter(name => name.startsWith('native-rollback-ready-')).length)}`,
    `plans:${String(names.filter(name => name.startsWith('native-rollback-plan-')).length)}`,
    `scripts:${String(names.filter(name => name.startsWith('native-rollback-worker-')).length)}`,
    `supervisors:${String(names.filter(name => name.startsWith('native-update-supervisor-')).length)}`,
    `rollback-snapshots:${String(names.filter(name => name.startsWith('native-rollback-installer-')).length)}`,
    `candidate-snapshots:${String(names.filter(name => name.startsWith('native-candidate-installer-')).length)}`,
    `heartbeats:${String(names.filter(name => name.startsWith('native-update-heartbeat-')).length)}`,
    `applied:${String(names.filter(name => name.startsWith('native-update-applied-')).length)}`,
    `failures:${String(names.filter(name => name.startsWith('native-rollback-failure-')).length)}`,
    `stages:${nativeUpdateStageSummary(names)}`,
  ].join(',')
}

const nativeUpdateDiagnosticStages = [
  'prepare',
  'bridge-create',
  'bridge-identity',
  'readiness-image',
  'readiness-marker',
  'cancellation-proof',
] as const

/** Return only fixed launcher stages from diagnostic receipt names, discarding their generated identities. */
function nativeUpdateStageSummary(names: readonly string[]): string {
  const observed = new Set<string>()
  const receiptPattern = new RegExp(
    '^native-update-stage-(prepare|bridge-create|bridge-identity|readiness-image|readiness-marker|cancellation-proof)'
      + '-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$',
    'iu',
  )
  for (const name of names) {
    const stage = name.match(receiptPattern)?.[1]
    if (stage !== undefined) observed.add(stage.toLowerCase())
  }
  return nativeUpdateDiagnosticStages.filter(stage => observed.has(stage)).join('>') || 'none'
}

/** Read only fixed stage names from the test-owned private worker directory. */
async function readNativeUpdateStageSummary(updatesDirectory: string): Promise<string> {
  const entries = await readdir(join(updatesDirectory, 'workers'), { withFileTypes: true }).catch(() => [])
  return nativeUpdateStageSummary(entries.filter(entry => entry.isFile()).map(entry => entry.name))
}

/** Read one opt-in schedule failure receipt while discarding its generated identity and unknown residue. */
async function readNativeUpdateFailureStageSummary(updatesDirectory: string): Promise<string> {
  const workersDirectory = join(updatesDirectory, 'workers')
  const entries = await readdir(workersDirectory, { withFileTypes: true }).catch(() => [])
  const matches = entries.filter(entry => entry.isFile() && entry.name.startsWith('native-update-failure-stage-'))
  if (matches.length === 0) return 'none'
  if (matches.length !== 1 || matches[0] === undefined) return 'ambiguous'
  const match = matches[0].name.match(new RegExp([
    '^native-update-failure-stage-(stage-existing|stage-rollback|stage-candidate|stage-retained|stage-journal|',
    'schedule-validation|schedule-journal|schedule-plan|schedule-worker)-',
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$',
  ].join(''), 'iu'))
  if (match?.[1] === undefined) return 'ambiguous'
  const path = join(workersDirectory, matches[0].name)
  const metadata = await lstat(path).catch(() => undefined)
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64) return 'ambiguous'
  const value = await readFile(path, 'utf8').catch(() => undefined)
  return value === `${match[1].toLowerCase()}\n` ? match[1].toLowerCase() : 'ambiguous'
}

/** Read one opt-in candidate worker stage without returning its worker identifier or private path. */
async function readNativeWorkerDiagnosticStageSummary(updatesDirectory: string): Promise<string> {
  const workersDirectory = join(updatesDirectory, 'workers')
  const entries = await readdir(workersDirectory, { withFileTypes: true }).catch(() => [])
  const matches = entries.filter(entry => entry.isFile() && entry.name.startsWith('native-update-worker-stage-'))
  if (matches.length === 0) return 'none'
  if (matches.length !== 1 || matches[0] === undefined) return 'ambiguous'
  const match = matches[0].name.match(new RegExp([
    '^native-update-worker-stage-(candidate-installer|candidate-launch|candidate-identity|candidate-heartbeat|',
    'candidate-heartbeat-written)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-',
    '[0-9a-f]{12}\\.json$',
  ].join(''), 'iu'))
  if (match?.[1] === undefined) return 'ambiguous'
  const path = join(workersDirectory, matches[0].name)
  const metadata = await lstat(path).catch(() => undefined)
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64) return 'ambiguous'
  const value = await readFile(path, 'utf8').catch(() => undefined)
  return value === `${match[1].toLowerCase()}\n` ? match[1].toLowerCase() : 'ambiguous'
}

/** Observe only whether diagnostic-only supervisor receipts exist without reading their contents or generated names. */
async function readDiagnosticExitReceipts(updatesDirectory: string): Promise<readonly 'present'[]> {
  const workersDirectory = join(updatesDirectory, 'workers')
  const entries = await readdir(workersDirectory, { withFileTypes: true }).catch(() => [])
  const receipts = entries.filter(entry => !entry.isDirectory()
    && /^native-update-exit-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(entry.name))
  return receipts.map(() => 'present')
}

/** Read only the fixed worker failure phase, discarding its generated worker identity. */
async function readNativeWorkerFailurePhase(updatesDirectory: string): Promise<string | undefined> {
  const workersDirectory = join(updatesDirectory, 'workers')
  const entries = await readdir(workersDirectory, { withFileTypes: true }).catch(() => [])
  const failures = entries.filter(entry => entry.isFile()
    && /^native-rollback-failure-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(entry.name))
  if (failures.length === 0) return undefined
  if (failures.length !== 1 || failures[0] === undefined) {
    throw new Error('native update e2e: multiple Windows watchdog failures were recorded')
  }
  const path = join(workersDirectory, failures[0].name)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128) {
    throw new Error('native update e2e: Windows watchdog failure record is invalid')
  }
  const value = await readFile(path, 'utf8')
  const match = value.match(new RegExp(
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:'
      + '(validating|snapshotting-rollback|snapshotting-candidate|waiting-parent|watching-candidate|rolling-back)\\n$',
    'iu',
  ))
  if (match?.[1] === undefined) throw new Error('native update e2e: Windows watchdog failure record is invalid')
  return match[1].toLowerCase()
}

async function waitForWindowsWorkerSettlement(
  updatesDirectory: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect.poll(async () => await windowsWorkerProcessState(updatesDirectory), { timeout: timeoutMs }).toMatchObject({
    supervisorRunning: false,
    scriptRunning: false,
  })
}

async function windowsWorkerProcessState(updatesDirectory: string): Promise<{
  readonly supervisors: number
  readonly scripts: number
  readonly supervisorRunning: boolean
  readonly scriptRunning: boolean
}> {
  const workersDirectory = join(updatesDirectory, 'workers')
  const entries = await readdir(workersDirectory, { withFileTypes: true }).catch(() => [])
  const supervisors = entries.filter(entry =>
    entry.isFile() && entry.name.startsWith('native-update-supervisor-') && entry.name.endsWith('.exe'))
  const scripts = entries.filter(entry =>
    entry.isFile() && entry.name.startsWith('native-rollback-worker-') && entry.name.endsWith('.ps1'))
  const supervisorMatches = (await Promise.all(supervisors.map(async entry =>
    await exactWindowsProcessIds(join(workersDirectory, entry.name))))).flat()
  const scriptRunning = await exactWindowsPowerShellScriptCount(scripts.map(entry => join(workersDirectory, entry.name))) > 0
  return {
    supervisors: supervisors.length,
    scripts: scripts.length,
    supervisorRunning: supervisorMatches.length > 0,
    scriptRunning,
  }
}

async function exactWindowsPowerShellScriptCount(scriptPaths: readonly string[]): Promise<number> {
  if (scriptPaths.length === 0) return 0
  const powerShell = windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe')
  const commandLineParser = [
    'using System;',
    'using System.ComponentModel;',
    'using System.Runtime.InteropServices;',
    'public static class HarnessCommandLineParser {',
    '  [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);',
    '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);',
    '  public static string[] Parse(string commandLine) {',
    '    int count; IntPtr arguments = CommandLineToArgvW(commandLine, out count);',
    '    if (arguments == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());',
    '    try { string[] result = new string[count]; for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, index * IntPtr.Size)); return result; }',
    '    finally { LocalFree(arguments); }',
    '  }',
    '}',
  ].join(' ')
  const inspection = [
    `$Source = '${commandLineParser.replaceAll("'", "''")}'`,
    'Add-Type -TypeDefinition $Source',
    '$targets = ([Environment]::GetEnvironmentVariable("DSH_NATIVE_UPDATE_E2E_SCRIPTS") | ConvertFrom-Json)',
    '$expectedPowerShell = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable("DSH_NATIVE_UPDATE_E2E_POWERSHELL"))',
    'function Normalize-Path([string]$value) { $path = [IO.Path]::GetFullPath($value); if ($path.StartsWith("\\\\?\\", [StringComparison]::Ordinal)) { return $path.Substring(4) }; return $path }',
    '$count = 0',
    'foreach ($process in Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq "powershell.exe" }) {',
    '  if (-not $process.ExecutablePath -or -not (Normalize-Path $process.ExecutablePath).Equals((Normalize-Path $expectedPowerShell), [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '  $arguments = [HarnessCommandLineParser]::Parse([string]$process.CommandLine)',
    '  foreach ($target in $targets) {',
    '    for ($index = 0; $index -lt $arguments.Length - 1; $index += 1) {',
    '      if ($arguments[$index] -ieq "-File" -and (Normalize-Path $arguments[$index + 1]).Equals((Normalize-Path ([string]$target)), [StringComparison]::OrdinalIgnoreCase)) { $count += 1; break }',
    '    }',
    '    if ($count -gt 0) { break }',
    '  }',
    '}',
    '[Console]::Out.Write([string]$count)',
  ].join('; ')
  const result = await execa(powerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    inspection,
  ], {
    env: buildEnvironment({
      DSH_NATIVE_UPDATE_E2E_POWERSHELL: powerShell,
      DSH_NATIVE_UPDATE_E2E_SCRIPTS: JSON.stringify(scriptPaths),
    }),
    reject: false,
    windowsHide: true,
  })
  if (result.exitCode !== 0 || result.stderr !== '') throw new Error('native update e2e: worker process inspection failed')
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isSafeInteger(count) ? count : 0
}

/** Check the installed Electron Main's Windows Job membership without exposing its process identifier. */
async function windowsProcessIsInJob(processId: number): Promise<boolean> {
  const source = [
    'using System;',
    'using System.ComponentModel;',
    'using System.Runtime.InteropServices;',
    'public static class HarnessJobMembershipProbe {',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);',
    '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);',
    '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
    '  public static bool Read(int processId) {',
    '    IntPtr process = OpenProcess(0x1000, false, processId);',
    '    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());',
    '    try { bool result; if (!IsProcessInJob(process, IntPtr.Zero, out result)) throw new Win32Exception(Marshal.GetLastWin32Error()); return result; }',
    '    finally { CloseHandle(process); }',
    '  }',
    '}',
  ].join(' ')
  const inspection = [
    `$Source = '${source.replaceAll("'", "''")}'`,
    'Add-Type -TypeDefinition $Source',
    '$ProcessId = [int][Environment]::GetEnvironmentVariable("DSH_NATIVE_UPDATE_E2E_PROCESS")',
    'if ([HarnessJobMembershipProbe]::Read($ProcessId)) { [Console]::Out.Write("in-job") } else { [Console]::Out.Write("outside-job") }',
  ].join('; ')
  const result = await execa(windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspection,
  ], {
    env: buildEnvironment({ DSH_NATIVE_UPDATE_E2E_PROCESS: String(processId) }),
    reject: false,
    windowsHide: true,
  })
  if (result.exitCode !== 0 || result.stderr !== '' || !['in-job', 'outside-job'].includes(result.stdout)) {
    throw new Error('native update e2e: Electron Main Job membership inspection failed')
  }
  return result.stdout === 'in-job'
}

/** Compare the worker's declared Main owner with Playwright's launched Desktop without exposing a process id. */
async function workerParentMatchesDesktopProcess(
  updatesDirectory: string,
  desktopProcessId: number | undefined,
): Promise<boolean | undefined> {
  if (desktopProcessId === undefined) return undefined
  const entries = await readdir(join(updatesDirectory, 'workers'), { withFileTypes: true }).catch(() => [])
  const plans = entries.filter(entry => entry.isFile() && entry.name.startsWith('native-rollback-plan-'))
  if (plans.length !== 1 || plans[0] === undefined) return undefined
  const value = await readFile(join(updatesDirectory, 'workers', plans[0].name), 'utf8')
    .then(text => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const plan = (value as { readonly plan?: unknown }).plan
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return undefined
  const parent = (plan as { readonly parentProcess?: unknown }).parentProcess
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return undefined
  const processId = (parent as { readonly processId?: unknown }).processId
  return typeof processId === 'number' && Number.isSafeInteger(processId) ? processId === desktopProcessId : undefined
}

/** Read only event counts and window count from the still-running original Electron Main process. */
async function readNativeExitLifecycle(fixture: DesktopRuntimeFixture): Promise<string> {
  const evidence = await fixture.application.evaluate(({ BrowserWindow }) => {
    const state = globalThis as typeof globalThis & {
      __HARNESS_NATIVE_UPDATE_EXIT_E2E__?: NativeExitLifecycleEvidence
    }
    const lifecycle = state.__HARNESS_NATIVE_UPDATE_EXIT_E2E__
    return {
      beforeQuit: lifecycle?.beforeQuit ?? -1,
      willQuit: lifecycle?.willQuit ?? -1,
      quit: lifecycle?.quit ?? -1,
      openWindows: BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length,
    }
  }).catch(() => undefined)
  if (evidence === undefined) return 'unavailable'
  return `before-quit:${String(evidence.beforeQuit)},will-quit:${String(evidence.willQuit)},quit:${String(evidence.quit)},windows:${String(evidence.openWindows)}`
}

/** Read the Runtime's redacted terminal result without exposing worker arguments or cache locations. */
async function readNativeUpdateOutcome(harnessHome: string): Promise<string> {
  const client = await createRuntimeConnector({ input: { env: { HARNESS_HOME: harnessHome } } })
    .connect({ start: false }).catch(() => undefined)
  if (client === undefined) return 'unavailable'
  try {
    const outcome = await client.getDesktopUpdateLastOutcome().catch(() => undefined)
    if (outcome === undefined) return 'none'
    return `${outcome.kind}:${outcome.code}`
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** Stop the handoff wait when Runtime records a terminal local installation failure. */
function observeNativeInstallFailure(harnessHome: string): { readonly promise: Promise<never>; stop(): void } {
  let stopped = false
  let reading = false
  let timer: NodeJS.Timeout | undefined
  let rejectFailure: ((error: Error) => void) | undefined
  const poll = (): void => {
    if (stopped || reading) return
    reading = true
    void readNativeUpdateOutcome(harnessHome).then((outcome) => {
      if (outcome === 'failed:install-failed') {
        stopped = true
        if (timer !== undefined) clearInterval(timer)
        rejectFailure?.(new Error('native update e2e: Runtime recorded an installation failure before Main exited'))
      }
    }).finally(() => { reading = false })
  }
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
    timer = setInterval(poll, 1_000)
    poll()
  })
  return {
    promise,
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    },
  }
}

/** Race one exact handoff against the already-running Runtime failure observer. */
async function raceNativeHandoffAndFailure<T>(handoff: () => Promise<T>, failure: Promise<never>): Promise<T> {
  return await Promise.race([handoff(), failure])
}

/** Wait for the worker's transaction-bound applied proof while the exact installed candidate remains alive. */
async function waitForWindowsHealthyCandidate(options: {
  readonly appAsarPath: string
  readonly executablePath: string
  readonly appliedPath: string
  readonly transactionId: string
  readonly harnessHome: string
  readonly pending: PendingNativeUpdateEvidence
  readonly transitions: NativeTransitionRecorder
}): Promise<void> {
  try {
    let healthPhaseObserved = false
    await expect.poll(async () => {
      await options.transitions.record(options.pending)
      const phase = await readNativeUpdatePhase(options.pending.journalPath)
      if (phase === 'dashboard-health-checking' || phase === 'applied') healthPhaseObserved = true
      const version = await installedPackageVersion(options.appAsarPath).catch(() => undefined)
      const applied = await readFile(options.appliedPath, 'utf8').catch(() => undefined)
      const processIds = await exactWindowsProcessIds(options.executablePath)
      const failurePhase = await readNativeWorkerFailurePhase(dirname(dirname(options.appliedPath)))
      if (failurePhase !== undefined) {
        throw new Error(`native update e2e: Windows watchdog failed during ${failurePhase}`)
      }
      const processAlive = processIds.length > 0
      const appliedMarker = applied === `${options.transactionId}\n`
      const terminalOutcome = await readNativeUpdateOutcome(options.harnessHome)
      const cleanedApplied = healthPhaseObserved && phase === undefined
        && (terminalOutcome === 'applied:applied' || terminalOutcome === 'up-to-date:up-to-date')
      return { version, accepted: version === candidateVersion && processAlive && (appliedMarker || cleanedApplied) }
    }, { timeout: 120_000 }).toMatchObject({
      version: candidateVersion,
      accepted: true,
    })
  } catch {
    await options.transitions.record(options.pending, undefined, true)
    await waitForWindowsWorkerSettlement(options.pending.updatesDirectory, nativeWorkerReadyTimeoutMs)
    const workerStage = process.env.DSH_NATIVE_UPDATE_STAGE_PROBE === '1'
      ? await readNativeWorkerDiagnosticStageSummary(options.pending.updatesDirectory)
      : undefined
    throw new Error(`native update e2e: healthy candidate did not settle${workerStage === undefined ? '' : `; worker-stage=${workerStage}`}; transitions=${options.transitions.summary()}`)
  }
}

/** Wait for the Unix worker proof or terminal Runtime outcome while the authenticated candidate is installed. */
async function waitForHealthyCandidate(options: {
  readonly installation: NativeUpdateUnixInstallation
  readonly candidateArtifact: string
  readonly stableArtifact: string
  readonly appliedPath: string
  readonly transactionId: string
  readonly journalPath: string
  readonly harnessHome: string
}): Promise<void> {
  await expect.poll(async () => {
    const phase = await readNativeUpdatePhase(options.journalPath)
    const version = await options.installation.version(options.candidateArtifact, options.stableArtifact).catch(() => undefined)
    const applied = await readFile(options.appliedPath, 'utf8').catch(() => undefined)
    const processAlive = await candidateProcessAlive(options.journalPath)
    const terminalOutcome = await readNativeUpdateOutcome(options.harnessHome)
    const appliedMarker = applied === `${options.transactionId}\n`
    const cleanedApplied = phase === undefined
      && (terminalOutcome === 'applied:applied' || terminalOutcome === 'up-to-date:up-to-date')
    return {
      version,
      accepted: version === candidateVersion && ((appliedMarker && processAlive) || cleanedApplied),
    }
  }, { timeout: 120_000 }).toMatchObject({
    version: candidateVersion,
    accepted: true,
  })
}

/** Bind the live candidate check to the watchdog journal rather than AppImage's mutable mounted executable. */
async function candidateProcessAlive(journalPath: string): Promise<boolean> {
  const candidate = await readCandidateProcess(journalPath)
  if (candidate === undefined) return false
  if (process.platform === 'linux') {
    return candidate.linuxStartTicks !== undefined
      && await linuxProcessStartTicks(candidate.processId) === candidate.linuxStartTicks
  }
  return (await exactPosixProcessIds(candidate.executablePath)).includes(candidate.processId)
}

interface NativeCandidateProcessEvidence {
  readonly processId: number
  readonly executablePath: string
  readonly linuxStartTicks?: string
}

async function readCandidateProcess(journalPath: string): Promise<NativeCandidateProcessEvidence | undefined> {
  const journal = await readFile(journalPath, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined)
  if (typeof journal !== 'object' || journal === null || Array.isArray(journal)) return undefined
  const candidate = (journal as { readonly candidateProcess?: unknown }).candidateProcess
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const processId = (candidate as { readonly processId?: unknown }).processId
  const executablePath = (candidate as { readonly executablePath?: unknown }).executablePath
  const linuxStartTicks = (candidate as { readonly linuxStartTicks?: unknown }).linuxStartTicks
  if (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId <= 0
    || typeof executablePath !== 'string' || executablePath.length === 0) return undefined
  if (linuxStartTicks !== undefined && (typeof linuxStartTicks !== 'string' || !/^\d{1,32}$/u.test(linuxStartTicks))) return undefined
  return { processId, executablePath, ...(linuxStartTicks === undefined ? {} : { linuxStartTicks }) }
}

async function linuxProcessStartTicks(processId: number): Promise<string | undefined> {
  const identity = await readLinuxProcessIdentity(processId)
  return identity !== undefined && isLiveLinuxProcess(identity) ? identity.startTicks : undefined
}

interface LinuxProcessIdentity {
  readonly state: string
  readonly startTicks: string
}

/** Read the current Linux PID identity; a missing or unreadable proc record has no usable identity. */
async function readLinuxProcessIdentity(
  processId: number,
  readStat: (processId: number) => Promise<string | undefined> = readLinuxProcessStat,
): Promise<LinuxProcessIdentity | undefined> {
  const content = await readStat(processId)
  return content === undefined ? undefined : parseLinuxProcessIdentity(content)
}

/** Parse the Linux process state and start tick fields after a possibly parenthesized command name. */
function parseLinuxProcessIdentity(content: string): LinuxProcessIdentity | undefined {
  const closingParenthesis = content.lastIndexOf(')')
  if (closingParenthesis === -1) return undefined
  const fields = content.slice(closingParenthesis + 1).trim().split(/\s+/u)
  const state = fields[0]
  const startTicks = fields[19]
  if (state === undefined || !/^[A-Za-z]$/u.test(state) || startTicks === undefined || !/^\d{1,32}$/u.test(startTicks)) {
    return undefined
  }
  return { state, startTicks }
}

/** Zombies and dead-task records no longer represent a process that cleanup may terminate. */
function isLiveLinuxProcess(identity: LinuxProcessIdentity): boolean {
  return identity.state !== 'Z' && identity.state !== 'X' && identity.state !== 'x'
}

/** Read a Linux proc stat record without treating normal exit or permission races as test failures. */
async function readLinuxProcessStat(processId: number): Promise<string | undefined> {
  try {
    return await readFile(`/proc/${String(processId)}/stat`, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'ENOENT' || code === 'EPERM') return undefined
    throw error
  }
}

async function installedPackageVersion(asarPath: string): Promise<string> {
  const packageJson = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8')) as { readonly version?: unknown }
  if (typeof packageJson.version !== 'string') throw new Error('native update e2e: installed app.asar omits package version')
  return packageJson.version
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolveExit, rejectExit) => {
    const onExit = (): void => { finish(undefined) }
    const timer = setTimeout(() => { finish(new Error('native update e2e: initial stable process did not exit for native installation')) }, timeoutMs)
    const finish = (error: Error | undefined): void => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      if (error === undefined) resolveExit()
      else rejectExit(error)
    }
    child.once('exit', onExit)
    if (child.exitCode !== null) finish(undefined)
  })
}

/** Return only process identifiers whose OS-reported executable exactly matches the isolated installer destination. */
async function exactWindowsProcessIds(executablePath: string): Promise<readonly number[]> {
  return await exactWindowsTestProcessIds(executablePath, buildEnvironment({}))
}

/** Terminate only children whose executable was independently matched to this temporary installation. */
async function stopExactWindowsProcesses(executablePath: string): Promise<void> {
  const taskkill = windowsSystemTool('taskkill.exe')
  for (const processId of await exactWindowsProcessIds(executablePath)) {
    const result = await runBoundedTestCommand(taskkill, ['/PID', String(processId), '/T', '/F'], {
      failure: 'native update e2e: exact process termination',
    })
    if (result.exitCode !== 0 && (await exactWindowsProcessIds(executablePath)).includes(processId)) {
      throw new Error('native update e2e: could not stop an exact isolated Desktop process')
    }
  }
}

function windowsSystemTool(relativePath: string): string {
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || systemRoot === '') throw new Error('native update e2e: Windows system root is unavailable')
  return join(systemRoot, 'System32', ...relativePath.split('\\'))
}

const nativeProcessStopTimeoutMs = 5_000

interface LinuxAppImageProcessOperations {
  listProcessIds(): Promise<readonly string[]>
  readEnvironment(processId: number): Promise<Uint8Array | undefined>
  readStat(processId: number): Promise<string | undefined>
}

interface LinuxProcessReference {
  readonly processId: number
  readonly startTicks: string
}

const linuxAppImageProcessOperations: LinuxAppImageProcessOperations = {
  async listProcessIds() { return await readdir('/proc') },
  async readEnvironment(processId) {
    try {
      return await readFile(`/proc/${String(processId)}/environ`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'ENOENT' || code === 'EPERM') return undefined
      throw error
    }
  },
  async readStat(processId) { return await readLinuxProcessStat(processId) },
}

/** Terminate and await only macOS/Linux processes independently bound to this test-owned installation. */
async function stopExactPosixProcesses(executablePath: string): Promise<void> {
  if (process.platform === 'linux') {
    await assertOwnedLinuxAppImagePath(executablePath)
    await stopExactLinuxAppImageProcesses(executablePath)
    return
  }
  await stopExactMacProcesses(executablePath)
}

/** Terminate exact macOS processes and wait until their exact command identity disappears. */
async function stopExactMacProcesses(executablePath: string): Promise<void> {
  const deadline = Date.now() + nativeProcessStopTimeoutMs
  for (;;) {
    const processIds = await exactPosixProcessIds(executablePath)
    if (processIds.length === 0) return
    for (const processId of processIds) {
      try {
        process.kill(processId, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('native update e2e: isolated POSIX Desktop process did not stop')
    }
    await delay(25)
  }
}

/** Terminate exact Linux AppImage processes only when their PID start token remains unchanged. */
async function stopExactLinuxAppImageProcesses(executablePath: string): Promise<void> {
  const deadline = Date.now() + nativeProcessStopTimeoutMs
  for (;;) {
    const references = await exactLinuxCleanupProcessReferences(executablePath)
    if (references.length === 0) return
    for (const reference of references) {
      const identity = await readLinuxProcessIdentity(reference.processId)
      if (!isSameLiveLinuxProcess(reference, identity)) continue
      try {
        process.kill(reference.processId, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('native update e2e: isolated Linux AppImage process did not stop')
    }
    await delay(25)
  }
}

/** Return every live Linux process independently tied to the isolated outer AppImage. */
async function exactLinuxCleanupProcessReferences(executablePath: string): Promise<readonly LinuxProcessReference[]> {
  const commandProcessIds = await exactPosixProcessIds(executablePath)
  const commandReferences = await Promise.all(commandProcessIds.map(async processId => await liveLinuxProcessReference(processId)))
  const references = new Map<number, LinuxProcessReference>()
  for (const reference of commandReferences) {
    if (reference !== undefined) references.set(reference.processId, reference)
  }
  for (const reference of await exactLinuxAppImageProcessReferences(executablePath)) {
    references.set(reference.processId, reference)
  }
  return [...references.values()]
}

/** Return only POSIX processes whose command begins with the exact test-owned installed executable. */
async function exactPosixProcessIds(executablePath: string): Promise<readonly number[]> {
  const ps = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps'
  const result = await execa(ps, ['-ax', '-o', 'pid=', '-o', 'args='], { reject: false, windowsHide: true })
  if (result.exitCode !== 0) throw new Error('native update e2e: POSIX process inspection failed')
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u)
    if (match?.[1] === undefined || match[2] === undefined) return []
    if (match[2] !== executablePath && !match[2].startsWith(`${executablePath} `)) return []
    const processId = Number(match[1])
    return Number.isSafeInteger(processId) && processId > 0 ? [processId] : []
  })
}

/** Return only Linux processes whose AppImage runtime retained the exact test-owned outer image path. */
async function exactLinuxAppImageProcessIds(
  executablePath: string,
  operations: LinuxAppImageProcessOperations = linuxAppImageProcessOperations,
): Promise<readonly number[]> {
  return (await exactLinuxAppImageProcessReferences(executablePath, operations)).map(reference => reference.processId)
}

/** Return only live Linux processes whose AppImage runtime retained the exact test-owned outer image path. */
async function exactLinuxAppImageProcessReferences(
  executablePath: string,
  operations: LinuxAppImageProcessOperations = linuxAppImageProcessOperations,
): Promise<readonly LinuxProcessReference[]> {
  const expectedEntry = Buffer.from(`APPIMAGE=${executablePath}`, 'utf8')
  const entries = await operations.listProcessIds()
  const processIds = entries.flatMap((entry) => {
    const processId = Number(entry)
    return Number.isSafeInteger(processId) && processId > 0 && String(processId) === entry ? [processId] : []
  })
  const matches = await Promise.all(processIds.map(async (processId) => {
    const environment = await operations.readEnvironment(processId)
    if (environment === undefined || !hasExactLinuxEnvironmentEntry(environment, expectedEntry)) return undefined
    return await liveLinuxProcessReference(processId, processId => operations.readStat(processId))
  }))
  return matches.flatMap(reference => reference === undefined ? [] : [reference])
}

/** Bind one Linux PID to its current start tick only while its proc state remains live. */
async function liveLinuxProcessReference(
  processId: number,
  readStat: (processId: number) => Promise<string | undefined> = readLinuxProcessStat,
): Promise<LinuxProcessReference | undefined> {
  const identity = await readLinuxProcessIdentity(processId, readStat)
  return identity !== undefined && isLiveLinuxProcess(identity) ? { processId, startTicks: identity.startTicks } : undefined
}

/** Refuse to terminate a PID whose process record changed or became a zombie after discovery. */
function isSameLiveLinuxProcess(
  reference: LinuxProcessReference,
  identity: LinuxProcessIdentity | undefined,
): boolean {
  return identity !== undefined && isLiveLinuxProcess(identity) && identity.startTicks === reference.startTicks
}

/** Compare one NUL-delimited Linux environment entry without exposing any process environment values. */
function hasExactLinuxEnvironmentEntry(environment: Uint8Array, expected: Uint8Array): boolean {
  let start = 0
  while (start < environment.byteLength) {
    const end = environment.indexOf(0, start)
    const entry = environment.subarray(start, end === -1 ? environment.byteLength : end)
    if (entry.byteLength === expected.byteLength && entry.every((value, index) => value === expected[index])) return true
    if (end === -1) return false
    start = end + 1
  }
  return false
}

/** Require the only Linux AppImage path that the installed-update fixture itself creates. */
async function assertOwnedLinuxAppImagePath(executablePath: string): Promise<void> {
  const resolvedExecutablePath = resolve(executablePath)
  const root = dirname(resolvedExecutablePath)
  const expectedPrefix = 'harness-desktop-native-update-linux-'
  const invalidPath = dirname(root) !== resolve(tmpdir())
    || !basename(root).startsWith(expectedPrefix)
    || basename(resolvedExecutablePath) !== 'Harness Desktop.AppImage'
  if (invalidPath) {
    throw new Error('native update e2e: refusing Linux AppImage cleanup outside its owned temporary root')
  }
  const metadata = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('native update e2e: refusing Linux AppImage cleanup outside its owned temporary root')
  }
}

async function removeOwnedNativeInstallationRoot(root: string, platform: 'darwin' | 'linux'): Promise<void> {
  const resolvedRoot = resolve(root)
  const expectedPrefix = `harness-desktop-native-update-${platform}-`
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith(expectedPrefix)) {
    throw new Error(`native update e2e: refusing cleanup outside its owned ${platform} temporary root`)
  }
  const metadata = await lstat(resolvedRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`native update e2e: owned ${platform} temporary root is no longer a directory`)
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

async function removeOwnedNativeUpdateRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root)
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith(nativeUpdateRootPrefix)) {
    throw new Error('native update e2e: refusing cleanup outside its owned temporary root')
  }
  const metadata = await lstat(resolvedRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('native update e2e: owned temporary root is no longer a directory')
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds) })
}
