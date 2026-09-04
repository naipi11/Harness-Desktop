/** Electron-native installation scheduling after Harness policy verification. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DesktopUpdateChannel } from '@harness-desktop/dsh-host-local-runtime'
import {
  verifySignedUpdateManifest,
  type VerifiedUpdateArtifact,
} from '@harness-desktop/dsh-update-policy'
import {
  currentNativeProcessReference,
  isNativeProcessReference,
  nativeUpdateHeartbeatPath,
  type NativeProcessReference,
  type NativeRollbackPlan,
  type NativeUpdateWatchPlan,
} from './native-rollback.ts'
import type { DesktopUpdateSource } from './release-source.ts'
import type { StageAdapter, StagedDesktopCandidate } from './staged-install.ts'

const journalFilename = 'pending-native-update.json'
const journalReplacementRetryDelayMs = 25

/** One settled persisted native-update health state. */
export type NativeUpdateHealth =
  | { readonly kind: 'none' }
  | { readonly kind: 'awaiting-dashboard-health'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'awaiting-worker-commit'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'applied'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'rollback-required'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'recovery-blocked'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'rolled-back'; readonly version: string; readonly channel: DesktopUpdateChannel }

/** Result of scheduling an authorized rollback after the journal is rechecked. */
export type NativeRollbackScheduleResult =
  | { readonly kind: 'rollback-scheduled' }
  | { readonly kind: 'already-applied'; readonly version: string; readonly channel: DesktopUpdateChannel }

/**
 * Decide whether this process may begin a new automatic update check after resolving a prior native transaction.
 * @param health - settled or pending health state for the installed process.
 * @returns false while a watchdog owns the transaction and after this launch restored a failed candidate.
 */
export function mayCheckAutomaticDesktopUpdate(health: NativeUpdateHealth): boolean {
  return health.kind === 'none' || health.kind === 'applied'
}

/** @returns whether a loaded Dashboard must ask the adapter to observe or commit a pending worker transaction. */
export function shouldAcknowledgeDashboardHealth(health: NativeUpdateHealth): boolean {
  return health.kind === 'awaiting-dashboard-health' || health.kind === 'awaiting-worker-commit'
}

/** Inputs for one private native installer staging owner. */
export interface NativeDesktopInstallOptions {
  /** Product identity used to authenticate both the candidate and retained rollback manifest. */
  readonly appId: string
  /** Policy-backed source used only while the service holds a verified candidate. */
  readonly source: DesktopUpdateSource
  /** Private Electron user-data directory; no Runtime or Harness home is used. */
  readonly storageDirectory: string
  /** Current native platform selecting the externally executed verified installer. */
  readonly platform: NodeJS.Platform
  /** Current native CPU target used to select a retained compatible rollback artifact. */
  readonly arch: string
  /** Version that the native updater must retain if the candidate does not become healthy. */
  readonly currentVersion: string
  /** Current packaged executable used only by the detached verified rollback worker. */
  readonly applicationPath: string
  /** Strict Windows candidate launch nonce, injected only by the worker-launched candidate process. */
  readonly candidateLaunchNonce?: string
  /** Current AppImage path when Linux self-update and rollback are enabled. */
  readonly appImagePath?: string
  /** Bounded candidate Dashboard health window used by the detached local watchdog. */
  readonly healthCheckTimeoutMs: number
  /** Bounded local copy-and-hash window before Main may exit into a native installer transition. */
  readonly nativeWorkerReadyTimeoutMs: number
  /** Main-owned restart hook that prevents ordinary shutdown policy from cancelling the native install. */
  readonly requestRestart: (
    plan: NativeRollbackPlan | NativeUpdateWatchPlan,
    workerReadyTimeoutMs: number,
    afterWorkerReady?: () => Promise<void>,
  ) => Promise<void>
}

/** Time and private-file operations that make the cross-process heartbeat deadline deterministic under test. */
export interface NativeInstallHeartbeatOperations {
  /** @returns strictly monotonic milliseconds for the bounded policy deadline. */
  readonly monotonicNow: () => number
  /** @returns epoch milliseconds used only to validate the worker heartbeat timestamp. */
  readonly wallNow: () => number
  /** @param path - transaction heartbeat path under private worker storage. @returns validated text or undefined when absent. */
  readonly read: (path: string) => Promise<string | undefined>
  /** @param milliseconds - bounded interval before the next heartbeat observation. @returns settlement after the interval. */
  readonly delay: (milliseconds: number) => Promise<void>
  /** @returns the unique strict Windows launch nonce from this candidate's argv, or undefined when absent or ambiguous. */
  readonly windowsLaunchNonce?: () => string | undefined
}

interface PendingNativeUpdate {
  readonly schemaVersion: 1
  readonly phase: 'staged' | 'awaiting-dashboard-health' | 'dashboard-health-checking' | 'rollback-scheduled' | 'applied' | 'cleanup-pending'
  readonly transactionId: string
  readonly currentVersion: string
  readonly version: string
  readonly channel: DesktopUpdateChannel
  readonly format: VerifiedUpdateArtifact['format']
  readonly sha256: string
  readonly rollbackFormat: VerifiedUpdateArtifact['format']
  readonly rollbackSha256: string
  readonly candidateProcess?: NativeProcessReference
}

type NativeInstallScheduleFailureStage = 'schedule-validation' | 'schedule-journal' | 'schedule-plan' | 'schedule-worker'
type NativeInstallStagingFailureStage = 'stage-existing' | 'stage-rollback' | 'stage-candidate' | 'stage-retained' | 'stage-journal'
type NativeInstallFailureStage = NativeInstallScheduleFailureStage | NativeInstallStagingFailureStage

type NativeRollbackFailureReason =
  | 'candidate-version-mismatch'
  | 'watchdog-heartbeat-missing'
  | 'candidate-identity-mismatch'
  | 'rollback-version-mismatch'
  | 'applied-heartbeat-missing'

interface NativeRollbackAuthorization {
  readonly transactionId: string
  readonly version: string
  readonly reason: NativeRollbackFailureReason
}

