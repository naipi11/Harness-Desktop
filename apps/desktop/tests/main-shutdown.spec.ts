/** Main shutdown integration across automatic-update and native-transition ownership. */

import { describe, expect, it } from 'vitest'
import { settleDesktopMainShutdown } from '../src/main/update/main-shutdown.ts'
import { DesktopUpdateFlightGate, NativeTransitionGate } from '../src/main/update/native-transition-gate.ts'

describe('settleDesktopMainShutdown', () => {
  it('prevents quit completion until automatic settlement, Runtime close, and native worker readiness all finish', async () => {
    const automatic = new DesktopUpdateFlightGate()
    const native = new NativeTransitionGate()
    let releaseAutomatic: (() => void) | undefined
    void automatic.start(async (signal) => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      }
      await new Promise<void>((resolve) => { releaseAutomatic = resolve })
    })
    let releaseNative: (() => void) | undefined
    void native.start(async () => { await new Promise<void>((resolve) => { releaseNative = resolve }) })
    const order: string[] = []

    const shutdown = settleDesktopMainShutdown(automatic, native, async () => { order.push('runtime-closed') })
      .then(() => { order.push('quit-admitted') })
    await expect.poll(() => releaseAutomatic).not.toBeUndefined()
    expect(order).toEqual([])
    releaseAutomatic?.()
    await expect.poll(() => order).toEqual(['runtime-closed'])
    releaseNative?.()
    await shutdown
    expect(order).toEqual(['runtime-closed', 'quit-admitted'])
  })
})
