/** Verify one downloaded Node distribution against the repository-pinned allowlist. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import checksumAllowlistJson from './node-runtime-checksums.json' with { type: 'json' }
import type { NodeRuntimeChecksumAllowlist } from './build-cli-standalone.ts'

export type { NodeRuntimeChecksumAllowlist } from './build-cli-standalone.ts'

/** GitHub runner values and the local archive selected before this check. */
export interface NodeRuntimeArchiveVerificationInput {
  readonly runtimeRoot: string
  readonly filename: string
  readonly version: string
  readonly runnerOS: string
  readonly runnerArch: string
}

/**
 * Verify one named local archive before any extraction or runtime use.
 * @param input - downloaded archive location and GitHub runner identity.
 * @param allowlist - repository-owned filename and SHA-256 entries.
 * @returns when the exact allowlisted archive bytes match.
 */
export async function verifyNodeRuntimeArchive(
  input: NodeRuntimeArchiveVerificationInput,
  allowlist: NodeRuntimeChecksumAllowlist = checksumAllowlistJson,
): Promise<void> {
  const platform = runnerPlatform(input.runnerOS)
  const arch = runnerArchitecture(input.runnerArch)
  const expected = allowlist[input.version]?.[platform]?.[arch]
  if (expected === undefined) {
    throw new Error(`Node runtime verification: no pinned archive for ${input.version}/${platform}/${arch}`)
  }
  if (input.filename !== expected.filename) {
    throw new Error(`Node runtime verification: filename does not match pinned archive ${expected.filename}`)
  }
  const bytes = await readFile(join(input.runtimeRoot, expected.filename))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected.sha256) {
    throw new Error(`Node runtime verification: checksum mismatch for ${expected.filename}`)
  }
}

function runnerPlatform(value: string): NodeJS.Platform {
  switch (value) {
    case 'Windows': return 'win32'
    case 'macOS': return 'darwin'
    case 'Linux': return 'linux'
    default: throw new Error(`Node runtime verification: unsupported runner OS ${JSON.stringify(value)}`)
  }
}

function runnerArchitecture(value: string): string {
  switch (value) {
    case 'X64': return 'x64'
    case 'ARM64': return 'arm64'
    default: throw new Error(`Node runtime verification: unsupported runner architecture ${JSON.stringify(value)}`)
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`Node runtime verification: ${name} is required`)
  return value
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new Error('usage: verify-node-runtime-archive.ts')
  await verifyNodeRuntimeArchive({
    runtimeRoot: requiredEnvironment('DSH_NODE_RUNTIME_ROOT'),
    filename: requiredEnvironment('DSH_NODE_RUNTIME_FILENAME'),
    version: requiredEnvironment('DSH_NODE_RUNTIME_VERSION'),
    runnerOS: requiredEnvironment('RUNNER_OS'),
    runnerArch: requiredEnvironment('RUNNER_ARCH'),
  })
  process.stdout.write('release:verify-node-runtime-archive: repository-pinned SHA-256 verified.\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2))
}
