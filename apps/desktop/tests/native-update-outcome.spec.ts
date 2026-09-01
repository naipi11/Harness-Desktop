/** Native startup health outcome persistence behavior. */

import { describe, expect, it } from 'vitest'
import type { DesktopUpdateOutcome } from '@harness-desktop/dsh-host-local-runtime'
import {
  NativeUpdateOutcomeRecorder,
  recordAndFinalizeNativeUpdateHealth,
} from '../src/main/update/native-update-outcome.ts'
import type { NativeUpdateHealth } from '../src/main/update/native-install.ts'

describe('NativeUpdateOutcomeRecorder', () => {
  it('records startup applied health once', async () => {
    const outcomes: DesktopUpdateOutcome[] = []
    const runtime = {
      getDesktopUpdateChannel: async () => 'stable' as const,
      getDesktopUpdateLastOutcome: async () => undefined,
      recordDesktopUpdateOutcome: async (outcome: DesktopUpdateOutcome) => { outcomes.push(outcome) },
    }
    const subject = new NativeUpdateOutcomeRecorder()
    const health = { kind: 'applied', version: '1.1.0', channel: 'stable' } as const

    await subject.record(runtime, health, '1.1.0')
    await subject.record(runtime, health, '1.1.0')

    expect(outcomes).toEqual([{
      version: '1.1.0', channel: 'stable', kind: 'applied', code: 'applied', lastKnownGoodVersion: '1.1.0',
    }])
  })

  it('keeps pending health unrecorded and records rollback once', async () => {
    const outcomes: DesktopUpdateOutcome[] = []
    const runtime = {
      getDesktopUpdateChannel: async () => 'stable' as const,
      getDesktopUpdateLastOutcome: async () => undefined,
      recordDesktopUpdateOutcome: async (outcome: DesktopUpdateOutcome) => { outcomes.push(outcome) },
    }
    const subject = new NativeUpdateOutcomeRecorder()

    await subject.record(runtime, { kind: 'awaiting-worker-commit', version: '1.1.0', channel: 'stable' }, '1.0.0')
    await subject.record(runtime, { kind: 'rolled-back', version: '1.1.0', channel: 'stable' }, '1.0.0')
    await subject.record(runtime, { kind: 'rolled-back', version: '1.1.0', channel: 'stable' }, '1.0.0')

    expect(outcomes).toEqual([{
      version: '1.1.0', channel: 'stable', kind: 'rolled-back', code: 'health-check-failed', lastKnownGoodVersion: '1.0.0',
    }])
  })

  it('coalesces concurrent writes for the same settled outcome', async () => {
    const settled = [
      { health: { kind: 'applied', version: '1.1.0', channel: 'stable' }, currentVersion: '1.1.0' },
      { health: { kind: 'rolled-back', version: '1.1.0', channel: 'stable' }, currentVersion: '1.0.0' },
    ] as const
    for (const entry of settled) {
      let calls = 0
      let releaseWrite: (() => void) | undefined
      const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve })
      const runtime = {
        getDesktopUpdateChannel: async () => 'stable' as const,
        getDesktopUpdateLastOutcome: async () => undefined,
        recordDesktopUpdateOutcome: async (_outcome: DesktopUpdateOutcome) => {
          calls += 1
          await writeReleased
        },
      }
      const subject = new NativeUpdateOutcomeRecorder()

      const writes = Promise.all([
        subject.record(runtime, entry.health, entry.currentVersion),
        subject.record(runtime, entry.health, entry.currentVersion),
      ])
      await Promise.resolve()
      expect(calls).toBe(1)
      releaseWrite?.()
      await writes
    }
  })

  it('releases a failed outcome reservation for retry', async () => {
    let calls = 0
    const runtime = {
      getDesktopUpdateChannel: async () => 'stable' as const,
      getDesktopUpdateLastOutcome: async () => undefined,
      recordDesktopUpdateOutcome: async (_outcome: DesktopUpdateOutcome) => {
        calls += 1
        if (calls === 1) throw new Error('settings unavailable')
      },
    }
    const subject = new NativeUpdateOutcomeRecorder()
    const health = { kind: 'applied', version: '1.1.0', channel: 'stable' } as const

    await expect(subject.record(runtime, health, '1.1.0')).rejects.toThrow('settings unavailable')
    await expect(subject.record(runtime, health, '1.1.0')).resolves.toBeUndefined()
    await expect(subject.record(runtime, health, '1.1.0')).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it('retains finalization after a failed Runtime write and performs it only after the retry records the outcome', async () => {
    const events: string[] = []
    let writes = 0
    const runtime = {
      getDesktopUpdateChannel: async () => 'stable' as const,
      getDesktopUpdateLastOutcome: async () => undefined,
      recordDesktopUpdateOutcome: async (_outcome: DesktopUpdateOutcome) => {
        writes += 1
        events.push(`record:${String(writes)}`)
        if (writes === 1) throw new Error('settings unavailable')
      },
    }
    const recorder = new NativeUpdateOutcomeRecorder()
    const health = { kind: 'applied', version: '1.1.0', channel: 'stable' } as const
    const finalize = async (_health: Extract<NativeUpdateHealth, { readonly kind: 'applied' | 'rolled-back' }>): Promise<void> => {
      events.push('finalize')
    }

    await expect(recordAndFinalizeNativeUpdateHealth(
      recorder, runtime, health, '1.1.0', finalize,
    )).rejects.toThrow('settings unavailable')
    expect(events).toEqual(['record:1'])

    await expect(recordAndFinalizeNativeUpdateHealth(
      recorder, runtime, health, '1.1.0', finalize,
    )).resolves.toBeUndefined()
    expect(events).toEqual(['record:1', 'record:2', 'finalize'])
  })
})