/**
 * Stages verified bytes under Electron user data and hands only fixed local paths to a detached installer worker.
 * The remote URL never reaches an installer, a journal, Runtime settings, or caller results.
 */
export class NativeDesktopInstallAdapter implements StageAdapter {
  private staged: StagedDesktopCandidate | undefined
  private rollback: { readonly artifact: VerifiedUpdateArtifact; readonly bytes: Uint8Array } | undefined
  private pending: PendingNativeUpdate | undefined
  private rollbackAuthorization: NativeRollbackAuthorization | undefined

  /**
   * @param options - source, private staging, and Main-owned restart collaborator.
   * @param heartbeatOperations - monotonic deadline, wall time, private read, and delay collaborators.
   */
  constructor(
    private readonly options: NativeDesktopInstallOptions,
    private readonly heartbeatOperations: NativeInstallHeartbeatOperations = nativeInstallHeartbeatOperations,
  ) {}

  /** @param artifact - verified remote artifact retained only for this private transfer. @returns authenticated bytes. */
  download(artifact: VerifiedUpdateArtifact, signal?: AbortSignal): Promise<Uint8Array> {
    return this.options.source.download(artifact, signal)
  }

  /**
   * Native installer payloads are opaque to Main; the local digest check authenticates their bytes.
   * The release verifier inspects native installer structure before signing, while Main checks that
   * the signed declaration is carried unchanged through staging.
   * @param _bytes - digest-checked candidate bytes.
   * @param artifact - signed release member declaration retained for service consistency checks.
   * @returns the signed declaration without reopening or parsing the opaque installer.
   */
  inspect(_bytes: Uint8Array, artifact: VerifiedUpdateArtifact): Promise<readonly string[]> {
    return Promise.resolve(artifact.members)
  }

  /** @param candidate - verified bytes that become the private native-updater cache. */
  async stage(candidate: StagedDesktopCandidate): Promise<void> {
    let failureStage: NativeInstallStagingFailureStage = 'stage-existing'
    try {
      if (digest(candidate.bytes) !== candidate.artifact.sha256) throw new Error('candidate digest changed before native staging')
      const existing = await this.readJournal()
      if (existing !== undefined) {
        if (existing.phase === 'applied' && await this.wasAppliedObserved(existing)) {
          await this.cleanupPending(existing)
        } else {
          throw new Error('native Desktop update transaction has not settled')
        }
      }
      failureStage = 'stage-rollback'
      const rollback = await this.loadRollbackCandidate(candidate.artifact)
      failureStage = 'stage-candidate'
      await this.stageArtifact(candidate.artifact, candidate.bytes)
      failureStage = 'stage-retained'
      await this.stageArtifact(rollback.artifact, rollback.bytes)
      const pending: PendingNativeUpdate = {
        schemaVersion: 1,
        phase: 'staged',
        transactionId: randomUUID(),
        currentVersion: this.options.currentVersion,
        version: candidate.artifact.version,
        channel: candidate.artifact.channel,
        format: candidate.artifact.format,
        sha256: candidate.artifact.sha256,
        rollbackFormat: rollback.artifact.format,
        rollbackSha256: rollback.artifact.sha256,
      }
      failureStage = 'stage-journal'
      await this.writeJournal(pending)
      this.staged = candidate
      this.rollback = rollback
      this.pending = pending
    } catch (error) {
      await this.writeFailureStage(failureStage)
      throw error
    }
  }

  /** This adapter never launches an untrusted candidate process in the current installation. */
  launchCandidate(): Promise<unknown> {
    return Promise.reject(new Error('native Desktop updates install only through the detached verified worker'))
  }

  /**
   * Arm the detached worker with only verified local artifacts, then request restart.
   * @param candidate - candidate previously persisted by {@link stage}.
   * @returns settlement after the worker validated the local install plan and Main was asked to restart.
   */
  async scheduleInstall(candidate: StagedDesktopCandidate): Promise<void> {
    let failureStage: NativeInstallScheduleFailureStage = 'schedule-validation'
    try {
      if (this.staged !== candidate) throw new Error('native Desktop candidate is not staged')
      const rollback = this.rollback
      if (rollback === undefined) throw new Error('native Desktop rollback artifact is not staged')
      const staged = this.pending
      if (staged === undefined || staged.phase !== 'staged' || staged.sha256 !== candidate.artifact.sha256) {
        throw new Error('native Desktop candidate journal is not staged')
      }
      const awaiting: PendingNativeUpdate = {
        ...staged,
        phase: 'awaiting-dashboard-health',
      }
      failureStage = 'schedule-journal'
      await this.writeJournal(awaiting)
      this.pending = awaiting
      failureStage = 'schedule-plan'
      const plan = await this.watchPlan(candidate, rollback.artifact, awaiting)
      failureStage = 'schedule-worker'
      await this.options.requestRestart(plan, this.options.nativeWorkerReadyTimeoutMs)
    } catch (error) {
      await this.writeFailureStage(failureStage)
      throw error
    }
  }

  /** @param candidate - candidate whose private cache is discarded after a pre-install failure. */
  async restoreRetained(candidate: StagedDesktopCandidate): Promise<void> {
    await this.cleanup(candidate)
  }

  /** @param candidate - optional candidate whose private cache and matching journal are removed. */
  async cleanup(candidate?: StagedDesktopCandidate): Promise<void> {
    const pending = await this.readJournal()
    if (candidate !== undefined) {
      await this.removeCacheDirectory(candidate.artifact.sha256, candidate.artifact.format)
      if (this.rollback !== undefined) await this.removeCacheDirectory(this.rollback.artifact.sha256, this.rollback.artifact.format)
      if (pending?.sha256 === candidate.artifact.sha256) await this.removeJournal()
      if (this.staged === candidate) this.staged = undefined
      this.rollback = undefined
      this.pending = undefined
      return
    }
    if (pending !== undefined) {
      await this.removeCacheDirectory(pending.sha256, pending.format)
      await this.removeCacheDirectory(pending.rollbackSha256, pending.rollbackFormat)
    }
    await this.removeJournal()
    this.staged = undefined
    this.rollback = undefined
    this.pending = undefined
  }

