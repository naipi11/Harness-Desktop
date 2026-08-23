import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { packCliForRelease } from '../../../scripts/release/build-cli-standalone.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliRoot = fileURLToPath(new URL('..', import.meta.url))
const builtBin = join(cliRoot, 'lib', 'bin.js')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label))
  roots.push(root)
  return root
}

describe.skipIf(!(await access(builtBin).then(() => true, () => false)))('packed CLI offline installation', () => {
  it('installs from the tarball into an empty prefix and runs both package-owned bins', async () => {
    const root = await temporaryRoot('harness-packed-cli-')
    const packRoot = join(root, 'pack')
    const prefix = join(root, 'prefix')
    const cache = join(root, 'empty-cache')
    const tarball = process.env.DSH_PACKED_CLI_TARBALL ?? await packCliForRelease(packRoot)
    const installed = await execa('npm', [
      'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefix', prefix, tarball,
    ], {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
      reject: false,
    })
    expect(installed.exitCode, installed.stderr).toBe(0)

    const globalModules = process.platform === 'win32'
      ? join(prefix, 'node_modules')
      : join(prefix, 'lib', 'node_modules')
    const packageRoot = join(globalModules, '@harness-desktop', 'cli')
    const closureModules = join(packageRoot, 'node_modules')
    for (const path of [
      ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'lib', 'bin.js'],
      ['node_modules', '@harness-desktop', 'dsh-host-local-runtime', 'runtime.cordis.yml'],
      ['node_modules', '@harness-desktop', 'dsh-base', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-web-app', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-headless', 'cordis.patch.yml'],
      ['node_modules', '@harness-desktop', 'dsh-workflow-worker-thread', 'lib', 'worker.cjs'],
    ]) {
      await expect(access(join(closureModules, ...path.slice(1)))).resolves.toBeUndefined()
    }
    const main = await readFile(join(packageRoot, 'lib', 'main.js'), 'utf8')
    expect(main).toContain('from "@harness-desktop/dsh-host-local-runtime"')
    const imports = await execa(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./lib/main.js')",
    ], { cwd: packageRoot, reject: false })
    expect(imports.exitCode, imports.stderr).toBe(0)

    const binRoot = process.platform === 'win32' ? prefix : join(prefix, 'bin')
    const suffix = process.platform === 'win32' ? '.cmd' : ''
    const harness = await execa(join(binRoot, `harness${suffix}`), ['--help'], { cwd: root, reject: false })
    const dsh = await execa(join(binRoot, `dsh${suffix}`), ['--help'], { cwd: root, reject: false })
    expect(harness.exitCode, harness.stderr).toBe(0)
    expect(harness.stdout).toMatch(/^Usage: harness/mu)
    expect(dsh.exitCode, dsh.stderr).toBe(0)
    expect(dsh.stdout).toMatch(/^Usage: dsh/mu)
    expect(harness.stdout).not.toContain(repoRoot)
    expect(dsh.stdout).not.toContain(repoRoot)

    const harnessHome = join(root, 'runtime-home')
    const runtimeEnv = {
      ...process.env,
      HARNESS_HOME: harnessHome,
      DSH_HOME: '',
      HOME: join(root, 'platform-home'),
      USERPROFILE: join(root, 'platform-home'),
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    }
    let runtimePid: number | undefined
    try {
      const start = await execa(join(binRoot, `harness${suffix}`), ['web', '--background', '--no-open'], {
        cwd: root,
        env: runtimeEnv,
        reject: false,
        timeout: 90_000,
      })
      expect(start.exitCode, start.stderr).toBe(0)
      expect(start.stdout).toBe('Web lease: web present')
      const endpoint = JSON.parse(await readFile(join(harnessHome, 'runtime-endpoint.json'), 'utf8')) as {
        readonly process: { readonly pid: number }
      }
      runtimePid = endpoint.process.pid
      expect(runtimePid).not.toBe(process.pid)

      const status = await execa(join(binRoot, `dsh${suffix}`), ['web', '--status'], {
        cwd: root, env: runtimeEnv, reject: false, timeout: 30_000,
      })
      expect(status.exitCode, status.stderr).toBe(0)
      expect(status.stdout).toContain('Runtime: running')
      expect(status.stdout).toContain('Web lease: web present')

      const stopped = await execa(join(binRoot, `harness${suffix}`), ['web', '--stop'], {
        cwd: root, env: runtimeEnv, reject: false, timeout: 30_000,
      })
      expect(stopped.exitCode, stopped.stderr).toBe(0)
      expect(stopped.stdout).toBe('Web lease: web absent')
    } finally {
      if (runtimePid !== undefined) {
        try { process.kill(runtimePid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        await waitForProcessExit(runtimePid)
      }
    }
  }, 300_000)
})

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`packed CLI Runtime ${String(pid)} did not exit`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
