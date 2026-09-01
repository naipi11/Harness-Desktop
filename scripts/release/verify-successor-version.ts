/** Verify that Desktop and CLI artifacts use one unused successor to the published v1.0.0 release. */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const publishedStableVersion = '1.0.0'

/** Return release-version diagnostics without creating or moving a tag. */
export function successorVersionViolations(
  versions: readonly string[],
  tags: readonly string[],
  remoteTag: 'absent' | 'exists' | 'query-failed' = 'absent',
): readonly string[] {
  if (new Set(versions).size !== 1 || versions[0] === undefined) return ['release successor: root, CLI, and Desktop versions differ']
  const version = versions[0]
  if (!isStrictVersion(version) || compare(version, publishedStableVersion) <= 0) {
    return [`release successor: ${version} is not newer than published v${publishedStableVersion}`]
  }
  if (tags.includes(`v${version}`) || remoteTag === 'exists') return [`release successor: public tag v${version} already exists`]
  return remoteTag === 'query-failed' ? ['release successor: authoritative remote tag query failed'] : []
}

/** Verify local metadata and refs without mutating Git or release state. */
export async function verifySuccessorVersion(repositoryRoot = root): Promise<void> {
  const manifests = await Promise.all(['package.json', 'apps/cli/package.json', 'apps/desktop/package.json'].map(async (path) => {
    const value = JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')) as { readonly version?: unknown }
    if (typeof value.version !== 'string') throw new Error(`release successor: ${path} omits version`)
    return value.version
  }))
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split(/\r?\n/u).filter(tag => tag !== '')
  const version = manifests[0]
  if (version === undefined) throw new Error('release successor: version metadata is absent')
  const violations = successorVersionViolations(manifests, tags, queryRemoteTag(repositoryRoot, version))
  if (violations.length > 0) throw new Error(violations.join('\n'))
}

/** Query the authoritative origin ref without fetching, creating, or moving a local tag. */
export function queryRemoteTag(
  repositoryRoot: string,
  version: string,
  run: (file: string, args: readonly string[], options: Parameters<typeof execFileSync>[2]) => unknown = execFileSync,
): 'absent' | 'exists' | 'query-failed' {
  try {
    run('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${version}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return 'exists'
  } catch (error) {
    return (error as { readonly status?: unknown }).status === 2 ? 'absent' : 'query-failed'
  }
}

function isStrictVersion(value: string): boolean { return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value) }

function compare(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifySuccessorVersion()
  process.stdout.write('release: successor version is unique.\n')
}
