/** Desktop update staging roles with an inert production default. */

import type { VerifiedUpdateArtifact } from '@harness-desktop/dsh-update-policy'

/** Verified bytes and declaration retained only for one in-process update attempt. */
export interface StagedDesktopCandidate {
  /** Manifest-authenticated selection retained only by this installation transaction. */
  readonly artifact: VerifiedUpdateArtifact
  /** Downloaded bytes whose digest and members have already been checked. */
  readonly bytes: Uint8Array
}

/**
 * Performs platform-specific staging and retention without exposing release locations to callers.
 * Implementations own all temporary paths and must restore the retained installation before reporting failure.
 */
export interface StageAdapter {
  /**
   * @param artifact - selected manifest-authenticated candidate.
   * @param signal - Main-owned shutdown cancellation.
   * @returns verified candidate bytes.
   */
  download(artifact: VerifiedUpdateArtifact, signal?: AbortSignal): Promise<Uint8Array>
  /**
   * @param bytes - downloaded candidate bytes.
   * @param artifact - declared member set.
   * @returns actual archive members for readable containers, or the signed declaration for an
   * opaque native installer whose byte digest is the local authenticity check.
   */
  inspect(bytes: Uint8Array, artifact: VerifiedUpdateArtifact): Promise<readonly string[]>
  /**
   * @param candidate - candidate whose bytes and members were verified before this call.
   * @returns settlement after staging and retaining the current installation.
   */
  stage(candidate: StagedDesktopCandidate): Promise<void>
  /** @param candidate - one staged candidate. @returns exact candidate-process readiness acknowledgement. */
  launchCandidate(candidate: StagedDesktopCandidate): Promise<unknown>
  /**
   * Schedule a verified installer through the platform-native updater and request a restart.
   * When present, Desktop records the candidate as staged and waits for the next launch to settle health.
   * @param candidate - candidate retained by this adapter until the restarted process acknowledges health.
   * @returns settlement after the native updater owns the staged installer and restart request.
   */
  scheduleInstall?(candidate: StagedDesktopCandidate): Promise<void>
  /** @param candidate - candidate whose retained installation must become current again. @returns settlement after restore. */
  restoreRetained(candidate: StagedDesktopCandidate): Promise<void>
  /** @param candidate - candidate resources to discard, if any. @returns settlement after private temporary cleanup. */
  cleanup(candidate?: StagedDesktopCandidate): Promise<void>
}

/**
 * Builds the shipped adapter before an audited update source exists.
 * @returns an adapter that cannot download, inspect, stage, launch, or mutate an installation.
 */
export function createUnconfiguredStageAdapter(): StageAdapter {
  const unavailable = (): Promise<never> => Promise.reject(new Error('Desktop updates have no configured source.'))
  return {
    download: unavailable,
    inspect: unavailable,
    stage: unavailable,
    launchCandidate: unavailable,
    restoreRetained: unavailable,
    cleanup: () => Promise.resolve(),
  }
}
