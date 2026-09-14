/// <reference types="node" />

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = resolve(root, '.artifacts/cli-staging')
const output = resolve(root, 'dist-cli')
const pkgSpec = '@yao-pkg/pkg@6.21.0'
const targets = ['node24-linux-x64', 'node24-linux-arm64', 'node24-macos-x64', 'node24-macos-arm64', 'node24-win-x64'] as const
type Target = typeof targets[number]

function usage(): string {
  return `Usage: pnpm exec tsx scripts/build-cli-exe.ts --target=<target> [--skip-build] [--dry-run]\n\nBuilds a native CLI archive for ${targets.join(', ')}.\nThis is a CLI-only artifact; it does not build Electron, DMG, MSI, AppImage, or Python wheels.`
}

function run(command: string, args: string[]): Promise<void> {
  console.log(`build-cli-exe: ${command} ${args.join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? 'signal'}`)))
  })
}

async function materialize(path: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!existsSync(join(path, 'node_modules', name))) throw new Error(`staging dependency is missing: ${name}`)
  }
  const nodeModules = join(path, 'node_modules')
  const findLink = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name)
      if ((await lstat(candidate)).isSymbolicLink()) return candidate
      if (entry.isDirectory()) { const nested = await findLink(candidate); if (nested !== undefined) return nested }
    }
    return undefined
  }
  let link = await findLink(nodeModules)
  while (link !== undefined) {
    const targetPath = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(targetPath, link, { recursive: true, dereference: true })
    link = await findLink(nodeModules)
  }
}

async function prepareNativePty(target: Target): Promise<string | undefined> {
  const pty = join(staging, 'node_modules', 'node-pty')
  const build = join(pty, 'build')
  await rm(build, { recursive: true, force: true })
  const suffix = target.endsWith('arm64') ? 'arm64' : 'x64'
  const platform = target.includes('macos') ? 'darwin' : target.includes('win') ? 'win32' : undefined
  const sourceDir = platform === undefined
    ? join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release')
    : join(pty, 'prebuilds', `${platform}-${suffix}`)
  const addon = join(sourceDir, 'pty.node')
  if (!existsSync(addon)) throw new Error(`native node-pty addon is missing: ${addon}`)
  const release = join(build, 'Release')
  await mkdir(release, { recursive: true })
  if (platform === 'win32') {
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isFile()) await cp(join(sourceDir, entry.name), join(release, entry.name))
    }
  } else {
    await cp(addon, join(release, 'pty.node'))
  }
  if (platform === undefined || platform === 'win32') return undefined
  const helper = join(sourceDir, 'spawn-helper')
  if (!existsSync(helper)) throw new Error(`node-pty spawn helper is missing: ${helper}`)
  return helper
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { target: { type: 'string', default: process.env.DSH_CLI_TARGET }, 'skip-build': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help || values['dry-run']) { console.log(usage()); return }
  const target = values.target as Target | undefined
  if (target === undefined || !targets.includes(target)) throw new Error(`build-cli-exe: --target must be one of ${targets.join(', ')}`)
  const hostTarget = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux'
  const hostArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined
  if (!target.includes(hostTarget) || hostArch === undefined || !target.endsWith(hostArch)) {
    throw new Error(`build-cli-exe: target ${target} requires a native ${hostTarget}-${hostArch ?? process.arch} runner.`)
  }
  if (!values['skip-build']) await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:lib:host'])
  await rm(staging, { recursive: true, force: true }); await mkdir(resolve(root, '.artifacts'), { recursive: true })
  await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', '@stackstackstack/dsh', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', staging])
  await materialize(staging)
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, bin: 'lib/bin.js', pkg: { assets: ['config/**/*', 'node_modules/**/*.js', 'node_modules/**/*.cjs', 'node_modules/**/*.mjs', 'node_modules/**/package.json', 'node_modules/**/*.json', 'node_modules/**/*.node', 'node_modules/**/*.wasm'] } }, null, 2)}\n`)
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true })
  const helper = await prepareNativePty(target)
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  const stem = `dsh-${version}-${target.replace('node24-', '')}`
  const executable = join(output, `${stem}${target.includes('win') ? '.exe' : ''}`)
  await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['dlx', pkgSpec, staging, '--sea', '--targets', target, '--output', executable])
  if (!target.includes('win')) await chmod(executable, 0o755)
  await run(executable, ['--help']); await run(executable, ['--version']); await run(executable, ['web', '--dump-default-config'])
  const sidecar = helper === undefined ? undefined : join(output, `${stem}-spawn-helper`)
  if (sidecar !== undefined && helper !== undefined) { await cp(helper, sidecar); await chmod(sidecar, 0o755) }
  const archive = join(output, target.includes('win') ? `${stem}.zip` : `${stem}.tar.gz`)
  if (target.includes('win')) await run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${executable}' -DestinationPath '${archive}'`])
  else await run('tar', ['-czf', archive, '-C', output, basename(executable), ...(sidecar === undefined ? [] : [basename(sidecar)])])
  const digest = createHash('sha256').update(await (await import('node:fs/promises')).readFile(archive)).digest('hex')
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`)
  console.log(`build-cli-exe: wrote ${archive} and ${archive}.sha256`)
}

await main()

export { usage, targets }
