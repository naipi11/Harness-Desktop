/** Inspect one native Desktop release without installing or publishing it. */

import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { path7za } from '7zip-bin'
import { execa } from 'execa'
import { inspectUpdateArtifact } from './verify-update-manifests.ts'

const root = resolve(import.meta.dirname, '../..')
const generatedIconNames = {
  win32: 'harness-desktop.ico',
  darwin: 'harness-desktop.icns',
  linux: 'harness-desktop.png',
} as const

/** Results returned by native tools after inspecting a mounted macOS DMG. */
export interface MacDmgInspection {
  readonly entries: readonly string[]
  readonly lipoInfo: string
}

/** Native-tool operations isolated for platform-independent unit tests. */
export interface DesktopArtifactTools {
  inspectWindowsInstaller(path: string): Promise<readonly string[]>
  inspectAsar(path: string): Promise<readonly string[]>
  inspectMacDmg(path: string): Promise<MacDmgInspection>
  inspectAppImage(path: string): Promise<readonly string[]>
  inspectDeb(path: string): Promise<readonly string[]>
}

/** Inputs selecting the current runner's native artifact matrix. */
export interface DesktopArtifactVerificationInput {
  readonly platform: NodeJS.Platform
  readonly releaseDirectory: string
}

/**
 * Verify the installer matrix for one native runner.
 * @param input - native platform and Electron Builder release directory.
 * @returns diagnostics; an empty array means every expected artifact and icon was found.
 */
export async function verifyDesktopArtifacts(
  input: DesktopArtifactVerificationInput,
): Promise<readonly string[]> {
  return verifyDesktopArtifactsWithTools(input, nativeDesktopArtifactTools)
}

/**
 * Verify native artifacts with injected external-tool operations.
 * @param input - native platform and Electron Builder release directory.
 * @param tools - native installer inspection operations.
 * @returns diagnostics; an empty array means the selected artifact matrix is complete.
 */
export async function verifyDesktopArtifactsWithTools(
  input: DesktopArtifactVerificationInput,
  tools: DesktopArtifactTools,
): Promise<readonly string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(input.releaseDirectory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    entries = []
  }
  switch (input.platform) {
    case 'win32':
      return verifyWindows(input.releaseDirectory, entries, tools)
    case 'darwin':
      return verifyMac(input.releaseDirectory, entries, tools)
    case 'linux':
      return verifyLinux(input.releaseDirectory, entries, tools)
    default:
      return [`desktop artifact: unsupported platform ${input.platform}`]
  }
}

async function verifyWindows(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
): Promise<readonly string[]> {
  const violations: string[] = []
  const installers = entries.filter(entry => entry.isFile()
    && /^Harness Desktop Setup \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/u.test(entry.name))
  const installer = installers[0]
  if (installers.length === 0) violations.push('desktop artifact: missing Windows NSIS installer')
  else if (installers.length > 1) violations.push('desktop artifact: expected exactly one Windows NSIS installer')
  else if (installer !== undefined) await tools.inspectWindowsInstaller(join(releaseDirectory, installer.name))

  const unpacked = entries.filter(entry => entry.isDirectory()
    && /^win(?:-(?:arm64|ia32))?-unpacked$/u.test(entry.name))
  const unpackedDirectory = unpacked.length === 1 ? unpacked[0] : undefined
  const executable = unpackedDirectory !== undefined
    ? join(releaseDirectory, unpackedDirectory.name, 'harness-desktop.exe')
    : undefined
  const asar = unpackedDirectory !== undefined
    ? join(releaseDirectory, unpackedDirectory.name, 'resources', 'app.asar')
    : undefined
  if (executable === undefined || !(await exists(executable))) {
    violations.push('desktop artifact: missing unpacked Windows executable')
  }
  if (asar === undefined || !(await exists(asar))) {
    violations.push('desktop artifact: missing unpacked Windows resources/app.asar')
  } else {
    const asarEntries = await tools.inspectAsar(asar)
    if (!containsIcon(asarEntries, generatedIconNames.win32)) {
      violations.push('desktop artifact: missing generated Windows icon')
    }
  }
  return violations
}

