import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyCliStandalone } from '../../../scripts/release/verify-cli-standalone.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const version = process.env.DSH_NODE_RUNTIME_VERSION ?? '24.19.0'
const archiveDirectory = resolve(root, process.env.DSH_CLI_STANDALONE_OUTPUT ?? 'dist/cli-standalone')
const stem = `harness-cli-${version}-${process.platform}-${process.arch}`
const archiveExists = await access(resolve(archiveDirectory, `${stem}.zip`)).then(() => true, () => false)

describe.skipIf(!archiveExists)('standalone CLI native archive', () => {
  it('runs both archive formats through their bundled Node runtime from an empty directory', async () => {
    await expect(verifyCliStandalone({
      platform: process.platform,
      arch: process.arch,
      version,
      archiveDirectory,
    })).resolves.toEqual([])
  }, 120_000)
})
