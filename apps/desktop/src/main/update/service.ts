/** Verified Desktop update staging, health acknowledgement, and rollback orchestration. */

import { createHash } from 'node:crypto'
import {
  type DesktopUpdateChannel,
  type DesktopUpdateOutcome,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  verifySignedUpdateManifest,
  type RedactedUpdateArtifact,
  type UpdateManifestPolicy,
  type UpdateTrust,
} from '@harness-desktop/dsh-update-policy'
import { isDesktopReadyAcknowledgement } from '../readiness.ts'
import type { StageAdapter, StagedDesktopCandidate } from './staged-install.ts'

/** Runtime operations used by the transient Desktop update transaction. */
export interface DesktopUpdateRuntime {
  /** @returns the Runtime-owned selected Desktop update channel. */
  getDesktopUpdateChannel(): Promise<DesktopUpdateChannel>
  /** @param outcome - one Runtime-compatible redacted updater outcome. @returns settlement after durable recording. */
  recordDesktopUpdateOutcome(outcome: DesktopUpdateOutcome): Promise<void>
}

/** Stable redacted result returned by the Desktop-local update transaction. */
export type DesktopUpdateResult =
  | { readonly kind: 'up-to-date'; readonly code: 'unconfigured-trust-root' | 'no-staged-candidate' }
  | { readonly kind: 'staged'; readonly code: 'candidate-staged'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'applied'; readonly code: 'candidate-applied'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | { readonly kind: 'rolled-back'; readonly code: 'desktop-health-check-failed'; readonly version: string; readonly channel: DesktopUpdateChannel }
  | {
    readonly kind: 'failed'
    readonly code: 'candidate-manifest-rejected' | 'candidate-download-failed' | 'candidate-bytes-rejected'
      | 'candidate-members-rejected' | 'candidate-staging-failed' | 'candidate-restore-failed'
    readonly version?: string
    readonly channel?: DesktopUpdateChannel
  }

/** Immutable context for one Desktop update service. */
export interface DesktopUpdateServiceOptions {
  /** Product identity enforced by the signed manifest policy. */
  readonly appId: string
  /** Installed Desktop semantic version. */
  readonly currentVersion: string
  /** Current Desktop operating-system target. */
  readonly platform: NodeJS.Platform
  /** Current Desktop CPU target. */
  readonly arch: string
  /** Audited release trust; shipped Main creates the service with no trust. */
  readonly trust: UpdateTrust
  /** Runtime preference and outcome owner when an update source is configured. */
  readonly runtime?: DesktopUpdateRuntime
  /** Decodes one externally supplied manifest only after trust is configured. */
  readonly loadManifest?: () => Promise<unknown>
  /** Platform transaction owner. */
  readonly adapter: StageAdapter
}

/**
 * Owns one transient candidate from signed-manifest verification through health-check rollback.
 * No source is queried while trust is empty, so Main's default construction cannot stage or mutate.
 */
export class DesktopUpdateService {
  private staged: StagedDesktopCandidate | undefined
  private applying: Promise<DesktopUpdateResult> | undefined

  /** @param options - immutable Main-process policy and transaction collaborators. */
  constructor(private readonly options: DesktopUpdateServiceOptions) {}

  /**
   * Verifies, downloads, and stages one candidate without launching it.
   * @returns a stable redacted staging result.
   */
  async checkAndStage(): Promise<DesktopUpdateResult> {
    if (trustIsEmpty(this.options.trust)) return { kind: 'up-to-date', code: 'unconfigured-trust-root' }
    const runtime = this.options.runtime
    const loadManifest = this.options.loadManifest
    if (runtime === undefined || loadManifest === undefined) return { kind: 'failed', code: 'candidate-manifest-rejected' }
    let channel: DesktopUpdateChannel
    try {
      channel = await runtime.getDesktopUpdateChannel()
    } catch {
      return { kind: 'failed', code: 'candidate-manifest-rejected' }
    }
    let verification: ReturnType<typeof verifySignedUpdateManifest>
    try {
      verification = verifySignedUpdateManifest(await loadManifest(), this.policy(channel))
    } catch {
      await this.record(runtime, failureOutcome(this.options.currentVersion, channel, 'manifest-rejected'))
      return { kind: 'failed', code: 'candidate-manifest-rejected', channel }
    }
    if (verification.kind === 'rejected') {
      await this.record(runtime, failureOutcome(this.options.currentVersion, channel, 'manifest-rejected'))
      return { kind: 'failed', code: 'candidate-manifest-rejected', channel }
    }
    return await this.stageVerified(verification.artifact, channel, runtime)
  }

  /**
   * Switches one staged candidate, accepting it only after the existing exact Dashboard acknowledgement.
   * @returns an applied result or a completed rollback result.
   */
  applyStagedUpdate(): Promise<DesktopUpdateResult> {
    if (this.applying !== undefined) return this.applying
    const candidate = this.staged
    if (candidate === undefined) return Promise.resolve({ kind: 'up-to-date', code: 'no-staged-candidate' })
    this.staged = undefined
    const flight = this.applyCandidate(candidate).finally(() => {
      if (this.applying === flight) this.applying = undefined
    })
    this.applying = flight
    return flight
  }

  private async applyCandidate(candidate: StagedDesktopCandidate): Promise<DesktopUpdateResult> {
    try {
      const acknowledgement = await this.options.adapter.launchCandidate(candidate)
      if (!isDesktopReadyAcknowledgement(acknowledgement)) throw new Error('Desktop candidate did not acknowledge readiness.')
      await this.options.adapter.cleanup(candidate)
      const outcome: DesktopUpdateOutcome = {
        version: candidate.artifact.version,
        channel: candidate.artifact.channel,
        kind: 'applied',
        code: 'applied',
        lastKnownGoodVersion: candidate.artifact.version,
      }
      await this.record(this.options.runtime, outcome)
      return result('applied', candidate.artifact)
    } catch {
      return await this.rollback(candidate)
    }
  }

  private policy(channel: DesktopUpdateChannel): UpdateManifestPolicy {
    return {
      appId: this.options.appId,
      currentVersion: this.options.currentVersion,
      channel,
      consumer: 'desktop',
      platform: this.options.platform,
      arch: this.options.arch,
      ...this.options.trust,
    }
  }

  private async stageVerified(
    artifact: RedactedUpdateArtifact,
    channel: DesktopUpdateChannel,
    runtime: DesktopUpdateRuntime,
  ): Promise<DesktopUpdateResult> {
    let bytes: Uint8Array
    try {
      bytes = await this.options.adapter.download(artifact)
    } catch {
      await this.record(runtime, failureOutcome(artifact.version, channel, 'artifact-rejected'))
      return { kind: 'failed', code: 'candidate-download-failed', version: artifact.version, channel }
    }
    if (digest(bytes) !== artifact.sha256) {
      await this.record(runtime, failureOutcome(artifact.version, channel, 'artifact-rejected'))
      return { kind: 'failed', code: 'candidate-bytes-rejected', version: artifact.version, channel }
    }
    let members: readonly string[]
    try {
      members = await this.options.adapter.inspect(bytes, artifact)
    } catch {
      await this.record(runtime, failureOutcome(artifact.version, channel, 'artifact-rejected'))
      return { kind: 'failed', code: 'candidate-members-rejected', version: artifact.version, channel }
    }
    if (!sameMembers(members, artifact.members)) {
      await this.record(runtime, failureOutcome(artifact.version, channel, 'artifact-rejected'))
      return { kind: 'failed', code: 'candidate-members-rejected', version: artifact.version, channel }
    }
    const candidate: StagedDesktopCandidate = { artifact, bytes }
    try {
      await this.options.adapter.stage(candidate)
      this.staged = candidate
    } catch {
      return await this.restoreAfterStagingFailure(candidate, runtime)
    }
    await this.record(runtime, { version: artifact.version, channel, kind: 'staged', code: 'staged' })
    return result('staged', artifact)
  }

  private async rollback(candidate: StagedDesktopCandidate): Promise<DesktopUpdateResult> {
    try {
      await this.options.adapter.restoreRetained(candidate)
      await this.options.adapter.cleanup(candidate)
    } catch {
      await this.record(this.options.runtime, failureOutcome(candidate.artifact.version, candidate.artifact.channel, 'install-failed'))
      return { kind: 'failed', code: 'candidate-restore-failed', version: candidate.artifact.version, channel: candidate.artifact.channel }
    }
    await this.record(this.options.runtime, {
      version: candidate.artifact.version,
      channel: candidate.artifact.channel,
      kind: 'rolled-back',
      code: 'health-check-failed',
      lastKnownGoodVersion: this.options.currentVersion,
    })
    return result('rolled-back', candidate.artifact)
  }

  private async restoreAfterStagingFailure(
    candidate: StagedDesktopCandidate,
    runtime: DesktopUpdateRuntime,
  ): Promise<DesktopUpdateResult> {
    try {
      await this.options.adapter.restoreRetained(candidate)
    } catch {
      await this.record(runtime, failureOutcome(candidate.artifact.version, candidate.artifact.channel, 'install-failed'))
      return { kind: 'failed', code: 'candidate-restore-failed', version: candidate.artifact.version, channel: candidate.artifact.channel }
    }
    await this.record(runtime, failureOutcome(candidate.artifact.version, candidate.artifact.channel, 'install-failed'))
    return { kind: 'failed', code: 'candidate-staging-failed', version: candidate.artifact.version, channel: candidate.artifact.channel }
  }

  private async record(runtime: DesktopUpdateRuntime | undefined, outcome: DesktopUpdateOutcome): Promise<void> {
    if (runtime === undefined) return
    try { await runtime.recordDesktopUpdateOutcome(outcome) } catch {
      // Runtime persistence is observational after the installation transaction has settled.
    }
  }
}

function trustIsEmpty(trust: UpdateTrust): boolean {
  return trust.allowedOrigins.length === 0 || Object.keys(trust.publicKeys).length === 0
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function sameMembers(actual: readonly string[], declared: readonly string[]): boolean {
  const orderedActual = [...actual].sort()
  return orderedActual.length === declared.length && orderedActual.every((member, index) => member === declared[index])
}

function failureOutcome(
  version: string,
  channel: DesktopUpdateChannel,
  code: 'manifest-rejected' | 'artifact-rejected' | 'install-failed',
): DesktopUpdateOutcome {
  return { version, channel, kind: 'failed', code }
}

function result(
  kind: 'staged' | 'applied' | 'rolled-back',
  artifact: RedactedUpdateArtifact,
): DesktopUpdateResult {
  if (kind === 'staged') return { kind, code: 'candidate-staged', version: artifact.version, channel: artifact.channel }
  if (kind === 'applied') return { kind, code: 'candidate-applied', version: artifact.version, channel: artifact.channel }
  return { kind, code: 'desktop-health-check-failed', version: artifact.version, channel: artifact.channel }
}
