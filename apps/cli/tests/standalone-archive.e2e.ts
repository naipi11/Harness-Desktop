import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { verifyCliStandalone } from '../../../scripts/release/verify-cli-standalone.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const version = process.env.DSH_NODE_RUNTIME_VERSION ?? '24.19.0'
const archiveDirectory = resolve(root, process.env.DSH_CLI_STANDALONE_OUTPUT ?? 'dist/cli-standalone')
const stem = `harness-cli-${version}-${process.platform}-${process.arch}`
const archiveExists = await access(resolve(archiveDirectory, `${stem}.zip`)).then(() => true, () => false)

describe.skipIf(!archiveExists)('standalone CLI native archive', () => {
  it('runs every bundled child without ambient Node or TypeScript loader state', async () => {
    const hostileRoot = await mkdtemp(join(tmpdir(), 'harness-standalone-hostile-loader-'))
    const marker = join(hostileRoot, 'ambient-loader-ran.jsonl')
    const loader = join(hostileRoot, 'ambient-loader.mjs')
    await writeFile(loader, [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      '  nodeOptions: process.env.NODE_OPTIONS,',
      '  nodePath: process.env.NODE_PATH,',
      '  tsxTsconfigPath: process.env.TSX_TSCONFIG_PATH,',
      '  tsNodeProject: process.env.TS_NODE_PROJECT,',
      "}) + '\\n')",
      '',
    ].join('\n'))
    const hostileEnvironment = {
      NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`,
      NODE_PATH: hostileRoot,
      TSX_TSCONFIG_PATH: join(hostileRoot, 'hostile-tsconfig.json'),
      TS_NODE_PROJECT: join(hostileRoot, 'hostile-ts-node.json'),
    } as const
    try {
      for (const [name, value] of Object.entries(hostileEnvironment)) vi.stubEnv(name, value)
      await expect(verifyCliStandalone({
        platform: process.platform,
        arch: process.arch,
        version,
        archiveDirectory,
      })).resolves.toEqual([])
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.unstubAllEnvs()
      await rm(hostileRoot, { recursive: true, force: true })
    }
  }, 300_000)
})