  /**
   * Mark the new process as health-checking before it opens the authenticated Dashboard.
   * @param currentVersion - version reported by the running packaged Desktop binary.
   * @returns whether a previous installer failed, is waiting for health, or requires a retained rollback.
   */
  async beginDashboardHealthCheck(currentVersion: string): Promise<NativeUpdateHealth> {
    this.rollbackAuthorization = undefined
    const pending = await this.readJournal()
    if (pending === undefined) return { kind: 'none' }
    if (pending.phase === 'cleanup-pending') {
      await this.cleanupPending(pending)
      return { kind: 'none' }
    }
    if (pending.phase === 'staged') {
      await this.cleanupPending(pending)
      return { kind: 'none' }
    }
    if (pending.phase === 'awaiting-dashboard-health') {
      if (pending.version !== currentVersion) {
        if (pending.currentVersion !== currentVersion) {
          return this.requireRollback(pending, 'candidate-version-mismatch')
        }
        if (!await this.wasRollbackObserved(pending)) {
          this.pending = pending
          return { kind: 'recovery-blocked', version: pending.version, channel: pending.channel }
        }
        this.pending = pending
        return { kind: 'rolled-back', version: pending.version, channel: pending.channel }
      }
      if (!await this.hasCurrentWatchdogHeartbeat(pending)) {
        return this.requireRollback(pending, 'watchdog-heartbeat-missing')
      }
      const { candidateProcess: _candidateProcess, ...base } = pending
      const checking: PendingNativeUpdate = { ...base, phase: 'dashboard-health-checking', candidateProcess: currentNativeProcessReference() }
      await this.writeJournal(checking)
      this.pending = checking
      return { kind: 'awaiting-dashboard-health', version: pending.version, channel: pending.channel }
    }
    if (pending.phase === 'dashboard-health-checking' && pending.version === currentVersion) {
      if (pending.candidateProcess !== undefined && isCurrentCandidateProcess(pending.candidateProcess)) {
        if (!await this.hasCurrentWatchdogHeartbeat(pending)) {
          return this.requireRollback(pending, 'watchdog-heartbeat-missing')
        }
        this.pending = pending
        return { kind: 'awaiting-dashboard-health', version: pending.version, channel: pending.channel }
      }
      return this.requireRollback(pending, 'candidate-identity-mismatch')
    }
    if (pending.phase === 'rollback-scheduled') {
      if (pending.currentVersion !== currentVersion) return this.requireRollback(pending, 'rollback-version-mismatch')
      if (!await this.wasRollbackObserved(pending)) {
        this.pending = pending
        return { kind: 'recovery-blocked', version: pending.version, channel: pending.channel }
      }
      this.pending = pending
      return { kind: 'rolled-back', version: pending.version, channel: pending.channel }
    }
    if (pending.phase === 'applied' && pending.version === currentVersion) {
      if (await this.wasAppliedObserved(pending)) {
        this.pending = pending
        return { kind: 'applied', version: pending.version, channel: pending.channel }
      }
      if (!await this.hasCurrentWatchdogHeartbeat(pending)) {
        return this.requireRollback(pending, 'applied-heartbeat-missing')
      }
      this.pending = pending
      return { kind: 'awaiting-worker-commit', version: pending.version, channel: pending.channel }
    }
    if (pending.currentVersion === currentVersion && await this.wasRollbackObserved(pending)) {
      this.pending = pending
      return { kind: 'rolled-back', version: pending.version, channel: pending.channel }
    }
    this.pending = pending
    return { kind: 'recovery-blocked', version: pending.version, channel: pending.channel }
  }

  /**
   * Commit a native update only after the authenticated Dashboard completes its readiness path.
   * @param currentVersion - version reported by the ready packaged Desktop binary.
   * @returns applied after the detached worker observes the exact candidate, or a pending state after the bounded health window.
   */
  async acknowledgeDashboardHealth(currentVersion: string): Promise<NativeUpdateHealth> {
    const pending = await this.readJournal()
    if (pending === undefined) return { kind: 'none' }
    if (pending.phase === 'applied' && pending.version === currentVersion) {
      if (await this.waitForAppliedObservation(pending)) {
        this.pending = pending
        return { kind: 'applied', version: pending.version, channel: pending.channel }
      }
      this.pending = pending
      return { kind: 'awaiting-worker-commit', version: pending.version, channel: pending.channel }
    }
    if (pending.phase !== 'dashboard-health-checking' || pending.version !== currentVersion) {
      return { kind: 'rollback-required', version: pending.version, channel: pending.channel }
    }
    const applied: PendingNativeUpdate = { ...pending, phase: 'applied' }
    await this.writeJournal(applied)
    this.pending = applied
    if (await this.waitForAppliedObservation(applied)) {
      return { kind: 'applied', version: pending.version, channel: pending.channel }
    }
    return { kind: 'awaiting-worker-commit', version: pending.version, channel: pending.channel }
  }

