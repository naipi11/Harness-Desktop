/** Matching-runner native installer ownership for Desktop release acceptance. */

import { extractFile } from '@electron/asar'
import { createHash } from 'node:crypto'
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import {
  launchDesktopExecutableRuntimeFixture,
  type DesktopRuntimeFixture,
} from './runtime-fixture.ts'
import {
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  type InstalledArtifactLifecycle,
} from './installed-artifact-lifecycle.ts'

export {
  isAppImageFuseUnavailable,
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  runInstalledArtifactLifecycle,
} from './installed-artifact-lifecycle.ts'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const desktopRoot = join(repoRoot, 'apps', 'desktop')
const sentinelName = 'installed-smoke-sentinel.txt'

/** Native installer discovery inputs for the current runner. */
export interface InstalledArtifactInput {
  readonly platform: NodeJS.Platform
  readonly releaseDirectory: string
}

/** One installed, copied, or extracted native Desktop artifact. */
export interface InstalledDesktopArtifact extends InstalledArtifactLifecycle<DesktopRuntimeFixture> {
  writeSentinel(harnessHome: string): Promise<void>
  verifyGeneratedIcon(): Promise<void>
}

interface PreparedArtifact {
  readonly name: string
  readonly executable: string
  readonly cwd: string
  readonly asar: string
  readonly iconMember: string
  readonly generatedIcon: string
  readonly launch?: () => Promise<DesktopRuntimeFixture>
  remove(): Promise<void>
}

/**
 * Install or mount every artifact format owned by the current native runner.
 * @param input - runner platform and Electron Builder release directory.
 * @returns prepared artifacts; callers launch, remove, verify the sentinel, then clean up.
 */
export async function prepareInstalledDesktopArtifacts(
  input: InstalledArtifactInput,
): Promise<readonly InstalledDesktopArtifact[]> {
  const prepared = await prepareNativeArtifacts(input)
  return prepared.map(subject => wrapPreparedArtifact(subject))
}

async function prepareNativeArtifacts(input: InstalledArtifactInput): Promise<readonly PreparedArtifact[]> {
  switch (input.platform) {
    case 'win32':
      return [await prepareWindows(input.releaseDirectory)]
    case 'darwin':
      return [await prepareMac(input.releaseDirectory)]
    case 'linux':
      return await prepareLinux(input.releaseDirectory)
    default:
      throw new Error(`installed desktop artifact: unsupported platform ${input.platform}`)
  }
}

function wrapPreparedArtifact(subject: PreparedArtifact): InstalledDesktopArtifact {
  let runtimeRoot: string | undefined
  let sentinelPath = ''
  return {
    name: subject.name,
    get sentinelPath() {
      if (sentinelPath === '') throw new Error(`installed desktop artifact: ${subject.name} sentinel was not written`)
      return sentinelPath
    },
    launch: subject.launch ?? (async () => launchDesktopExecutableRuntimeFixture({
      executablePath: subject.executable,
      cwd: subject.cwd,
    })),
    async writeSentinel(harnessHome) {
      runtimeRoot = dirname(harnessHome)
      sentinelPath = join(harnessHome, sentinelName)
      await writeFile(sentinelPath, 'preserve installed smoke home\n')
    },
    async verifyGeneratedIcon() {
      const expected = await readFile(subject.generatedIcon)
      const actual = extractFile(subject.asar, subject.iconMember.replaceAll('/', sep))
      if (sha256(actual) !== sha256(expected)) {
        throw new Error(`installed desktop artifact: ${subject.name} generated icon digest mismatch`)
      }
    },
    remove: async () => subject.remove(),
    async cleanup() {
      if (runtimeRoot !== undefined) await removeTree(runtimeRoot)
      await removeTree(subject.cwd)
    },
  }
}

