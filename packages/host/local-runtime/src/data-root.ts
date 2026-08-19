/** Harness Desktop's sole writable data-root resolution policy. */

import { posix, win32 } from 'node:path'
import type { Branded } from '@harness-desktop/dsh-brand'
import { expandHomePath } from '@harness-desktop/dsh-home-paths'

/** Absolute path to the sole writable Harness Desktop data root. */
export type HarnessHome = Branded<'HarnessHome'>

/** Inputs accepted by the data-root resolver. Injectable fields make platform policy testable. */
export interface HarnessHomeInput {
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly localAppData?: string
}

/** Result of resolving the writable data root and observing a possible legacy source. */
export interface HarnessHomeResolution {
  readonly path: HarnessHome
  readonly source: 'environment' | 'platform-default'
  readonly legacyDshHome: string | undefined
}

/** One already-resolved root injected into every local durable writer. */
export interface HarnessHomeProvider {
  readonly home: HarnessHome
  path(...segments: readonly string[]): string
}

/** Environment variable that selects the writable Harness Desktop data root. */
export const HARNESS_HOME_ENV = 'HARNESS_HOME'

/** Return the path implementation for a tested platform policy. */
function platformPaths(platform: string) {
  return platform === 'win32' ? win32 : posix
}

/**
 * Resolve the platform default for the writable Harness Desktop data root.
 * @param platform - Node platform identifier used to select the platform policy.
 * @param env - environment mapping used for platform-specific data directories.
 * @param homeDir - operating-system home directory used by macOS and Linux defaults.
 * @returns normalized absolute platform default.
 */
export function defaultHarnessHome(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): HarnessHome {
  const paths = platformPaths(platform)
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? paths.join(homeDir, 'AppData', 'Local')
    return paths.resolve(localAppData, 'Harness Desktop') as HarnessHome
  }
  if (platform === 'darwin') return paths.resolve(homeDir, 'Library', 'Application Support', 'Harness Desktop') as HarnessHome
  return paths.resolve(env.XDG_DATA_HOME ?? paths.join(homeDir, '.local', 'share'), 'harness-desktop') as HarnessHome
}

/**
 * Resolve the one writable Harness Desktop data root. `DSH_HOME` remains a
 * read-only legacy-import candidate and can never select the write target.
 * @param input - optional injected platform and environment facts.
 * @returns the absolute writable root with its source and legacy candidate.
 * @throws when `HARNESS_HOME` is set but blank.
 */
export function resolveHarnessHome(input: HarnessHomeInput = {}): HarnessHomeResolution {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const homeDir = input.homeDir ?? env.HOME ?? env.USERPROFILE ?? ''
  const paths = platformPaths(platform)
  const configured = env[HARNESS_HOME_ENV]
  if (configured !== undefined) {
    if (configured.trim().length === 0) throw new Error(`${HARNESS_HOME_ENV} must not be blank`)
    return {
      path: paths.resolve(expandHomePath(configured, homeDir, paths)) as HarnessHome,
      source: 'environment',
      legacyDshHome: env.DSH_HOME,
    }
  }
  return {
    path: defaultHarnessHome(platform, { ...env, LOCALAPPDATA: input.localAppData ?? env.LOCALAPPDATA }, homeDir),
    source: 'platform-default',
    legacyDshHome: env.DSH_HOME,
  }
}

/**
 * Resolve an application-provided root through the single `HARNESS_HOME` policy.
 * @param configuredHome - explicit writer configuration, when supplied.
 * @returns the absolute writable Harness Desktop data root.
 */
export function resolveConfiguredHarnessHome(configuredHome?: string): HarnessHome {
  if (configuredHome === undefined) return resolveHarnessHome().path
  return resolveHarnessHome({ env: { ...process.env, [HARNESS_HOME_ENV]: configuredHome } }).path
}

/**
 * Resolve one immutable provider for the caller's local durable writers.
 * @param config - platform and environment facts used exactly once to select the root.
 * @returns a provider that joins child paths beneath the resolved root.
 */
export function createLocalRuntimePlugin(config: HarnessHomeInput = {}): HarnessHomeProvider {
  const home = resolveHarnessHome(config).path
  return Object.freeze({
    home,
    path: (...segments: readonly string[]) => platformPaths(config.platform ?? process.platform).join(home, ...segments),
  })
}