  /**
   * Start a fresh detached rollback worker before this failed candidate exits.
   * @returns rollback scheduling, or already-applied after a matching late completion proof is settled and cleaned.
   */
  async scheduleRollback(): Promise<NativeRollbackScheduleResult> {
    const pending = await this.readJournal()
    if (pending === undefined || (pending.phase !== 'awaiting-dashboard-health'
      && pending.phase !== 'dashboard-health-checking' && pending.phase !== 'rollback-scheduled'
      && pending.phase !== 'applied')) {
      throw new Error('native Desktop rollback is not pending')
    }
    const authorization = this.rollbackAuthorization
    if (authorization === undefined || !rollbackAuthorizationMatchesPending(authorization, pending)) {
      throw new Error('native Desktop rollback is not authorized')
    }
    if (pending.phase === 'applied' && await this.wasAppliedObserved(pending)) {
      this.rollbackAuthorization = undefined
      this.pending = pending
      return { kind: 'already-applied', version: pending.version, channel: pending.channel }
    }
    if (pending.version !== this.options.currentVersion) throw new Error('native Desktop rollback candidate version is not current')
    if (!isNativeRollbackFormat(pending.rollbackFormat)) throw new Error('native Desktop rollback artifact format is unsupported')
    const rollbackPath = await this.artifactPath(pending.rollbackSha256, pending.rollbackFormat)
    if (rollbackPath === undefined) throw new Error('native Desktop rollback cache is missing')
    const rollback = await readPrivateFile(rollbackPath, 'native Desktop rollback cache')
    if (digest(rollback) !== pending.rollbackSha256) throw new Error('native Desktop rollback cache digest changed')
    const { candidateProcess: _candidateProcess, ...base } = pending
    const scheduled: PendingNativeUpdate = { ...base, phase: 'rollback-scheduled', candidateProcess: currentNativeProcessReference() }
    const rollbackPlan = await this.rollbackPlan(pending.rollbackSha256, pending.rollbackFormat, pending.transactionId)
    const publishScheduled = async (): Promise<void> => {
      await this.writeJournal(scheduled)
      this.pending = scheduled
    }
    if (this.options.platform === 'win32') {
      await publishScheduled()
      await this.options.requestRestart(rollbackPlan, this.options.nativeWorkerReadyTimeoutMs)
    } else {
      await this.options.requestRestart(rollbackPlan, this.options.nativeWorkerReadyTimeoutMs, publishScheduled)
    }
    return { kind: 'rollback-scheduled' }
  }

  /**
   * Remove a settled native transaction only after Runtime has durably recorded its outcome.
   * A synced `cleanup-pending` journal makes each unlink idempotent after process failure;
   * power-loss durability remains filesystem-defined.
   * @param health - exact applied or rolled-back health returned by this adapter during the current startup.
   * @returns fulfillment after the retained journal, marker, heartbeat, and cached artifacts are removed.
   */
  async finalizeDashboardHealth(health: NativeUpdateHealth): Promise<void> {
    if (health.kind !== 'applied' && health.kind !== 'rolled-back') {
      throw new Error('native Desktop health is not settled')
    }
    const pending = await this.readJournal()
    if (pending === undefined) {
      if (this.pending === undefined) return
      throw new Error('native Desktop settled journal disappeared before finalization')
    }
    if (this.pending?.transactionId !== pending.transactionId
      || pending.version !== health.version || pending.channel !== health.channel) {
      throw new Error('native Desktop settled health does not match the retained journal')
    }
    if (health.kind === 'applied') {
      if (pending.phase !== 'applied' || !await this.wasAppliedObserved(pending)) {
        throw new Error('native Desktop applied health lacks worker completion proof')
      }
    } else if (pending.currentVersion !== this.options.currentVersion) {
      throw new Error('native Desktop rollback health does not match the running version')
    }
    const cleanupPending: PendingNativeUpdate = { ...pending, phase: 'cleanup-pending' }
    await this.writeJournal(cleanupPending)
    this.pending = cleanupPending
    await this.cleanupPending(cleanupPending)
  }

  private requireRollback(pending: PendingNativeUpdate, reason: NativeRollbackFailureReason): NativeUpdateHealth {
    this.rollbackAuthorization = { transactionId: pending.transactionId, version: pending.version, reason }
    return { kind: 'rollback-required', version: pending.version, channel: pending.channel }
  }

  private async watchPlan(
    candidate: StagedDesktopCandidate,
    rollback: VerifiedUpdateArtifact,
    pending: PendingNativeUpdate,
  ): Promise<NativeUpdateWatchPlan> {
    if (!isNativeRollbackFormat(rollback.format)) throw new Error('native Desktop rollback watchdog format is unsupported')
    const rollbackArtifactPath = await this.artifactPath(rollback.sha256, rollback.format)
    const candidateArtifactPath = await this.artifactPath(candidate.artifact.sha256, candidate.artifact.format)
    const journalPath = await this.journalPath()
    await this.workerDirectory(true)
    if (rollbackArtifactPath === undefined || candidateArtifactPath === undefined || journalPath === undefined) {
      throw new Error('native Desktop rollback watchdog cache is missing')
    }
    return {
      schemaVersion: 1,
      platform: nativePlatform(this.options.platform),
      parentProcess: currentNativeProcessReference(),
      applicationPath: this.options.applicationPath,
      rollbackArtifactPath,
      rollbackSha256: rollback.sha256,
      rollbackFormat: rollback.format,
      candidateArtifactPath,
      candidateSha256: candidate.artifact.sha256,
      candidateFormat: nativeRollbackFormat(candidate.artifact.format),
      healthCheckTimeoutMs: this.options.healthCheckTimeoutMs,
      journalPath,
      candidateVersion: candidate.artifact.version,
      transactionId: pending.transactionId,
      ...(this.options.appImagePath === undefined ? {} : { appImagePath: this.options.appImagePath }),
    }
  }

  /** @returns one fixed local plan that restores the retained stable installer after this Main process exits. */
  private async rollbackPlan(sha256: string, format: VerifiedUpdateArtifact['format'], transactionId?: string): Promise<NativeRollbackPlan> {
    if (!isNativeRollbackFormat(format)) throw new Error('native Desktop rollback worker format is unsupported')
    const rollbackArtifactPath = await this.artifactPath(sha256, format)
    if (rollbackArtifactPath === undefined) throw new Error('native Desktop rollback cache is missing')
    await this.workerDirectory(true)
    return {
      schemaVersion: 1,
      platform: nativePlatform(this.options.platform),
      parentProcess: currentNativeProcessReference(),
      applicationPath: this.options.applicationPath,
      rollbackArtifactPath,
      rollbackSha256: sha256,
      rollbackFormat: format,
      healthCheckTimeoutMs: this.options.healthCheckTimeoutMs,
      ...(transactionId === undefined ? {} : { transactionId }),
      ...(this.options.appImagePath === undefined ? {} : { appImagePath: this.options.appImagePath }),
    }
  }

