/// <reference types="node" />

import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist-cli')
export type PackageFormat = 'deb' | 'windows'
export type DebianArchitecture = 'amd64' | 'arm64'

export interface PackageOptions {
  format: PackageFormat
  input: string
  version: string
  architecture?: DebianArchitecture
  out?: string
}

export function packageName(format: PackageFormat, version: string, architecture: DebianArchitecture = 'amd64'): string {
  return format === 'deb' ? `dsh_${version}_${architecture}.deb` : `dsh-${version}-win-x64-setup.exe`
}

export function innoScript(input: string, version: string, destination: string): string {
  const q = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `[Setup]\nAppId={{D8A4A2A7-7BD5-4D34-BA3D-D2F1B4A4D5C1}}\nAppName=DeepSeek Harness\nAppVersion=${q(version)}\nDefaultDirName={localappdata}\\DeepSeek Harness\nDefaultGroupName=DeepSeek Harness\nUninstallDisplayName=DeepSeek Harness\nOutputDir=${q(destination)}\nOutputBaseFilename=dsh-${q(version)}-win-x64-setup\nPrivilegesRequired=lowest\nArchitecturesInstallIn64BitMode=x64\n\n[Files]\nSource: "${q(input)}"; DestDir: "{app}"; DestName: "dsh.exe"; Flags: ignoreversion\n\n[Icons]\nName: "{group}\\DeepSeek Harness"; Filename: "{app}\\dsh.exe"\n\n[UninstallDelete]\nType: filesandordirs; Name: "{app}"\n`
}

export async function createDebianTree(input: string, version: string, directory: string, architecture: DebianArchitecture = 'amd64'): Promise<void> {
  const debian = join(directory, 'DEBIAN')
  await mkdir(join(directory, 'usr', 'bin'), { recursive: true })
  await mkdir(debian, { recursive: true })
  await cp(input, join(directory, 'usr', 'bin', 'dsh'))
  await chmod(join(directory, 'usr', 'bin', 'dsh'), 0o755)
  await writeFile(join(debian, 'control'), `Package: dsh\nVersion: ${version}\nSection: devel\nPriority: optional\nArchitecture: ${architecture}\nMaintainer: DeepSeek AI <support@deepseek.com>\nDescription: DeepSeek Harness command-line agent harness\n Standalone dsh command-line runtime.\n`)
  await writeFile(join(debian, 'conffiles'), '')
}

function run(command: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? 'signal'}`))
    })
  })
}

export async function buildPackage(options: PackageOptions): Promise<string> {
  if (!existsSync(options.input)) throw new Error(`package input is missing: ${options.input}`)
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error(`invalid package version: ${options.version}`)
  const destination = resolve(options.out ?? output)
  await mkdir(destination, { recursive: true })
  const architecture = options.architecture ?? 'amd64'
  const name = packageName(options.format, options.version, architecture)
  if (options.format === 'deb') {
    const tree = join(destination, `.dsh-deb-${options.version}`)
    await rm(tree, { recursive: true, force: true })
    await createDebianTree(options.input, options.version, tree, architecture)
    await run('dpkg-deb', ['--build', '--root-owner-group', tree, join(destination, name)])
    await rm(tree, { recursive: true, force: true })
  } else {
    const script = join(destination, 'dsh-installer.iss')
    await writeFile(script, innoScript(options.input, options.version, destination))
    await run('iscc', [script])
    await rm(script, { force: true })
  }
  const bytes = await readFile(join(destination, name))
  const { createHash } = await import('node:crypto')
  await writeFile(join(destination, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`)
  return join(destination, name)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { format: { type: 'string' }, input: { type: 'string' }, version: { type: 'string' }, architecture: { type: 'string' }, out: { type: 'string' } } })
  const validArchitecture = values.architecture === undefined || values.architecture === 'amd64' || values.architecture === 'arm64'
  if ((values.format !== 'deb' && values.format !== 'windows') || values.input === undefined || values.version === undefined || !validArchitecture) {
    throw new Error('usage: package-cli-installers.ts --format <deb|windows> --input <executable> --version <version> [--architecture <amd64|arm64>] [--out <directory>]')
  }
  const architecture = values.architecture === 'amd64' || values.architecture === 'arm64' ? values.architecture : undefined
  await buildPackage({
    format: values.format,
    input: values.input,
    version: values.version,
    ...(architecture === undefined ? {} : { architecture }),
    ...(values.out === undefined ? {} : { out: values.out }),
  })
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main()

export { output }
