import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@harness-desktop/dsh-loader-smoke'

const configPath = '/tmp/fixture.cordis.yml'
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))
// macOS realpaths temp dirs into /private; TMPDIR may live under /var or /tmp.
const canonicalTempPath = (path: string): string => path.replace(/^\/private(?=\/(?:var|tmp)\/)/, '')

describe('runLoaderSmoke', () => {
  it('isolates the process, closes stdin, captures output, and removes the cwd', async () => {
    const result = await runLoaderSmoke({
      label: 'success fixture',
      tempDirPrefix: 'loader-smoke-success-',
      binScript: fixture('success'),
      configPath,
      tsconfigPath,
      mode: 'src',
      env: { LOADER_SMOKE_MARKER: 'present' },
    })
    const output = JSON.parse(result.stdout) as {
      configPath: string
      args: string[]
      cwd: string
      harnessHome: string
      agentsHome: string
      marker: string
      input: string
    }
    expect(output).toMatchObject({
      configPath,
      args: [configPath],
      marker: 'present',
      input: '',
    })
    expect(canonicalTempPath(output.harnessHome)).toBe(canonicalTempPath(join(output.cwd, '.harness-home')))
    expect(canonicalTempPath(output.agentsHome)).toBe(canonicalTempPath(join(output.cwd, '.agents')))
    expect(result.stderr).toContain('fixture stderr')
    expect(existsSync(output.cwd)).toBe(false)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('passes an arbitrary bin argv and inspects world state before cleanup', async () => {
    let inspected = ''
    let marker = ''
    let preparedHarnessHome = ''
    let inspectedHarnessHome = ''
    const result = await runLoaderSmoke({
      label: 'argv fixture',
      tempDirPrefix: 'loader-smoke-argv-',
      binScript: fixture('success'),
      libBinScript: fixture('success'),
      configPath,
      binArgs: ['--config', configPath, '--output-format', 'json', 'task with spaces'],
      tsconfigPath,
      prepare: (cwd, harnessHome) => {
        preparedHarnessHome = harnessHome
        return writeFile(join(cwd, 'marker.txt'), 'prepared')
      },
      inspect: async (cwd, harnessHome) => {
        inspected = cwd
        inspectedHarnessHome = harnessHome
        marker = await readFile(join(cwd, 'marker.txt'), 'utf8')
      },
    })
    const output = JSON.parse(result.stdout) as { args: string[]; cwd: string; harnessHome: string }
    expect(output.args).toEqual(['--config', configPath, '--output-format', 'json', 'task with spaces'])
    expect(canonicalTempPath(inspected)).toBe(canonicalTempPath(output.cwd))
    expect(canonicalTempPath(preparedHarnessHome)).toBe(canonicalTempPath(output.harnessHome))
    expect(canonicalTempPath(inspectedHarnessHome)).toBe(canonicalTempPath(output.harnessHome))
    expect(marker).toBe('prepared')
    expect(existsSync(inspected)).toBe(false)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('uses an environment override as the callback and child Harness home', async () => {
    const owner = await mkdtemp(join(tmpdir(), 'loader-smoke-home-override-'))
    const override = `${join(owner, 'nested')}/../effective-home`
    const expected = join(owner, 'effective-home')
    let preparedHarnessHome = ''
    let inspectedHarnessHome = ''
    try {
      const result = await runLoaderSmoke({
        label: 'Harness home override fixture',
        tempDirPrefix: 'loader-smoke-home-override-cwd-',
        binScript: fixture('success'),
        libBinScript: fixture('success'),
        configPath,
        tsconfigPath,
        env: { HARNESS_HOME: override },
        prepare: (_cwd, harnessHome) => { preparedHarnessHome = harnessHome },
        inspect: (_cwd, harnessHome) => { inspectedHarnessHome = harnessHome },
      })
      const output = JSON.parse(result.stdout) as { harnessHome: string }
      expect(canonicalTempPath(preparedHarnessHome)).toBe(canonicalTempPath(expected))
      expect(canonicalTempPath(inspectedHarnessHome)).toBe(canonicalTempPath(expected))
      expect(canonicalTempPath(output.harnessHome)).toBe(canonicalTempPath(expected))
    } finally {
      await rm(owner, { recursive: true, force: true })
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('rejects a relative Harness home before callbacks or child startup', async () => {
    let prepared = false
    await expect(runLoaderSmoke({
      label: 'relative Harness home fixture',
      tempDirPrefix: 'loader-smoke-relative-home-',
      binScript: fixture('success'),
      libBinScript: fixture('success'),
      configPath,
      tsconfigPath,
      env: { HARNESS_HOME: './relative-home' },
      prepare: () => { prepared = true },
    })).rejects.toThrow('runLoaderSmoke: env.HARNESS_HOME must be an absolute path')
    expect(prepared).toBe(false)
  })

  it('rejects a non-zero exit with captured diagnostics', async () => {
    await expect(runLoaderSmoke({
      label: 'failure fixture',
      tempDirPrefix: 'loader-smoke-fail-',
      binScript: fixture('fail'),
      libBinScript: fixture('fail'),
      configPath,
      tsconfigPath,
    })).rejects.toThrow('failure fixture exited 7 (expected 0). stdout:\n\nstderr:\nfixture failed')
  })

  it('accepts a declared expected failure exit and rejects any other outcome', async () => {
    // A scenario pinning a designed failure surface declares its exit code…
    const declared = await runLoaderSmoke({
      label: 'declared failure fixture',
      tempDirPrefix: 'loader-smoke-declared-fail-',
      binScript: fixture('fail'),
      libBinScript: fixture('fail'),
      configPath,
      tsconfigPath,
      expectedExitCode: 7,
    })
    expect(declared.stderr).toBe('fixture failed\n')

    // …and a run that succeeds instead still fails the smoke.
    await expect(runLoaderSmoke({
      label: 'unexpectedly clean fixture',
      tempDirPrefix: 'loader-smoke-clean-',
      binScript: fixture('success'),
      libBinScript: fixture('success'),
      configPath,
      tsconfigPath,
      expectedExitCode: 7,
    })).rejects.toThrow(/exited 0 \(expected 7\)/)
  })

  it('kills a process at its deadline and reports captured output', async () => {
    await expect(runLoaderSmoke({
      label: 'hanging fixture',
      tempDirPrefix: 'loader-smoke-hang-',
      binScript: fixture('hang'),
      libBinScript: fixture('hang'),
      configPath,
      tsconfigPath,
      processTimeoutMs: 100,
    })).rejects.toThrow('hanging fixture did not exit within 0.1s.')
  })
})