  private async loadRollbackCandidate(
    candidate: VerifiedUpdateArtifact,
  ): Promise<{ readonly artifact: VerifiedUpdateArtifact; readonly bytes: Uint8Array }> {
    const verification = verifySignedUpdateManifest(await this.options.source.loadRollbackManifest(candidate.channel), {
      appId: this.options.appId,
      currentVersion: this.options.currentVersion,
      channel: candidate.channel,
      consumer: 'desktop',
      platform: this.options.platform,
      arch: this.options.arch,
      format: candidate.format,
      versionMode: 'current',
      ...this.options.source.trust,
    })
    if (verification.kind !== 'accepted') throw new Error('retained Desktop rollback manifest was rejected')
    const bytes = await this.options.source.download(verification.artifact)
    if (digest(bytes) !== verification.artifact.sha256) throw new Error('retained Desktop rollback digest was rejected')
    return { artifact: verification.artifact, bytes }
  }

  private async stageArtifact(artifact: VerifiedUpdateArtifact, bytes: Uint8Array): Promise<void> {
    const cacheDirectory = await this.cacheDirectory(artifact.sha256, true)
    if (cacheDirectory === undefined) throw new Error('native Desktop updater cache cannot be created')
    const artifactPath = join(cacheDirectory, artifactFilename(artifact.format))
    const existing = await readPrivateFileIfPresent(artifactPath, 'native Desktop updater cache')
    if (existing !== undefined) {
      if (digest(existing) !== artifact.sha256) throw new Error('native updater cache digest conflicts with this candidate')
      return
    }
    const temporary = `${artifactPath}.staging-${randomUUID()}`
    try {
      await writePrivateFile(temporary, bytes)
      try {
        await link(temporary, artifactPath)
        await syncPrivateDirectory(cacheDirectory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const published = await readPrivateFileIfPresent(artifactPath, 'native Desktop updater cache')
        if (published === undefined || digest(published) !== artifact.sha256) {
          throw new Error('native updater cache digest conflicts with this candidate')
        }
      }
    } finally {
      await removePrivateFile(temporary, 'native Desktop updater temporary')
    }
  }

  private async writeJournal(pending: PendingNativeUpdate): Promise<void> {
    const journal = await this.journalPath(true)
    if (journal === undefined) throw new Error('native Desktop update journal directory cannot be created')
    await assertPrivateRegularFileOrAbsent(journal, 'native Desktop update journal')
    const temporary = `${journal}.staging-${randomUUID()}`
    try {
      await writePrivateFile(temporary, `${JSON.stringify(pending)}\n`)
      await this.replaceJournal(temporary, journal)
      await syncPrivateDirectory(dirname(journal))
    } finally {
      await removePrivateFile(temporary, 'native Desktop update journal temporary')
    }
  }

  private async replaceJournal(temporary: string, journal: string): Promise<void> {
    let deadline: number | undefined
    for (;;) {
      try {
        await rename(temporary, journal)
        return
      } catch (error) {
        if (!isTransientWindowsJournalReplacementError(error)) throw error
        await assertPrivateRegularFile(temporary, 'native Desktop update journal temporary')
        await assertPrivateRegularFileOrAbsent(journal, 'native Desktop update journal')
        deadline ??= this.heartbeatOperations.monotonicNow() + this.options.nativeWorkerReadyTimeoutMs
        const remaining = deadline - this.heartbeatOperations.monotonicNow()
        if (remaining <= 0) throw error
        await this.heartbeatOperations.delay(Math.min(journalReplacementRetryDelayMs, remaining))
      }
    }
  }

  private async readJournal(): Promise<PendingNativeUpdate | undefined> {
    const journal = await this.journalPath(false)
    if (journal === undefined) return undefined
    let text: string
    try {
      text = await readPrivateTextFile(journal, 'native Desktop update journal')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('native Desktop update journal cannot be read')
    }
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      throw new Error('native Desktop update journal is malformed')
    }
    const pending = parsePendingJournal(value)
    if (pending === undefined) throw new Error('native Desktop update journal is invalid')
    return pending
  }

  private async cleanupPending(pending: PendingNativeUpdate): Promise<void> {
    const workers = await this.workerDirectory(false)
    if (workers !== undefined) {
      for (const [name, label] of [
        [`native-update-applied-${pending.transactionId}.json`, 'native Desktop watchdog completion marker'],
        [`native-update-heartbeat-${pending.transactionId}.json`, 'native Desktop watchdog heartbeat'],
        [`native-update-rolled-back-${pending.transactionId}.json`, 'native Desktop watchdog rollback marker'],
      ] as const) {
        const path = join(workers, name)
        if (dirname(path) !== workers) throw new Error(`${label} escapes private storage`)
        await removePrivateFile(path, label)
      }
    }
    await this.removeCacheDirectory(pending.sha256, pending.format)
    await this.removeCacheDirectory(pending.rollbackSha256, pending.rollbackFormat)
    await this.removeJournal()
    this.staged = undefined
    this.rollback = undefined
    this.pending = undefined
  }

