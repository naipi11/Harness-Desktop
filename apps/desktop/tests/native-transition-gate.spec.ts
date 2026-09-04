/** Native update handoff admission and shutdown-barrier behavior. */

import { describe, expect, it } from 'vitest'
import { DesktopUpdateFlightGate, NativeTransitionGate } from '../src/main/update/native-transition-gate.ts'

describe('NativeTransitionGate', () => {
  it('reserves transition ownership before worker launch begins and rejects a second admission', async () => {
    const subject = new NativeTransitionGate()
    let release: (() => void) | undefined
    const first = subject.start(async () =>{  await new Promise<void>((resolve) => { release = resolve }) })

    expect(subject.pending).toBe(first)
    expect(() => subject.start(async () => {})).toThrow('transition is already requested')
    await Promise.resolve()
    release?.()
    await expect(first).resolves.toBeUndefined()
    expect(subject.pending).toBe(first)
  })

  it('releases a failed readiness flight so a safe retry can be admitted', async () => {
    const subject = new NativeTransitionGate()
    const failed = subject.start(async () => { throw new Error('worker did not become ready') })

    await expect(failed).rejects.toThrow('worker did not become ready')
    await Promise.resolve()
    expect(subject.pending).toBeUndefined()
    await expect(subject.start(async () => {})).resolves.toBeUndefined()
  })
})

describe('DesktopUpdateFlightGate', () => {
  it('closes admission, aborts the active download, and waits for conservative settlement', async () => {
    const subject = new DesktopUpdateFlightGate()
    let releaseSettlement: (() => void) | undefined
    const settled = new Promise<void>((resolve) => { releaseSettlement = resolve })
    let observedSignal: AbortSignal | undefined
    const flight = subject.start(async (signal) => {
      observedSignal = signal
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      await settled
    })

    await Promise.resolve()
    const shutdown = subject.close()

    expect(observedSignal?.aborted).toBe(true)
    expect(() => subject.start(async () => {})).toThrow('update admission is closed')
    let shutdownSettled = false
    void shutdown.then(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    releaseSettlement?.()
    await expect(Promise.all([flight, shutdown])).resolves.toEqual([undefined, undefined])
  })

  it('waits for every admitted update flight even when one rejects', async () => {
    const subject = new DesktopUpdateFlightGate()
    const failed = subject.start(async () => { throw new Error('download failed') })

    await expect(failed).rejects.toThrow('download failed')
    await expect(subject.close()).resolves.toBeUndefined()
  })
})
