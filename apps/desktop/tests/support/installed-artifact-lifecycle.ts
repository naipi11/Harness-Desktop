/** Failure-safe lifecycle helpers shared by native installed-artifact fixtures and unit tests. */

import { access } from 'node:fs/promises'

/** Minimum launched fixture lifecycle needed by installed-artifact acceptance. */
export interface InstalledArtifactRuntimeFixture {
  close(options: { readonly preserveRuntimeRoot: true }): Promise<void>
}

/** Installed artifact operations owned across launch, verification, removal, and cleanup. */
export interface InstalledArtifactLifecycle<T extends InstalledArtifactRuntimeFixture = InstalledArtifactRuntimeFixture> {
  readonly name: string
  readonly sentinelPath: string
  launch(): Promise<T>
  remove(): Promise<void>
  cleanup(): Promise<void>
}

/**
 * Exercise one prepared artifact while retaining cleanup ownership across every failure path.
 * @param artifact - prepared native artifact.
 * @param verify - authenticated launch and installed-resource assertions.
 */
export async function runInstalledArtifactLifecycle<T extends InstalledArtifactRuntimeFixture>(
  artifact: InstalledArtifactLifecycle<T>,
  verify: (fixture: T) => Promise<void>,
): Promise<void> {
  let fixture: T | undefined
  let removalAttempted = false
  let primaryFailure: unknown
  const cleanupFailures: unknown[] = []
  try {
    fixture = await artifact.launch()
    await verify(fixture)
    await fixture.close({ preserveRuntimeRoot: true })
    fixture = undefined
    removalAttempted = true
    await artifact.remove()
    await access(artifact.sentinelPath)
  } catch (error) {
    primaryFailure = error
  } finally {
    if (fixture !== undefined) {
      await fixture.close({ preserveRuntimeRoot: true }).catch((error: unknown) => cleanupFailures.push(error))
    }
    if (!removalAttempted) await artifact.remove().catch((error: unknown) => cleanupFailures.push(error))
    await artifact.cleanup().catch((error: unknown) => cleanupFailures.push(error))
  }
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], `installed desktop artifact: ${artifact.name} lifecycle and cleanup failed`)
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, `installed desktop artifact: ${artifact.name} cleanup failed`)
}

/** @returns whether native AppImage launch failed specifically because FUSE mounting is unavailable. */
export function isAppImageFuseUnavailable(error: unknown): boolean {
  return /(?:FUSE|libfuse|AppImage mount)/iu.test(String(error))
}

/**
 * Launch an AppImage natively and use its extracted AppRun only for a FUSE-specific failure.
 * @param appImage - packaged AppImage path.
 * @param appRun - extracted squashfs-root/AppRun path.
 * @param launch - native fixture launcher.
 * @returns the launched fixture.
 */
export async function launchAppImageWithFallback<T>(
  appImage: string,
  appRun: string,
  launch: (path: string) => Promise<T>,
): Promise<T> {
  try {
    return await launch(appImage)
  } catch (error) {
    if (!isAppImageFuseUnavailable(error)) throw error
    process.stderr.write('installed desktop artifact: AppImage FUSE unavailable; using extracted AppRun fallback\n')
    return await launch(appRun)
  }
}

/** Cleanup operations owned after a Windows installer has reported success. */
export interface WindowsPreparationRollbackDependencies {
  findUninstaller(): Promise<string>
  runUninstaller(path: string): Promise<void>
  waitForRemoval(): Promise<void>
  removeRoot(): Promise<void>
}

/**
 * Roll back a successful NSIS install whose installed-file validation failed.
 * @param primaryFailure - validation failure that triggered rollback.
 * @param dependencies - generated-uninstaller and temporary-root cleanup operations.
 * @throws the primary failure, or an aggregate retaining every cleanup failure.
 */
export async function rollbackWindowsPreparation(
  primaryFailure: unknown,
  dependencies: WindowsPreparationRollbackDependencies,
): Promise<never> {
  const cleanupFailures: unknown[] = []
  try {
    const uninstaller = await dependencies.findUninstaller()
    await dependencies.runUninstaller(uninstaller)
    await dependencies.waitForRemoval()
  } catch (error) {
    cleanupFailures.push(error)
  }
  try {
    await dependencies.removeRoot()
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'installed desktop artifact: Windows preparation validation and rollback failed',
    )
  }
  throw primaryFailure
}
