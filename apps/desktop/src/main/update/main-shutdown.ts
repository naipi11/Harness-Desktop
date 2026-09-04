/** Main-process shutdown ordering for automatic updates, Runtime teardown, and native worker readiness. */

import type { DesktopUpdateFlightGate, NativeTransitionGate } from './native-transition-gate.ts'

/**
 * Close update admission and settle its local transaction before Runtime teardown, while also waiting for an admitted native worker.
 * Failures do not strand Electron shutdown after the conservative local and worker-readiness flights settle.
 */
export async function settleDesktopMainShutdown(
  automaticUpdates: DesktopUpdateFlightGate,
  nativeTransitions: NativeTransitionGate,
  closeRuntime: () => Promise<void>,
): Promise<void> {
  const local = (async () => {
    await automaticUpdates.close()
    await closeRuntime()
  })()
  const native = nativeTransitions.pending
  await Promise.allSettled(native === undefined ? [local] : [local, native])
}
