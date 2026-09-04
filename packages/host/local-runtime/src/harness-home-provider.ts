/** Immutable resolved-path provider shared by one local Runtime composition. */

import { posix, win32 } from 'node:path'
import type { HarnessHome } from './data-root.ts'

/** One already-resolved root injected into every local durable writer. */
export interface HarnessHomeProvider {
  readonly home: HarnessHome
  /** @param segments - child path segments beneath the resolved Harness home. @returns the joined child path. */
  path(...segments: readonly string[]): string
}

/**
 * Build an immutable path provider from one already-resolved Harness home.
 * @param home - the sole writable Harness home for the composed Runtime.
 * @param platform - Node platform identifier selecting path joining semantics.
 * @returns the provider shared by every durable writer in this Runtime.
 */
export function createHarnessHomeProvider(home: HarnessHome, platform: string = process.platform): HarnessHomeProvider {
  const paths = platform === 'win32' ? win32 : posix
  return Object.freeze({
    home,
    path: (...segments: readonly string[]) => paths.join(home, ...segments),
  })
}
