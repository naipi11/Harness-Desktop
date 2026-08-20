import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/** Source entries must share the same product-command parser. */
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
  ])('loads %s help and reports malformed syntax without profile diagnostics', async (commandName, sourceBin) => {
    const help = await execa(process.execPath, ['--import', 'tsx/esm', sourceBin, '--help'], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (help.timedOut) {
      throw new Error(`${commandName} source help did not exit within 25s. stdout:\n${help.stdout}\nstderr:\n${help.stderr}`)
    }
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain(`${commandName} run "fix the tests" --json`)

    const malformed = await execa(process.execPath, ['--import', 'tsx/esm', sourceBin, 'run', '--json'], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    expect(malformed.exitCode).toBe(2)
    expect(malformed.stderr).toContain('run needs exactly one task')
    expect(malformed.stderr).not.toContain('--profile')
  }, 60_000)
})