  /** @returns canonical private update root, or undefined when no root has been created yet. */
  private async nativeUpdatesDirectory(create: boolean): Promise<string | undefined> {
    const configured = join(this.options.storageDirectory, 'native-updates')
    if (create) {
      await mkdir(configured, { recursive: true, mode: 0o700 })
      await syncPrivateDirectory(dirname(configured))
    }
    const details = await lstatIfPresent(configured)
    if (details === undefined) return undefined
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('native Desktop updater cache root is not a private directory')
    }
    const resolved = await realpath(configured)
    if (!isContainedPath(await realpath(this.options.storageDirectory), resolved)) {
      throw new Error('native Desktop updater cache root escapes private storage')
    }
    return resolved
  }

  /** @returns canonical cache directory after rejecting reparse points and paths outside the private root. */
  private async cacheDirectory(sha256: string, create: boolean): Promise<string | undefined> {
    const root = await this.nativeUpdatesDirectory(create)
    if (root === undefined) return undefined
    const configured = join(root, sha256)
    if (create) {
      await mkdir(configured, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      await syncPrivateDirectory(root)
    }
    const details = await lstatIfPresent(configured)
    if (details === undefined) return undefined
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('native Desktop updater cache entry is not a private directory')
    }
    const resolved = await realpath(configured)
    if (!isContainedPath(root, resolved)) throw new Error('native Desktop updater cache entry escapes private storage')
    return resolved
  }

  /** @returns a canonical cached artifact path if its private cache directory still exists. */
  private async artifactPath(sha256: string, format: VerifiedUpdateArtifact['format']): Promise<string | undefined> {
    const cacheDirectory = await this.cacheDirectory(sha256, false)
    return cacheDirectory === undefined ? undefined : join(cacheDirectory, artifactFilename(format))
  }

  /** @returns canonical journal path after rejecting a link-shaped update root. */
  private async journalPath(create = false): Promise<string | undefined> {
    const root = await this.nativeUpdatesDirectory(create)
    return root === undefined ? undefined : join(root, journalFilename)
  }

  /** @returns canonical detached-worker directory after rejecting a reparse point. */
  private async workerDirectory(create: boolean): Promise<string | undefined> {
    const root = await this.nativeUpdatesDirectory(create)
    if (root === undefined) return undefined
    const configured = join(root, 'workers')
    if (create) {
      await mkdir(configured, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      await syncPrivateDirectory(root)
    }
    const details = await lstatIfPresent(configured)
    if (details === undefined) return undefined
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('native Desktop updater worker directory is not private')
    }
    const resolved = await realpath(configured)
    if (!isContainedPath(root, resolved)) throw new Error('native Desktop updater worker directory escapes private storage')
    return resolved
  }

  /** @returns whether the detached watchdog recorded observation of this applied transaction. */
  private async wasAppliedObserved(pending: PendingNativeUpdate): Promise<boolean> {
    const workers = await this.workerDirectory(false)
    if (workers === undefined) return false
    const marker = join(workers, `native-update-applied-${pending.transactionId}.json`)
    if (dirname(marker) !== workers) throw new Error('native Desktop watchdog completion marker escapes private storage')
    const value = await readPrivateTextFile(marker, 'native Desktop watchdog completion marker').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    return value === `${pending.transactionId}\n`
  }

  /** @returns whether the detached watchdog recorded completion of this exact rollback transaction. */
  private async wasRollbackObserved(pending: PendingNativeUpdate): Promise<boolean> {
    const workers = await this.workerDirectory(false)
    if (workers === undefined) return false
    const marker = join(workers, `native-update-rolled-back-${pending.transactionId}.json`)
    if (dirname(marker) !== workers) throw new Error('native Desktop watchdog rollback marker escapes private storage')
    const value = await readPrivateTextFile(marker, 'native Desktop watchdog rollback marker').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    return value === `${pending.transactionId}\n`
  }

  /** @returns whether the detached watchdog commits the acknowledged candidate within the bounded health-check window. */
  private async waitForAppliedObservation(pending: PendingNativeUpdate): Promise<boolean> {
    const deadline = this.heartbeatOperations.monotonicNow() + this.options.healthCheckTimeoutMs
    do {
      const observed = await this.wasAppliedObserved(pending)
      const now = this.heartbeatOperations.monotonicNow()
      if (now >= deadline) return false
      if (observed) return true
      const remaining = deadline - now
      if (remaining <= 0) return false
      await this.heartbeatOperations.delay(Math.min(25, remaining))
    } while (this.heartbeatOperations.monotonicNow() < deadline)
    return false
  }

  /** @returns whether this current candidate process observes a post-launch worker proof within the policy health window. */
  private async hasCurrentWatchdogHeartbeat(pending: PendingNativeUpdate): Promise<boolean> {
    const rollbackArtifactPath = await this.artifactPath(pending.rollbackSha256, pending.rollbackFormat)
    const workers = await this.workerDirectory(false)
    if (rollbackArtifactPath === undefined || workers === undefined) return false
    const heartbeat = nativeUpdateHeartbeatPath(rollbackArtifactPath, pending.transactionId, nativePlatform(process.platform))
    if (dirname(heartbeat) !== workers) throw new Error('native Desktop watchdog heartbeat escapes private storage')
    const currentStart = currentNativeProcessReference().startedBeforeMs
    const windowsLaunchNonce = this.options.platform === 'win32'
      ? this.options.candidateLaunchNonce ?? this.heartbeatOperations.windowsLaunchNonce?.() ?? parseNativeUpdateLaunchNonce(process.argv)
      : undefined
    if (this.options.platform === 'win32' && windowsLaunchNonce === undefined) return false
    const deadline = this.heartbeatOperations.monotonicNow() + this.options.healthCheckTimeoutMs
    do {
      if (this.heartbeatOperations.monotonicNow() >= deadline) return false
      const value = await this.heartbeatOperations.read(heartbeat)
      if (this.heartbeatOperations.monotonicNow() >= deadline) return false
      if (value !== undefined && isCurrentWatchdogHeartbeat(
        value,
        pending.transactionId,
        currentStart,
        this.heartbeatOperations.wallNow(),
        this.options.platform,
        windowsLaunchNonce,
        this.options.healthCheckTimeoutMs,
      )) return true
      await this.heartbeatOperations.delay(25)
    } while (true)
  }

  /** Remove known cache files without recursively traversing unknown descendants, links, or junctions. */
  private async removeCacheDirectory(sha256: string, format: VerifiedUpdateArtifact['format']): Promise<void> {
    const root = await this.nativeUpdatesDirectory(false)
    if (root === undefined) return
    const path = join(root, sha256)
    const details = await lstatIfPresent(path)
    if (details === undefined) return
    if (details.isSymbolicLink()) {
      await unlink(path)
      return
    }
    if (!details.isDirectory()) throw new Error('native Desktop updater cache cleanup found a non-directory entry')
    const resolved = await realpath(path)
    if (!isContainedPath(root, resolved)) throw new Error('native Desktop updater cache cleanup escapes private storage')
    await removePrivateFile(join(resolved, artifactFilename(format)), 'native Desktop updater cached artifact')
    await removeEmptyPrivateDirectory(join(resolved, 'workers'), root, 'native Desktop updater worker directory')
    await removeEmptyPrivateDirectory(resolved, root, 'native Desktop updater cache directory')
  }

  /** Remove the journal file without following a symbolic link or accepting a directory. */
  private async removeJournal(): Promise<void> {
    const journal = await this.journalPath(false)
    if (journal === undefined) return
    await removePrivateFile(journal, 'native Desktop update journal')
  }

  private async writeFailureStage(stage: NativeInstallFailureStage): Promise<void> {
    if (process.env.DSH_NATIVE_UPDATE_E2E_DIAGNOSTICS !== '1') return
    try {
      const workers = await this.workerDirectory(true)
      if (workers === undefined) return
      await writePrivateFile(
        join(workers, `native-update-failure-stage-${stage}-${randomUUID()}.json`),
        `${stage}\n`,
      )
    } catch {
      // Test-only failure evidence cannot change the redacted update result or cleanup path.
    }
  }
}

