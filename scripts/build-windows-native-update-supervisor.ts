/** Build the dependency-free x64 Windows update supervisor with MSVC Build Tools. */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'apps', 'desktop', 'native', 'windows-native-update-supervisor.c')
const outputDirectory = join(root, 'apps', 'desktop', 'out', 'native', 'win32-x64')
const executable = join(outputDirectory, 'windows-native-update-supervisor.exe')
const object = join(outputDirectory, 'windows-native-update-supervisor.obj')

/** Compile the current Windows native update supervisor source for x64. */
export function buildWindowsNativeUpdateSupervisor(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Windows native update supervisor requires a win32/x64 host, received ${process.platform}/${process.arch}`)
  }

  const vswhere = locateVswhere()
  const installationPath = execFileSync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ], { encoding: 'utf8', windowsHide: true }).trim()
  if (installationPath === '') throw new Error('Visual Studio Build Tools with MSVC x64 were not found')

  const vsDevCmd = join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat')
  if (!existsSync(vsDevCmd)) throw new Error('Visual Studio Build Tools did not provide VsDevCmd.bat')
  if (!existsSync(source)) throw new Error('Windows native update supervisor source is missing')
  mkdirSync(outputDirectory, { recursive: true })

  const compile = [
    'cl.exe',
    '/nologo',
    '/W4',
    '/WX',
    '/O1',
    '/MT',
    '/Brepro',
    '/utf-8',
    quoteForCmd(source),
    `/Fo${quoteForCmd(object)}`,
    `/Fe${quoteForCmd(executable)}`,
    '/link',
    '/Brepro',
    '/SUBSYSTEM:WINDOWS',
    '/MACHINE:X64',
    'shell32.lib',
  ].join(' ')
  const command = `call ${quoteForCmd(vsDevCmd)} -no_logo -arch=x64 -host_arch=x64 && ${compile}`
  const comspec = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const build = spawnSync(comspec, ['/d', '/c', command], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsVerbatimArguments: true,
    windowsHide: true,
  })
  if (build.error !== undefined) throw build.error
  if (build.status !== 0) throw new Error(`MSVC exited with status ${String(build.status)}`)
}

function locateVswhere(): string {
  const candidates = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
  ].filter((directory): directory is string => directory !== undefined)
    .map(directory => join(directory, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))
  const executablePath = candidates.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('Visual Studio Installer vswhere.exe was not found')
  return executablePath
}

function quoteForCmd(value: string): string {
  if (value.includes('"')) throw new Error('MSVC input path contains an unsupported quote')
  return `"${value}"`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildWindowsNativeUpdateSupervisor()
}
