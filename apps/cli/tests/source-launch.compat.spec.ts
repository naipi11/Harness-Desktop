import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE CLI execution: run both app entries with the exact
 * production runtime vector (`node --import tsx/esm`, the vector the root
 * scripts invoke directly) and assert the
 * required-config diagnostic. The Node compatibility matrix runs this
 * WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const harnessSourceBin = 'apps/cli/src/bin.ts'
const dshSourceBin = 'apps/cli/src/dsh-bin.ts'

describe('SOURCE CLI launchers (node --import tsx/esm)', () => {
  it('maps both root scripts to their source entries', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.harness).toBe('node --import tsx/esm apps/cli/src/bin.ts')
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm apps/cli/src/dsh-bin.ts')
  })

  it.each([
    ['harness', harnessSourceBin],
    ['dsh', dshSourceBin],
  ])('boots the %s source entry and requires a profile', async (commandName, sourceBin) => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', sourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`${commandName} source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)
})
