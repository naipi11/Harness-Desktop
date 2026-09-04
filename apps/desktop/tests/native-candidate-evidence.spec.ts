/** Native candidate launch evidence behavior. */

import { describe, expect, it } from 'vitest'
import { candidateLaunchObserved } from './support/native-candidate-evidence.ts'

describe('candidateLaunchObserved', () => {
  it('retains a transaction heartbeat after stable bytes replace a short-lived candidate', () => {
    expect(candidateLaunchObserved({
      candidateVersion: '1.0.1',
      installedVersion: '1.0.0',
      previouslyObserved: false,
      transactionHeartbeat: true,
    })).toBe(true)
  })

  it('does not infer candidate launch from stable bytes without a transaction heartbeat', () => {
    expect(candidateLaunchObserved({
      candidateVersion: '1.0.1',
      installedVersion: '1.0.0',
      previouslyObserved: false,
      transactionHeartbeat: false,
    })).toBe(false)
  })
})
