/** Resolve one exclusive update-evidence snapshot root below the repository's ignored dist directory. */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Environment variable selecting the snapshot root shared by verification, evidence collection, and upload. */
export const updateSnapshotRootEnvironment = 'DSH_UPDATE_SNAPSHOT_ROOT'

/** Clean-checkout default used by the native artifact workflow. */
export const defaultUpdateSnapshotRoot = 'dist/ci-update-snapshots'

/** Inputs for resolving one repository-private snapshot root. */
export interface UpdateSnapshotRootOptions {
  readonly repositoryRoot: string
  readonly snapshotRoot?: string
  readonly environment?: Readonly<NodeJS.ProcessEnv>
}

/** One validated absolute and repository-relative snapshot root. */
export interface UpdateSnapshotRoot {
  readonly absolutePath: string
  readonly relativePath: string
}

/**
 * Resolve a snapshot root beneath `dist/` without creating or replacing it.
 * @param options - Repository root, typed override, and optional environment.
 * @returns Absolute and slash-normalized repository-relative paths.
 */
export function resolveUpdateSnapshotRoot(options: UpdateSnapshotRootOptions): UpdateSnapshotRoot {
  const repositoryRoot = resolve(options.repositoryRoot)
  const configured = options.snapshotRoot
    ?? options.environment?.[updateSnapshotRootEnvironment]
    ?? defaultUpdateSnapshotRoot
  if (configured.trim() !== configured || configured.length === 0 || configured.includes('\0')) {
    throw new Error(`${updateSnapshotRootEnvironment} is invalid`)
  }
  const distRoot = resolve(repositoryRoot, 'dist')
  const absolutePath = resolve(repositoryRoot, configured)
  const distRemainder = relative(distRoot, absolutePath)
  if (distRemainder === '' || distRemainder.startsWith('..') || isAbsolute(distRemainder)) {
    throw new Error(`${updateSnapshotRootEnvironment} must select a child of dist`)
  }
  return {
    absolutePath,
    relativePath: relative(repositoryRoot, absolutePath).split(sep).join('/'),
  }
}
