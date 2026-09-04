/** Build one packed CLI artifact outside Vitest retry/time accounting, then run its acceptance once. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { packCliForRelease } from './build-cli-standalone.ts'

const root = resolve(import.meta.dirname, '../..')

/** Build once and run the formal installed acceptance with retries and file parallelism disabled. */
export async function verifyPackedCli(): Promise<void> {
  const output = await mkdtemp(join(tmpdir(), 'harness-packed-cli-release-'))
  try {
    const started = Date.now()
    const tarball = await packCliForRelease(output)
    process.stdout.write(`release: packed CLI prepared in ${String(Date.now() - started)} ms.\n`)
    await execa('pnpm', [
      'exec', 'vitest', 'run', '--config', 'vitest.e2e.config.ts', '--retry=0', '--maxWorkers=1',
      '--no-file-parallelism', 'apps/cli/tests/packed-install.e2e.ts',
    ], {
      cwd: root,
      env: { ...process.env, DSH_PACKED_CLI_TARBALL: tarball, DSH_REQUIRE_BUILT_CLI_SMOKE: '1' },
      reject: true,
      stdio: 'inherit',
    })
  } finally {
    await rm(output, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyPackedCli()
