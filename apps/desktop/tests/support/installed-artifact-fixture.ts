/** Matching-runner native installer ownership for Desktop release acceptance. */

import { extractFile } from '@electron/asar'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import {
  launchDesktopExecutableRuntimeFixture,
  type DesktopRuntimeFixture,
} from './runtime-fixture.ts'
import {
  cleanupPreparationRoots,
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  type InstalledArtifactLifecycle,
} from './installed-artifact-lifecycle.ts'

export {
  cleanupPreparationRoots,
  isAppImageFuseUnavailable,
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  runInstalledArtifactCollection,
  runInstalledArtifactLifecycle,
} from './installed-artifact-lifecycle.ts'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const desktopRoot = join(repoRoot, 'apps', 'desktop')
const sentinelName = 'installed-smoke-sentinel.txt'
const debRootPrefix = 'harness-desktop-installed-deb-'
const linuxSystemPath = '/usr/sbin:/usr/bin:/sbin:/bin'
const linuxCommandEnvironment = { LC_ALL: 'C', PATH: linuxSystemPath } as const

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

/** One isolated Windows NSIS installation retained for an actual native update and rollback test. */
export interface NativeUpdateWindowsInstallation {
  /** Exact installed application executable that the detached worker must replace and relaunch. */
  readonly executablePath: string
  /** Installed app.asar whose version transitions prove candidate replacement and rollback. */
  readonly appAsarPath: string
  /** Packaged policy resource used only by the temporary local update source. */
  readonly updatePolicyPath: string
  /** Launch the installed stable application against one isolated Runtime fixture. */
  launch(environment: Readonly<Record<string, string>>): Promise<DesktopRuntimeFixture>
  /** Remove the isolated NSIS installation and every preparation root after the test settles. */
  cleanup(): Promise<void>
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
  cleanup?(): Promise<void>
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

/**
 * Install one explicitly supplied Windows NSIS artifact into a test-owned root for a native update transaction.
 * @param installer - test-specific NSIS installer whose application id is isolated from ordinary user installations.
 * @returns paths and cleanup ownership for the real installed executable.
 */
export async function prepareNativeUpdateWindowsInstallation(installer: string): Promise<NativeUpdateWindowsInstallation> {
  if (process.platform !== 'win32') throw new Error('native Desktop update acceptance requires Windows')
  const subject = await prepareWindowsInstaller(installer)
  return {
    executablePath: subject.executable,
    appAsarPath: subject.asar,
    updatePolicyPath: join(dirname(subject.asar), 'update-policy.json'),
    async launch(environment) {
      return await launchDesktopExecutableRuntimeFixture({
        executablePath: subject.executable,
        cwd: subject.cwd,
        environment,
      })
    },
    async cleanup() {
      const failures: unknown[] = []
      await subject.remove().catch((error: unknown) => { failures.push(error) })
      await removeTree(subject.cwd).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'native Desktop update Windows installation cleanup failed')
    },
  }
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

/**
 * Add installed-smoke lifecycle ownership to one prepared native artifact.
 * @param subject - prepared native artifact paths and operations.
 * @returns artifact lifecycle with Runtime-root and preparation-root cleanup.
 */
export function wrapPreparedArtifact(subject: PreparedArtifact): InstalledDesktopArtifact {
  let runtimeRoot: string | undefined
  let sentinelPath = ''
  const launch = subject.launch ?? (async () => launchDesktopExecutableRuntimeFixture({
    executablePath: subject.executable,
    cwd: subject.cwd,
  }))
  return {
    name: subject.name,
    get sentinelPath() {
      if (sentinelPath === '') throw new Error(`installed desktop artifact: ${subject.name} sentinel was not written`)
      return sentinelPath
    },
    async launch() {
      const fixture = await launch()
      runtimeRoot = dirname(fixture.runtime.harnessHome)
      return fixture
    },
    async writeSentinel(harnessHome) {
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
      if (subject.cleanup === undefined) await removeTree(subject.cwd)
      else await subject.cleanup()
    },
  }
}

/**
 * Build the isolated dpkg operation that unpacks and configures a Deb.
 * @param root - validated temporary installation root.
 * @param deb - Deb artifact to install.
 * @returns dpkg arguments with configured-install semantics.
 */
export function isolatedDpkgInstallArguments(root: string, deb: string): readonly string[] {
  return [`--root=${root}`, '--force-depends', '--install', deb]
}

/**
 * Reject a dpkg state that did not complete package configuration.
 * @param status - `${db:Status-Status}` value from the isolated admin database.
 */
export function assertIsolatedDpkgInstalled(status: string): void {
  if (status !== 'installed') {
    throw new Error(`installed desktop artifact: isolated dpkg package status is ${status}, expected installed`)
  }
}

async function prepareWindows(releaseDirectory: string): Promise<PreparedArtifact> {
  const installer = await exactlyOneFile(
    releaseDirectory,
    /^Harness Desktop Setup \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/u,
    'Windows NSIS installer',
  )
  return await prepareWindowsInstaller(installer)
}

async function prepareWindowsInstaller(installer: string): Promise<PreparedArtifact> {
  await requireFile(installer, 'Windows NSIS installer')
  const root = await mkdtemp(join(tmpdir(), 'harness-desktop-installed-win32-'))
  const installation = join(root, 'Harness Desktop')
  let installerAttempted = false
  let installed = false
  try {
    installerAttempted = true
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
    if (installerAttempted) {
      return rollbackWindowsPreparation(error, {
        uninstallerRequired: installed,
        findUninstaller: async () => findOptionalWindowsUninstaller(installation),
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
  const uninstaller = await findOptionalWindowsUninstaller(installation)
  if (uninstaller === undefined) throw new Error('installed desktop artifact: NSIS uninstaller is missing')
  return uninstaller
}

async function findOptionalWindowsUninstaller(installation: string): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(installation)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const uninstaller = entries.find(name => /^Uninstall .*\.exe$/u.test(name))
  return uninstaller === undefined ? undefined : join(installation, uninstaller)
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

    debRoot = await mkdtemp(join(tmpdir(), debRootPrefix))
    const debWorkingRoot = debRoot
    await assertOwnedDebRoot(debWorkingRoot)
    const packageName = await readDebPackageName(deb)
    const hostState = await captureHostDebState(packageName)
    await requireDebControlScripts(deb, join(debWorkingRoot, 'control'))
    await stageIsolatedDpkgRoot(debWorkingRoot)
    const install = await runIsolatedDpkg(isolatedDpkgInstallArguments(debWorkingRoot, deb))
    if (install.exitCode !== 0) {
      throw new Error(`installed desktop artifact: isolated dpkg install exited ${String(install.exitCode)}: ${install.stderr}`)
    }
    assertIsolatedDpkgInstalled(await queryIsolatedDpkgStatus(debWorkingRoot, packageName))
    const installedPaths = debInstalledPaths(debWorkingRoot)
    await requireFile(installedPaths.executable, 'configured Deb executable')
    await requireFile(installedPaths.asar, 'configured Deb app.asar')
    await requireFile(installedPaths.desktopEntry, 'configured Deb desktop entry')
    await requireFile(installedPaths.icon, 'configured Deb generated icon')
    await requireSymlink(installedPaths.launcher, '/opt/Harness Desktop/harness-desktop')
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
        executable: installedPaths.executable,
        cwd: debWorkingRoot,
        asar: installedPaths.asar,
        iconMember: 'resources/icons/linux/harness-desktop-512.png',
        generatedIcon: icon,
        async remove() {
          const removal = await runIsolatedDpkg([`--root=${debWorkingRoot}`, '--remove', packageName])
          if (removal.exitCode !== 0) {
            throw new Error(`installed desktop artifact: isolated dpkg removal exited ${String(removal.exitCode)}: ${removal.stderr}`)
          }
          const nextStatus = await queryIsolatedDpkgStatus(debWorkingRoot, packageName, true)
          if (nextStatus === 'installed') {
            throw new Error('installed desktop artifact: isolated dpkg removal retained installed package status')
          }
          for (const [label, path] of [
            ['executable', installedPaths.executable],
            ['asar', installedPaths.asar],
            ['desktop entry', installedPaths.desktopEntry],
            ['icon', installedPaths.icon],
            ['launcher', installedPaths.launcher],
          ] as const) {
            if (await pathExists(path)) {
              throw new Error(`installed desktop artifact: isolated dpkg removal retained Deb ${label}`)
            }
          }
          await requireHostDebState(hostState)
        },
        async cleanup() { await removePrivilegedDebRoot(debWorkingRoot) },
      },
    ]
  } catch (error) {
    const cleanups: Array<() => Promise<void>> = []
    if (appImageRoot !== undefined) {
      const root = appImageRoot
      cleanups.push(async () => removeTree(root))
    }
    if (debRoot !== undefined) {
      const root = debRoot
      cleanups.push(async () => removePrivilegedDebRoot(root))
    }
    return cleanupPreparationRoots(error, cleanups)
  }
}

interface DebInstalledPaths {
  readonly executable: string
  readonly asar: string
  readonly desktopEntry: string
  readonly icon: string
  readonly launcher: string
}

interface HostDebState {
  readonly packageName: string
  readonly queryExitCode: number | undefined
  readonly queryStdout: string
  readonly executableExists: boolean
  readonly launcherExists: boolean
}

async function readDebPackageName(deb: string): Promise<string> {
  const dpkgDeb = await requireHostTool(['/usr/bin/dpkg-deb', '/bin/dpkg-deb'], 'dpkg-deb')
  const result = await execa(dpkgDeb, ['--field', deb, 'Package'], {
    env: linuxCommandEnvironment,
    extendEnv: false,
    reject: false,
  })
  const packageName = result.stdout.trim()
  if (result.exitCode !== 0 || packageName === '') {
    throw new Error(`installed desktop artifact: cannot read Deb package name: ${result.stderr}`)
  }
  return packageName
}

async function requireDebControlScripts(deb: string, destination: string): Promise<void> {
  const dpkgDeb = await requireHostTool(['/usr/bin/dpkg-deb', '/bin/dpkg-deb'], 'dpkg-deb')
  await mkdir(destination)
  const result = await execa(dpkgDeb, ['--control', deb, destination], {
    env: linuxCommandEnvironment,
    extendEnv: false,
    reject: false,
  })
  if (result.exitCode !== 0) {
    throw new Error(`installed desktop artifact: cannot inspect Deb control scripts: ${result.stderr}`)
  }
  await requireFile(join(destination, 'postinst'), 'Deb postinst maintainer script')
  await requireFile(join(destination, 'postrm'), 'Deb postrm maintainer script')
}

async function stageIsolatedDpkgRoot(root: string): Promise<void> {
  const dpkgAdmin = join(root, 'var', 'lib', 'dpkg')
  await mkdir(join(dpkgAdmin, 'updates'), { recursive: true })
  await mkdir(join(dpkgAdmin, 'info'), { recursive: true })
  await mkdir(join(dpkgAdmin, 'triggers'), { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'usr', 'bin'), { recursive: true })
  await mkdir(join(root, 'dev'), { recursive: true })
  await copyFile('/var/lib/dpkg/status', join(dpkgAdmin, 'status'))

  const libraries = new Set<string>()
  for (const name of ['bash', 'ln', 'chmod', 'rm']) {
    const source = await requireHostTool([`/bin/${name}`, `/usr/bin/${name}`], name)
    await stageRuntimeFile(root, source, `/bin/${name}`)
    for (const library of await dynamicLibraries(source)) libraries.add(library)
  }
  for (const library of libraries) await stageRuntimeFile(root, library, library)

  const mknod = await requireHostTool(['/usr/bin/mknod', '/bin/mknod'], 'mknod')
  const result = await runSudo([mknod, '-m', '666', join(root, 'dev', 'null'), 'c', '1', '3'])
  if (result.exitCode !== 0) {
    throw new Error(`installed desktop artifact: cannot stage isolated /dev/null: ${result.stderr}`)
  }
}

async function dynamicLibraries(executable: string): Promise<readonly string[]> {
  const ldd = await requireHostTool(['/usr/bin/ldd', '/bin/ldd'], 'ldd')
  const result = await execa(ldd, [executable], {
    env: linuxCommandEnvironment,
    extendEnv: false,
    reject: false,
  })
  if (result.exitCode !== 0) {
    throw new Error(`installed desktop artifact: ldd failed for ${executable}: ${result.stderr}`)
  }
  const paths = new Set<string>()
  for (const line of result.stdout.split('\n')) {
    const match = /(?:=>\s+)?(\/[^\s]+)\s+\(/u.exec(line)
    if (match?.[1] !== undefined) paths.add(match[1])
  }
  return [...paths]
}

async function stageRuntimeFile(root: string, source: string, absoluteTarget: string): Promise<void> {
  const target = join(root, ...absoluteTarget.split('/').filter(Boolean))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  await chmod(target, (await stat(source)).mode & 0o777)
}

async function runIsolatedDpkg(
  args: readonly string[],
): Promise<{ readonly exitCode: number | undefined; readonly stderr: string }> {
  const env = await requireHostTool(['/usr/bin/env', '/bin/env'], 'env')
  const dpkg = await requireHostTool(['/usr/bin/dpkg', '/bin/dpkg'], 'dpkg')
  return runSudo([
    env,
    '-i',
    `PATH=${linuxSystemPath}`,
    'LC_ALL=C',
    'DEBIAN_FRONTEND=noninteractive',
    dpkg,
    ...args,
  ])
}

async function queryIsolatedDpkgStatus(root: string, packageName: string, allowMissing = false): Promise<string> {
  const dpkgQuery = await requireHostTool(['/usr/bin/dpkg-query', '/bin/dpkg-query'], 'dpkg-query')
  const result = await runSudo([
    dpkgQuery,
    `--admindir=${join(root, 'var', 'lib', 'dpkg')}`,
    '--showformat=${db:Status-Status}',
    '--show',
    packageName,
  ])
  if (result.exitCode !== 0) {
    if (allowMissing) return 'not-installed'
    throw new Error(`installed desktop artifact: isolated dpkg status query failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function runSudo(
  args: readonly string[],
): Promise<{ readonly exitCode: number | undefined; readonly stdout: string; readonly stderr: string }> {
  const sudo = await requireHostTool(['/usr/bin/sudo', '/bin/sudo'], 'sudo')
  const result = await execa(sudo, ['--non-interactive', ...args], {
    env: linuxCommandEnvironment,
    extendEnv: false,
    reject: false,
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

async function requireHostTool(candidates: readonly string[], label: string): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  throw new Error(`installed desktop artifact: required Linux tool ${label} is unavailable`)
}

function debInstalledPaths(root: string): DebInstalledPaths {
  return {
    executable: join(root, 'opt', 'Harness Desktop', 'harness-desktop'),
    asar: join(root, 'opt', 'Harness Desktop', 'resources', 'app.asar'),
    desktopEntry: join(root, 'usr', 'share', 'applications', 'harness-desktop.desktop'),
    icon: join(root, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'harness-desktop.png'),
    launcher: join(root, 'usr', 'bin', 'harness-desktop'),
  }
}

async function requireSymlink(path: string, target: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined)
  if (metadata === undefined || !metadata.isSymbolicLink() || await readlink(path) !== target) {
    throw new Error(`installed desktop artifact: configured Deb launcher must link to ${target}`)
  }
}

async function captureHostDebState(packageName: string): Promise<HostDebState> {
  const dpkgQuery = await requireHostTool(['/usr/bin/dpkg-query', '/bin/dpkg-query'], 'dpkg-query')
  const result = await execa(dpkgQuery, [
    '--showformat=${db:Status-Status}',
    '--show',
    packageName,
  ], {
    env: linuxCommandEnvironment,
    extendEnv: false,
    reject: false,
  })
  return {
    packageName,
    queryExitCode: result.exitCode,
    queryStdout: result.stdout,
    executableExists: await pathExists('/opt/Harness Desktop/harness-desktop'),
    launcherExists: await pathExists('/usr/bin/harness-desktop'),
  }
}

async function requireHostDebState(expected: HostDebState): Promise<void> {
  const actual = await captureHostDebState(expected.packageName)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('installed desktop artifact: isolated dpkg lifecycle changed host package state')
  }
}

async function assertOwnedDebRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root)
  const resolvedTemp = resolve(tmpdir())
  const suffix = basename(resolvedRoot).slice(debRootPrefix.length)
  if (resolvedRoot !== root || dirname(resolvedRoot) !== resolvedTemp
    || !basename(resolvedRoot).startsWith(debRootPrefix) || suffix === '') {
    throw new Error(`installed desktop artifact: refusing privileged cleanup outside owned Deb root: ${root}`)
  }
  const metadata = await lstat(resolvedRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`installed desktop artifact: refusing privileged cleanup of non-directory Deb root: ${root}`)
  }
}

async function removePrivilegedDebRoot(root: string): Promise<void> {
  if (!await pathExists(root)) return
  await assertOwnedDebRoot(root)
  const rmPath = await requireHostTool(['/usr/bin/rm', '/bin/rm'], 'rm')
  const result = await runSudo([rmPath, '-rf', '--', root])
  if (result.exitCode !== 0) {
    throw new Error(`installed desktop artifact: privileged Deb root cleanup failed: ${result.stderr}`)
  }
  if (await pathExists(root)) {
    throw new Error(`installed desktop artifact: privileged Deb root cleanup retained ${root}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
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
