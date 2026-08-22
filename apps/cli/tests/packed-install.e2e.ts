import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

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
    const packed = await execa('pnpm', ['--dir', cliRoot, 'pack', '--pack-destination', packRoot], {
      cwd: repoRoot,
      reject: true,
    })
    const packedPath = packed.stdout.trim().split(/\r?\n/u).at(-1)!
    const tarball = isAbsolute(packedPath) ? packedPath : join(packRoot, packedPath)
    const installed = await execa('npm', [
      'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--prefix', prefix, tarball,
    ], {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
      reject: false,
    })
    expect(installed.exitCode, installed.stderr).toBe(0)

    const packageRoot = process.platform === 'win32'
      ? join(prefix, 'node_modules', '@harness-desktop', 'cli')
      : join(prefix, 'lib', 'node_modules', '@harness-desktop', 'cli')
    const main = await readFile(join(packageRoot, 'lib', 'main.js'), 'utf8')
    expect(main).not.toMatch(/(?:from|import\s*\()\s*["']@harness-desktop\//u)
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
  }, 300_000)
})