async function prepareWindows(releaseDirectory: string): Promise<PreparedArtifact> {
  const installer = await exactlyOneFile(
    releaseDirectory,
    /^Harness Desktop Setup \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/u,
    'Windows NSIS installer',
  )
  const root = await mkdtemp(join(tmpdir(), 'harness-desktop-installed-win32-'))
  const installation = join(root, 'Harness Desktop')
  let installed = false
  try {
    const result = await execa(installer, ['/S', `/D=${installation}`], { cwd: root, reject: false })
    if (result.exitCode !== 0) {
      throw new Error(`installed desktop artifact: NSIS install exited ${String(result.exitCode)}: ${result.stderr}`)
    }
    installed = true
    const executable = join(installation, 'harness-desktop.exe')
    const asar = join(installation, 'resources', 'app.asar')
    await requireFile(executable, 'installed Windows executable')
    await requireFile(asar, 'installed Windows app.asar')
    return {
      name: 'Windows NSIS',
      executable,
      cwd: root,
      asar,
      iconMember: 'resources/icons/win/harness-desktop.ico',
      generatedIcon: join(desktopRoot, 'resources', 'icons', 'win', 'harness-desktop.ico'),
      async remove() {
        await uninstallWindowsInstallation(root, installation)
      },
    }
  } catch (error) {
    if (installed) {
      return rollbackWindowsPreparation(error, {
        findUninstaller: async () => findWindowsUninstaller(installation),
        runUninstaller: async path => runWindowsUninstaller(root, path),
        waitForRemoval: async () => waitForRemoval(installation),
        removeRoot: async () => removeTree(root),
      })
    }
    await removeTree(root)
    throw error
  }
}

async function uninstallWindowsInstallation(root: string, installation: string): Promise<void> {
  const uninstaller = await findWindowsUninstaller(installation)
  await runWindowsUninstaller(root, uninstaller)
  await waitForRemoval(installation)
}

async function findWindowsUninstaller(installation: string): Promise<string> {
  const uninstaller = (await readdir(installation)).find(name => /^Uninstall .*\.exe$/u.test(name))
  if (uninstaller === undefined) throw new Error('installed desktop artifact: NSIS uninstaller is missing')
  return join(installation, uninstaller)
}

async function runWindowsUninstaller(root: string, uninstaller: string): Promise<void> {
  const result = await execa(uninstaller, ['/S'], { cwd: root, reject: false })
  if (result.exitCode !== 0) {
    throw new Error(`installed desktop artifact: NSIS uninstall exited ${String(result.exitCode)}: ${result.stderr}`)
  }
}

