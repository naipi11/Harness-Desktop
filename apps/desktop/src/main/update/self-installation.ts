/** Resolve only packaged Desktop installations that can safely replace their own bytes. */

import { lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Self-managed native installation data, when the current package may atomically replace itself. */
export interface SelfUpdateInstallation {
  /** Canonical packaged executable used by the native installer or rollback worker. */
  readonly applicationPath: string
  /** Canonical outer AppImage path used for Linux replacement and retained rollback. */
  readonly appImagePath?: string
}

/** Environment and platform inputs that identify the currently running packaged application. */
export interface SelfUpdateInstallationOptions {
  /** Native platform hosting the packaged application. */
  readonly platform: NodeJS.Platform
  /** Executable path reported by the running packaged process. */
  readonly executablePath: string
  /** Linux outer AppImage launcher path, if its runtime supplied one. */
  readonly appImagePath: string | undefined
  /** Linux mounted AppImage directory, if its runtime supplied one. */
  readonly appDirectory: string | undefined
}

/** Filesystem operations that bind an installation to a writable replacement volume. */
export interface SelfUpdateInstallationOperations {
  /** @param path - candidate regular file. @returns metadata without traversing a final symbolic link. */
  lstat(path: string): Promise<{ readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean }>
  /** @param path - existing path. @returns canonical path after symbolic-link resolution. */
  realpath(path: string): Promise<string>
  /** @param prefix - private probe directory prefix on the target volume. @returns exclusively created directory. */
  mkdtemp(prefix: string): Promise<string>
  /** @param from - private same-volume probe directory. @param to - absent sibling destination. @returns after an atomic rename probe. */
  rename(from: string, to: string): Promise<void>
  /** @param path - probe directory. @returns fulfillment when the private probe has been removed. */
  remove(path: string): Promise<void>
  /** @param path - Linux mount table. @returns bytes used only to bind the AppImage mount point. */
  readText(path: string): Promise<string>
}

/**
 * Resolve whether this packaged Desktop instance owns a writable installation.
 * @param options - platform and process paths supplied by the packaged host.
 * @param operations - filesystem collaborators; production defaults never mutate installed application bytes.
 * @returns canonical installation data, or undefined when an external package manager or read-only location owns updates.
 */
export async function resolveSelfUpdateInstallation(
  options: SelfUpdateInstallationOptions,
  operations: SelfUpdateInstallationOperations = nativeOperations,
): Promise<SelfUpdateInstallation | undefined> {
  if (options.platform === 'win32') return { applicationPath: options.executablePath }
  if (options.platform === 'darwin') return await resolveMacInstallation(options, operations)
  if (options.platform === 'linux') return await resolveLinuxAppImageInstallation(options, operations)
  return undefined
}

async function resolveMacInstallation(
  options: SelfUpdateInstallationOptions,
  operations: SelfUpdateInstallationOperations,
): Promise<SelfUpdateInstallation | undefined> {
  let applicationPath: string
  try {
    applicationPath = await operations.realpath(options.executablePath)
    const applicationBundle = macApplicationBundle(applicationPath)
    if (!await canWriteSibling(dirname(applicationBundle), operations)) return undefined
  } catch {
    return undefined
  }
  return { applicationPath }
}

async function resolveLinuxAppImageInstallation(
  options: SelfUpdateInstallationOptions,
  operations: SelfUpdateInstallationOperations,
): Promise<SelfUpdateInstallation | undefined> {
  if (options.appImagePath === undefined || options.appDirectory === undefined
    || !isAbsolute(options.appImagePath) || !isAbsolute(options.appDirectory)) return undefined
  try {
    const outer = await operations.lstat(options.appImagePath)
    if (!outer.isFile() || outer.isSymbolicLink()) return undefined
    const [appImagePath, appDirectory, applicationPath] = await Promise.all([
      operations.realpath(options.appImagePath),
      operations.realpath(options.appDirectory),
      operations.realpath(options.executablePath),
    ])
    if (!isContainedPath(appDirectory, applicationPath) || !await isAppImageMount(appDirectory, operations)
      || !await hasLinuxStartTicks(operations)) return undefined
    if (!await canWriteSibling(dirname(appImagePath), operations)) return undefined
    return { applicationPath, appImagePath }
  } catch {
    return undefined
  }
}

/** Reject a direct DMG, an App Translocation directory, and an AppImage parent that cannot hold an atomic sibling. */
async function canWriteSibling(parent: string, operations: SelfUpdateInstallationOperations): Promise<boolean> {
  let probe: string | undefined
  try {
    probe = await operations.mkdtemp(join(parent, '.harness-desktop-update-probe-'))
    const renamed = `${probe}.rename`
    await operations.rename(probe, renamed)
    probe = renamed
    await operations.remove(probe)
    return true
  } catch {
    if (probe !== undefined) {
      try {
        await operations.remove(probe)
      } catch {
        // A failed probe only disables self-update; it never authorizes a later installation replacement.
      }
    }
    return false
  }
}

/** Confirm an AppImage runtime mount rather than trusting inherited APPIMAGE and APPDIR variables. */
async function isAppImageMount(appDirectory: string, operations: SelfUpdateInstallationOperations): Promise<boolean> {
  const mountInfo = await operations.readText('/proc/self/mountinfo')
  return mountInfo.split(/\r?\n/u).some((line) => {
    const fields = line.split(' ')
    const separator = fields.indexOf('-')
    const mountPoint = fields[4]
    const filesystem = separator === -1 ? undefined : fields[separator + 1]
    return mountPoint !== undefined && decodeMountInfoPath(mountPoint) === appDirectory
      && (filesystem === 'squashfs' || filesystem === 'fuse' || filesystem?.startsWith('fuse.') === true)
  })
}

/** Require the same kernel process token that the watchdog records before accepting an AppImage installation. */
async function hasLinuxStartTicks(operations: SelfUpdateInstallationOperations): Promise<boolean> {
  const content = await operations.readText('/proc/self/stat')
  const closingParenthesis = content.lastIndexOf(')')
  if (closingParenthesis === -1) return false
  const token = content.slice(closingParenthesis + 1).trim().split(/\s+/u)[19]
  return token !== undefined && /^[0-9]{1,32}$/u.test(token)
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function macApplicationBundle(applicationPath: string): string {
  const macosDirectory = dirname(applicationPath)
  const contentsDirectory = dirname(macosDirectory)
  const bundle = dirname(contentsDirectory)
  if (basename(macosDirectory) !== 'MacOS' || basename(contentsDirectory) !== 'Contents' || !bundle.endsWith('.app')) {
    throw new Error('native Desktop macOS application path is invalid')
  }
  return bundle
}

function isContainedPath(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

const nativeOperations: SelfUpdateInstallationOperations = {
  lstat,
  realpath,
  mkdtemp,
  rename,
  remove: async (path) => { await rm(path, { recursive: true, force: true }) },
  readText: async path => await readFile(path, 'utf8'),
}