function parsePendingJournal(value: unknown): PendingNativeUpdate | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'transactionId', 'phase', 'currentVersion', 'version', 'channel', 'format', 'sha256', 'rollbackFormat', 'rollbackSha256',
  ], ['candidateProcess'])) return undefined
  const candidateProcess = value.candidateProcess
  if (value.schemaVersion !== 1 || (value.phase !== 'staged' && value.phase !== 'awaiting-dashboard-health'
    && value.phase !== 'dashboard-health-checking' && value.phase !== 'rollback-scheduled' && value.phase !== 'applied' && value.phase !== 'cleanup-pending')
    || typeof value.transactionId !== 'string' || !isUuid(value.transactionId) || typeof value.currentVersion !== 'string' || !isSemanticVersion(value.version) || !isChannel(value.channel)
    || !isFormat(value.format) || !isSha256(value.sha256)
    || !isFormat(value.rollbackFormat) || !isSha256(value.rollbackSha256)
    || (candidateProcess !== undefined && !isNativeProcessReference(candidateProcess))
    || ((value.phase === 'dashboard-health-checking' || value.phase === 'rollback-scheduled' || value.phase === 'applied') && candidateProcess === undefined)
    || ((value.phase === 'staged' || value.phase === 'awaiting-dashboard-health')
      && candidateProcess !== undefined)) return undefined
  return {
    schemaVersion: 1,
    phase: value.phase,
    transactionId: value.transactionId,
    currentVersion: value.currentVersion,
    version: value.version,
    channel: value.channel,
    format: value.format,
    sha256: value.sha256,
    rollbackFormat: value.rollbackFormat,
    rollbackSha256: value.rollbackSha256,
    ...(candidateProcess === undefined ? {} : { candidateProcess }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return Object.keys(value).every(key => allowed.has(key)) && required.every(key => Object.hasOwn(value, key))
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value)
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) }

/**
 * Validate one platform-specific watchdog heartbeat against the current candidate identity.
 * @param value - exact private heartbeat text.
 * @param transactionId - journal transaction expected by this candidate.
 * @param candidateStartedBeforeMs - non-Windows process startup lower bound.
 * @param observedAtMs - current wall time used only to reject future timestamps.
 * @param platform - native marker grammar selector.
 * @param windowsLaunchNonce - strict nonce parsed from the Windows candidate argv.
 * @param startupFreshnessWindowMs - bounded Linux startup window allowed before the candidate's epoch estimate.
 * @returns whether the heartbeat belongs to this transaction and candidate launch.
 */
export function isCurrentWatchdogHeartbeat(
  value: string,
  transactionId: string,
  candidateStartedBeforeMs: number,
  observedAtMs: number,
  platform: NodeJS.Platform,
  windowsLaunchNonce?: string,
  startupFreshnessWindowMs = 0,
): boolean {
  if (platform === 'win32') {
    const match = value.match(/^([0-9a-f-]{36}):([0-9a-f]{32}):(\d{1,16})\n$/iu)
    if (match?.[1] !== transactionId || match[2] === undefined || match[3] === undefined
      || windowsLaunchNonce === undefined || match[2].toLowerCase() !== windowsLaunchNonce) return false
    const writtenAt = Number(match[3])
    return Number.isSafeInteger(writtenAt) && writtenAt <= observedAtMs
  }
  const match = value.match(/^([0-9a-f-]{36}):(\d{1,16})\n$/iu)
  if (match?.[1] === undefined || match[2] === undefined || match[1] !== transactionId) return false
  const writtenAt = Number(match[2])
  const earliestAccepted = Math.max(0, candidateStartedBeforeMs - startupFreshnessWindowMs)
  return Number.isSafeInteger(writtenAt) && writtenAt >= earliestAccepted && writtenAt <= observedAtMs
}

/** @param argv - candidate process argv. @returns one strict nonce or undefined for missing, malformed, or repeated values. */
export function parseNativeUpdateLaunchNonce(argv: readonly string[]): string | undefined {
  const prefix = '--dsh-native-update-launch-nonce='
  const values = argv.filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length))
  const [value] = values
  return values.length === 1 && value !== undefined && /^[0-9a-f]{32}$/u.test(value) ? value : undefined
}

function isChannel(value: unknown): value is DesktopUpdateChannel {
  return value === 'stable' || value === 'beta' || value === 'nightly'
}

function isFormat(value: unknown): value is VerifiedUpdateArtifact['format'] {
  return value === 'nsis' || value === 'zip' || value === 'appimage' || value === 'dmg' || value === 'deb' || value === 'tar.gz'
}

function isNativeRollbackFormat(value: VerifiedUpdateArtifact['format']): value is 'nsis' | 'zip' | 'appimage' {
  return value === 'nsis' || value === 'zip' || value === 'appimage'
}