async function prepareMac(releaseDirectory: string): Promise<PreparedArtifact> {
  const dmg = await exactlyOneFile(
    releaseDirectory,
    /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-universal\.dmg$/u,
    'macOS universal DMG',
  )
  const root = await mkdtemp(join(tmpdir(), 'harness-desktop-installed-darwin-'))
  const mount = join(root, 'mount')
  const applications = join(root, 'Applications')
  try {
    await mkdir(mount)
    await mkdir(applications)
    let attached = false
    try {
      await execa('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { reject: true })
      attached = true
      const source = join(mount, 'Harness Desktop.app')
      const destination = join(applications, 'Harness Desktop.app')
      await cp(source, destination, { recursive: true })
    } finally {
      if (attached) await execa('hdiutil', ['detach', mount], { reject: true })
    }
    const app = join(applications, 'Harness Desktop.app')
    const executable = join(app, 'Contents', 'MacOS', 'harness-desktop')
    const asar = join(app, 'Contents', 'Resources', 'app.asar')
    const lipo = await execa('lipo', ['-info', executable], { reject: true })
    if (!/\bx86_64\b/u.test(lipo.stdout) || !/\barm64\b/u.test(lipo.stdout)) {
      throw new Error(`installed desktop artifact: copied macOS app is not universal: ${lipo.stdout}`)
    }
    return {
      name: 'macOS universal DMG',
      executable,
      cwd: root,
      asar,
      iconMember: 'resources/icons/mac/harness-desktop.icns',
      generatedIcon: join(desktopRoot, 'resources', 'icons', 'mac', 'harness-desktop.icns'),
      async remove() {
        await rm(app, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await removeTree(root)
    throw error
  }
}

async function prepareLinux(releaseDirectory: string): Promise<readonly PreparedArtifact[]> {
  const appImage = await exactlyOneFile(
    releaseDirectory,
    /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.AppImage$/u,
    'Linux AppImage',
  )
  const deb = await exactlyOneFile(
    releaseDirectory,
    /^harness-desktop_\d+\.\d+\.\d+(?:[+~.-][0-9A-Za-z.-]+)?_(?:amd64|arm64)\.deb$/u,
    'Linux Deb installer',
  )
  let appImageRoot: string | undefined
  let debRoot: string | undefined
  try {
    appImageRoot = await mkdtemp(join(tmpdir(), 'harness-desktop-installed-appimage-'))
    const appImageWorkingRoot = appImageRoot
    await chmod(appImage, 0o755)
    await execa(appImage, ['--appimage-extract'], { cwd: appImageRoot, reject: true })
    const extractedAppImage = join(appImageRoot, 'squashfs-root')
    const appRun = join(extractedAppImage, 'AppRun')
    await requireFile(appRun, 'extracted AppImage AppRun')
    await chmod(appRun, 0o755)
    const appImageAsar = await findFile(extractedAppImage, 'app.asar')

    debRoot = await mkdtemp(join(tmpdir(), 'harness-desktop-installed-deb-'))
    const debWorkingRoot = debRoot
    const dpkgAdmin = join(debWorkingRoot, 'var', 'lib', 'dpkg')
    await mkdir(join(dpkgAdmin, 'updates'), { recursive: true })
    await writeFile(join(dpkgAdmin, 'status'), '')
    const install = await execa('dpkg', [
      `--root=${debWorkingRoot}`,
      `--admindir=${dpkgAdmin}`,
      '--force-not-root',
      '--force-bad-path',
      '--unpack', deb,
    ], { reject: false })
    if (install.exitCode !== 0) {
      throw new Error(`installed desktop artifact: isolated dpkg install exited ${String(install.exitCode)}: ${install.stderr}`)
    }
    const packageName = (await execa('dpkg-deb', ['--field', deb, 'Package'], { reject: true })).stdout.trim()
    const debExecutable = await findFile(debWorkingRoot, 'harness-desktop')
    const debAsar = await findFile(debWorkingRoot, 'app.asar')
    const icon = join(desktopRoot, 'resources', 'icons', 'linux', 'harness-desktop-512.png')
    return [
      {
        name: 'Linux AppImage',
        executable: appImage,
        cwd: appImageWorkingRoot,
        asar: appImageAsar,
        iconMember: 'resources/icons/linux/harness-desktop-512.png',
        generatedIcon: icon,
        async launch() {
          return launchAppImageWithFallback(appImage, appRun, async (executablePath) => {
            return launchDesktopExecutableRuntimeFixture({ executablePath, cwd: appImageWorkingRoot })
          })
        },
        async remove() { await rm(extractedAppImage, { recursive: true, force: true }) },
      },
      {
        name: 'Linux Deb',
        executable: debExecutable,
        cwd: debWorkingRoot,
        asar: debAsar,
        iconMember: 'resources/icons/linux/harness-desktop-512.png',
        generatedIcon: icon,
        async remove() {
          const removal = await execa('dpkg', [
            `--root=${debWorkingRoot}`,
            `--admindir=${dpkgAdmin}`,
            '--force-not-root',
            '--force-bad-path',
            '--remove', packageName,
          ], { reject: false })
          if (removal.exitCode !== 0) {
            throw new Error(`installed desktop artifact: isolated dpkg removal exited ${String(removal.exitCode)}: ${removal.stderr}`)
          }
          if (await access(debExecutable).then(() => true, () => false)) {
            throw new Error('installed desktop artifact: isolated dpkg removal retained the Deb executable')
          }
        },
      },
    ]
  } catch (error) {
    if (appImageRoot !== undefined) await removeTree(appImageRoot)
    if (debRoot !== undefined) await removeTree(debRoot)
    throw error
  }
}

async function exactlyOneFile(directory: string, pattern: RegExp, label: string): Promise<string> {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && pattern.test(entry.name))
  if (matches.length !== 1) {
    throw new Error(`installed desktop artifact: expected exactly one ${label}, found ${String(matches.length)}`)
  }
  return join(directory, matches[0]!.name)
}

async function findFile(directory: string, filename: string): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && basename(path) === filename) return path
    if (entry.isDirectory()) {
      const found = await findFile(path, filename).catch(() => undefined)
      if (found !== undefined) return found
    }
  }
  throw new Error(`installed desktop artifact: ${filename} is missing below ${directory}`)
}

async function requireFile(path: string, label: string): Promise<void> {
  if (!(await access(path).then(() => true, () => false))) {
    throw new Error(`installed desktop artifact: ${label} is missing at ${path}`)
  }
}

async function waitForRemoval(path: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (await access(path).then(() => true, () => false)) {
    if (Date.now() >= deadline) throw new Error(`installed desktop artifact: removal timed out for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function removeTree(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
