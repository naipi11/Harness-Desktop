import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyCliStandalone } from '../../../scripts/release/verify-cli-standalone.ts'
import { standaloneCliUpdateTarget } from '@harness-desktop/dsh-update-policy'
import cliPackage from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../../..', import.meta.url))
const nodeVersion = process.env.DSH_NODE_RUNTIME_VERSION ?? '24.19.0'
const cliVersion = process.env.DSH_CLI_VERSION ?? cliPackage.version
const archiveDirectory = resolve(root, process.env.DSH_CLI_STANDALONE_OUTPUT ?? 'dist/cli-standalone')
const stem = `harness-cli-${cliVersion}-${process.platform}-${process.arch}`
const target = standaloneCliUpdateTarget(process.platform, process.arch)
const archiveExists = target !== undefined && await access(resolve(archiveDirectory, `${stem}.${target.format}`)).then(() => true, () => false)

describe.skipIf(!archiveExists)('standalone CLI native archive', () => {
  it('runs the verifier-owned hostile loader proof for the platform-owned archive format', async () => {
    await expect(verifyCliStandalone({
      platform: process.platform,
      arch: process.arch,
      nodeVersion,
      cliVersion,
      archiveDirectory,
    })).resolves.toEqual([])
  }, 300_000)
})
