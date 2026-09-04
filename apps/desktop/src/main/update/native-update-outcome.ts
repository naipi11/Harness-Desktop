/** Runtime outcome persistence for settled native Desktop health. */

import type { DesktopUpdateOutcome } from '@harness-desktop/dsh-host-local-runtime'
import type { DesktopUpdateRuntime } from './service.ts'
import type { NativeUpdateHealth } from './native-install.ts'

type SettledNativeUpdateHealth = Extract<NativeUpdateHealth, { readonly kind: 'applied' | 'rolled-back' }>

/**
 * Persist one terminal startup outcome before allowing its adapter to remove durable recovery state.
 * Pending health performs neither operation. A failed Runtime write never invokes finalization; a later call may retry both steps.
 * @param recorder - process-local coalescer for Runtime outcome writes.
 * @param runtime - durable Runtime settings owner.
 * @param health - current native startup health.
 * @param currentVersion - installed stable version used for rollback outcome persistence.
 * @param finalize - adapter cleanup that runs only after the terminal outcome write succeeds.
 * @returns fulfillment after pending observation or terminal persistence and cleanup.
 */
export async function recordAndFinalizeNativeUpdateHealth(
  recorder: NativeUpdateOutcomeRecorder,
  runtime: DesktopUpdateRuntime,
  health: NativeUpdateHealth,
  currentVersion: string,
  finalize: (health: SettledNativeUpdateHealth) => Promise<void>,
): Promise<void> {
  await recorder.record(runtime, health, currentVersion)
  if (health.kind === 'applied' || health.kind === 'rolled-back') await finalize(health)
}

/** Persists each settled startup health outcome at most once per recorder instance. */
export class NativeUpdateOutcomeRecorder {
  private readonly recorded = new Set<string>()
  private readonly inFlight = new Map<string, Promise<void>>()

  /**
   * Record an applied or rolled-back transaction without treating pending health as settled.
   * @param runtime - Runtime settings owner.
   * @param health - current native startup health.
   * @param currentVersion - installed stable version used only for rollback outcome persistence.
   */
  async record(runtime: DesktopUpdateRuntime, health: NativeUpdateHealth, currentVersion: string): Promise<void> {
    if (health.kind === 'applied') {
      await this.recordOnce(runtime, `${health.kind}:${health.version}:${health.channel}`, {
        version: health.version,
        channel: health.channel,
        kind: 'applied',
        code: 'applied',
        lastKnownGoodVersion: health.version,
      })
    } else if (health.kind === 'rolled-back') {
      await this.recordOnce(runtime, `${health.kind}:${health.version}:${health.channel}`, {
        version: health.version,
        channel: health.channel,
        kind: 'rolled-back',
        code: 'health-check-failed',
        lastKnownGoodVersion: currentVersion,
      })
    }
  }

  private async recordOnce(runtime: DesktopUpdateRuntime, key: string, outcome: DesktopUpdateOutcome): Promise<void> {
    if (this.recorded.has(key)) return
    const existing = this.inFlight.get(key)
    if (existing !== undefined) {
      await existing
      return
    }
    const write = Promise.resolve().then(async () => {
      await runtime.recordDesktopUpdateOutcome(outcome)
      this.recorded.add(key)
    })
    this.inFlight.set(key, write)
    try {
      await write
    } finally {
      if (this.inFlight.get(key) === write) this.inFlight.delete(key)
    }
  }
}
