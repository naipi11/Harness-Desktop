import { describe, expect, it } from 'vitest'
import { queryRemoteTag, successorVersionViolations } from './verify-successor-version.ts'

describe('successorVersionViolations', () => {
  it('accepts one unused successor version without moving the published tag', () => {
    expect(successorVersionViolations(['1.0.1', '1.0.1', '1.0.1'], ['v1.0.0'])).toEqual([])
  })

  it('rejects reuse, divergence, and a successor tag that already exists', () => {
    expect(successorVersionViolations(['1.0.0', '1.0.0', '1.0.0'], ['v1.0.0']))
      .toContain('release successor: 1.0.0 is not newer than published v1.0.0')
    expect(successorVersionViolations(['1.0.1', '1.0.2', '1.0.1'], ['v1.0.0']))
      .toContain('release successor: root, CLI, and Desktop versions differ')
    expect(successorVersionViolations(['1.0.1', '1.0.1', '1.0.1'], ['v1.0.0', 'v1.0.1']))
      .toContain('release successor: public tag v1.0.1 already exists')
    expect(successorVersionViolations(['1.0.1', '1.0.1', '1.0.1'], ['v1.0.0'], 'exists'))
      .toContain('release successor: public tag v1.0.1 already exists')
    expect(successorVersionViolations(['1.0.1', '1.0.1', '1.0.1'], ['v1.0.0'], 'query-failed'))
      .toContain('release successor: authoritative remote tag query failed')
  })

  it('distinguishes an absent remote tag from an existing tag and query failure', () => {
    const absent = Object.assign(new Error('no matching ref'), { status: 2 })
    const failed = Object.assign(new Error('network unavailable'), { status: 128 })
    expect(queryRemoteTag('/repo', '1.0.1', () => { throw absent })).toBe('absent')
    expect(queryRemoteTag('/repo', '1.0.1', () => '')).toBe('exists')
    expect(queryRemoteTag('/repo', '1.0.1', () => { throw failed })).toBe('query-failed')
  })
})