async function verifyMac(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
): Promise<readonly string[]> {
  const violations: string[] = []
  const images = entries.filter(entry => entry.isFile()
    && /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-universal\.dmg$/u.test(entry.name))
  if (images.length === 0) return ['desktop artifact: missing macOS universal DMG']
  if (images.length > 1) return ['desktop artifact: expected exactly one macOS universal DMG']
  const image = images[0]
  if (image === undefined) throw new Error('desktop artifact: validated macOS DMG disappeared')
  const inspection = await tools.inspectMacDmg(join(releaseDirectory, image.name))
  if (!/\bx86_64\b/u.test(inspection.lipoInfo)) {
    violations.push('desktop artifact: macOS application binary is missing x86_64 architecture')
  }
  if (!/\barm64\b/u.test(inspection.lipoInfo)) {
    violations.push('desktop artifact: macOS application binary is missing arm64 architecture')
  }
  if (!containsIcon(inspection.entries, generatedIconNames.darwin)) {
    violations.push('desktop artifact: missing generated macOS icon')
  }
  return violations
}

async function verifyLinux(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
): Promise<readonly string[]> {
  const violations: string[] = []
  const appImages = entries.filter(entry => entry.isFile()
    && /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.AppImage$/u.test(entry.name))
  const debs = entries.filter(entry => entry.isFile()
    && /^harness-desktop_\d+\.\d+\.\d+(?:[+~.-][0-9A-Za-z.-]+)?_(?:amd64|arm64)\.deb$/u.test(entry.name))
  if (appImages.length === 0) violations.push('desktop artifact: missing Linux AppImage')
  else if (appImages.length > 1) violations.push('desktop artifact: expected exactly one Linux AppImage')
  if (debs.length === 0) violations.push('desktop artifact: missing Linux Deb installer')
  else if (debs.length > 1) violations.push('desktop artifact: expected exactly one Linux Deb installer')

  const appImage = appImages.length === 1 ? appImages[0] : undefined
  const deb = debs.length === 1 ? debs[0] : undefined
  if (appImage !== undefined) {
    const inspected = await tools.inspectAppImage(join(releaseDirectory, appImage.name))
    if (!containsIcon(inspected, generatedIconNames.linux)) {
      violations.push('desktop artifact: missing generated Linux AppImage icon')
    }
  }
  if (deb !== undefined) {
    const inspected = await tools.inspectDeb(join(releaseDirectory, deb.name))
    if (!containsIcon(inspected, generatedIconNames.linux)) {
      violations.push('desktop artifact: missing generated Linux Deb icon')
    }
  }
  return violations
}

function containsIcon(entries: readonly string[], filename: string): boolean {
  return entries.some(entry => basename(entry.replaceAll('\\', '/')) === filename)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function lines(command: string, args: readonly string[], cwd?: string): Promise<readonly string[]> {
  const result = await execa(command, [...args], { ...(cwd === undefined ? {} : { cwd }), reject: true })
  return result.stdout.split(/\r?\n/u).filter(Boolean)
}

const nativeDesktopArtifactTools: DesktopArtifactTools = {
  async inspectWindowsInstaller(path) {
    return lines(path7za, ['l', path], root)
  },
  async inspectAsar(path) {
    return lines('pnpm', ['exec', 'asar', 'list', path], root)
  },
  async inspectMacDmg(path) {
    await execa('hdiutil', ['imageinfo', path], { reject: true })
    const mount = await mkdtemp(join(tmpdir(), 'harness-desktop-dmg-'))
    let attached = false
    try {
      await execa('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, path], { reject: true })
      attached = true
      const app = join(mount, 'Harness Desktop.app')
      const binary = join(app, 'Contents', 'MacOS', 'harness-desktop')
      const entries = await recursiveEntries(app)
      const asar = join(app, 'Contents', 'Resources', 'app.asar')
      if (await exists(asar)) entries.push(...await lines('pnpm', ['exec', 'asar', 'list', asar], root))
      const lipoInfo = (await execa('lipo', ['-info', binary], { reject: true })).stdout
      return { entries, lipoInfo }
    } finally {
      if (attached) await execa('hdiutil', ['detach', mount], { reject: true })
      await rm(mount, { recursive: true, force: true })
    }
  },
  async inspectAppImage(path) {
    return (await inspectUpdateArtifact(path, 'appimage')).members
  },
  async inspectDeb(path) {
    return lines('dpkg-deb', ['--contents', path])
  },
}

async function recursiveEntries(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    found.push(relative)
    if (entry.isDirectory()) found.push(...await recursiveEntries(join(directory, entry.name), relative))
  }
  return found
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDirectory = resolve(root, process.env.DSH_DESKTOP_RELEASE_DIRECTORY ?? 'apps/desktop/release')
  const violations = await verifyDesktopArtifacts({ platform: process.platform, releaseDirectory })
  if (violations.length === 0) {
    process.stdout.write(`release:verify-desktop-artifacts: ${process.platform} artifacts verified.\n`)
  } else {
    for (const violation of violations) process.stderr.write(`${violation}\n`)
    process.exitCode = 1
  }
}
