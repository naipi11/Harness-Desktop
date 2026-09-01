/** Packaged Desktop startup handling after native health requires rollback. */

import type { NativeDesktopInstallAdapter, NativeUpdateHealth } from './native-install.ts'

/** Result that decides whether Desktop startup continues or exits into rollback. */
export type NativeUpdateStartupResolution =
  | { readonly result: 'continue'; readonly health: NativeUpdateHealth }
  | { readonly result: 'rollback-scheduled' }

/**
 * Schedule the rollback required by the immediately preceding native health check.
 * @param adapter - native transaction owner that authorized the rollback.
 * @returns rollback scheduling, or a settled applied state when a late completion proof wins the race.
 */
export async function scheduleRequiredNativeRollback(
  adapter: NativeDesktopInstallAdapter,
): Promise<NativeUpdateStartupResolution> {
  const result = await adapter.scheduleRollback()
  if (result.kind === 'already-applied') {
    return {
      result: 'continue',
      health: { kind: 'applied', version: result.version, channel: result.channel },
    }
  }
  return { result: 'rollback-scheduled' }
}
