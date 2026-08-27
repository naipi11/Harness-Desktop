/** Durable candidate-launch evidence used by native update acceptance tests. */

interface NativeCandidateLaunchEvidence {
  readonly candidateVersion: string
  readonly installedVersion: string | undefined
  readonly previouslyObserved: boolean
  readonly transactionHeartbeat: boolean
}

/**
 * Retain whether the authenticated candidate was observed after installation.
 * @param evidence - direct installed bytes and durable transaction evidence.
 * @returns whether candidate installation and launch have been observed.
 */
export function candidateLaunchObserved(evidence: NativeCandidateLaunchEvidence): boolean {
  return evidence.previouslyObserved
    || evidence.installedVersion === evidence.candidateVersion
    || evidence.transactionHeartbeat
}