function rollbackAuthorizationMatchesPending(
  authorization: NativeRollbackAuthorization,
  pending: PendingNativeUpdate,
): boolean {
  if (authorization.transactionId !== pending.transactionId || authorization.version !== pending.version) return false
  if (pending.phase === 'awaiting-dashboard-health') {
    return authorization.reason === 'candidate-version-mismatch' || authorization.reason === 'watchdog-heartbeat-missing'
  }
  if (pending.phase === 'dashboard-health-checking') {
    return authorization.reason === 'watchdog-heartbeat-missing' || authorization.reason === 'candidate-identity-mismatch'
  }
  if (pending.phase === 'rollback-scheduled') return authorization.reason === 'rollback-version-mismatch'
  if (pending.phase === 'applied') return authorization.reason === 'applied-heartbeat-missing'
  return false
}

function nativeRollbackFormat(value: VerifiedUpdateArtifact['format']): 'nsis' | 'zip' | 'appimage' {
  if (!isNativeRollbackFormat(value)) throw new Error('native Desktop candidate format is unsupported')
  return value
}

const nativeInstallHeartbeatOperations: NativeInstallHeartbeatOperations = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  read: async path => await readPrivateTextFile(path, 'native Desktop watchdog heartbeat').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }),
  delay: async (milliseconds) => {
    await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
  },
  windowsLaunchNonce: () => parseNativeUpdateLaunchNonce(process.argv),
}

/** @returns whether a persisted candidate identity belongs to this exact new Main process. */
function isCurrentCandidateProcess(reference: NativeProcessReference): boolean {
  const current = currentNativeProcessReference()
  return reference.processId === current.processId
    && reference.executablePath === current.executablePath
    && reference.startedBeforeMs === current.startedBeforeMs
    && reference.linuxStartTicks === current.linuxStartTicks
}

function nativePlatform(platform: NodeJS.Platform): 'win32' | 'darwin' | 'linux' {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  throw new Error('native Desktop rollback platform is unsupported')
}

function artifactFilename(format: VerifiedUpdateArtifact['format']): string {
  if (format === 'nsis') return 'candidate.exe'
  if (format === 'appimage') return 'candidate.AppImage'
  if (format === 'dmg') return 'candidate.dmg'
  if (format === 'deb') return 'candidate.deb'
  if (format === 'tar.gz') return 'candidate.tar.gz'
  return 'candidate.zip'
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** @returns metadata for one private path, or undefined only when that path is absent. */
async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reject a linked, directory, device, or other non-regular private file before it is read or replaced. */
async function assertPrivateRegularFileOrAbsent(path: string, label: string): Promise<void> {
  const details = await lstatIfPresent(path)
  if (details === undefined) return
  if (!isPrivateRegularFile(details)) throw new Error(`${label} is not a private regular file`)
}

async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const details = await lstatIfPresent(path)
  if (details === undefined || !isPrivateRegularFile(details)) {
    throw new Error(`${label} is not a private regular file`)
  }
}

function isTransientWindowsJournalReplacementError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM'
}

/** @returns private file bytes, or undefined only when the exact regular file is absent. */
async function readPrivateFileIfPresent(path: string, label: string): Promise<Uint8Array | undefined> {
  const before = await lstatIfPresent(path)
  if (before === undefined) return undefined
  if (!isPrivateRegularFile(before)) throw new Error(`${label} is not a private regular file`)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!isPrivateRegularFile(opened) || !samePrivateFile(before, opened)) {
      throw new Error(`${label} changed while it was opened`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** @returns private file bytes after rejecting a link-shaped or non-regular cache entry. */
async function readPrivateFile(path: string, label: string): Promise<Uint8Array> {
  const bytes = await readPrivateFileIfPresent(path, label)
  if (bytes === undefined) throw Object.assign(new Error(`${label} is missing`), { code: 'ENOENT' })
  return bytes
}

/** @returns private UTF-8 text after rejecting a link-shaped or non-regular cache entry. */
async function readPrivateTextFile(path: string, label: string): Promise<string> {
  const bytes = await readPrivateFileIfPresent(path, label)
  if (bytes === undefined) throw Object.assign(new Error(`${label} is missing`), { code: 'ENOENT' })
  return Buffer.from(bytes).toString('utf8')
}

/** Remove one private file or link without traversing it. */
async function removePrivateFile(path: string, label: string): Promise<void> {
  const details = await lstatIfPresent(path)
  if (details === undefined) return
  if (details.isDirectory() || (!details.isFile() && !details.isSymbolicLink())) {
    throw new Error(`${label} is not a removable private file`)
  }
  await unlink(path)
}

/** Remove one empty private directory or link without traversing it. */
async function removeEmptyPrivateDirectory(path: string, root: string, label: string): Promise<void> {
  const details = await lstatIfPresent(path)
  if (details === undefined) return
  if (details.isSymbolicLink()) {
    await unlink(path)
    return
  }
  if (!details.isDirectory()) throw new Error(`${label} is not a private directory`)
  const resolved = await realpath(path)
  if (!isContainedPath(root, resolved)) throw new Error(`${label} escapes private storage`)
  try {
    await rmdir(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return
    throw error
  }
}

/** @returns whether a canonical private path is a strict descendant of its canonical root. */
function isContainedPath(root: string, path: string): boolean {
  const child = relative(root, path)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** @returns whether the metadata describes one unlinked, regular private cache file. */
function isPrivateRegularFile(details: Awaited<ReturnType<typeof lstat>>): boolean {
  return details.isFile() && !details.isSymbolicLink() && details.nlink === 1
}

/** @returns whether the opened descriptor still refers to the exact lstat-validated cache file. */
function samePrivateFile(
  before: Awaited<ReturnType<typeof lstat>>,
  opened: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return before.dev === opened.dev && before.ino === opened.ino && before.nlink === opened.nlink
}

async function writePrivateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncPrivateDirectory(dirname(path))
}

/** Persist a private directory entry before a native transition may depend on its pathname. */
async function syncPrivateDirectory(path: string): Promise<void> {
  const handle = await open(path, process.platform === 'win32' ? 'a+' : constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
