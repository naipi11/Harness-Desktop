/** Shared settlement for initial and retried Desktop Dashboard startup. */

import type { DesktopStartupResult } from './runtime-dashboard.ts'

const settlements = new WeakMap<object, Promise<void>>()

/** Main-owned effects that follow one Dashboard load attempt. */
export interface DesktopDashboardStartupLifecycle<Client> {
  /** Publish the load result to Main's recovery state. */
  readonly publish: (result: DesktopStartupResult) => Promise<DesktopStartupResult>
  /** @returns whether native health and Runtime outcome persistence reached a stable state. */
  readonly settleNativeHealth: (client: Client) => Promise<boolean>
  /** @returns whether settled startup health permits a new automatic update check. */
  readonly mayCheckAutomaticUpdate: () => boolean
  /** Admit the process-wide automatic update check for the ready Runtime. */
  readonly scheduleAutomaticUpdate: (client: Client) => void
}

/**
 * Publish one Dashboard load attempt before settling native health and admitting automatic updates.
 * Concurrent loaded results for the same Runtime client share post-load settlement. Load and publication remain per caller.
 * @param client - Runtime owner associated with the Dashboard attempt.
 * @param load - initial open or explicit user retry operation.
 * @param lifecycle - Main-owned publication, health, persistence, and update effects.
 * @returns the published Dashboard startup result.
 */
export async function completeDesktopDashboardStartup<Client extends object>(
  client: Client,
  load: () => Promise<DesktopStartupResult>,
  lifecycle: DesktopDashboardStartupLifecycle<Client>,
): Promise<DesktopStartupResult> {
  const published = await lifecycle.publish(await load())
  if (published.kind !== 'dashboard-loaded') return published
  let settlement = settlements.get(client)
  if (settlement === undefined) {
    settlement = Promise.resolve().then(async () => {
      if (!await lifecycle.settleNativeHealth(client)) return
      if (lifecycle.mayCheckAutomaticUpdate()) lifecycle.scheduleAutomaticUpdate(client)
    })
    settlements.set(client, settlement)
    const current = settlement
    const clear = (): void => {
      if (settlements.get(client) === current) settlements.delete(client)
    }
    void settlement.then(clear, clear)
  }
  await settlement
  return published
}
