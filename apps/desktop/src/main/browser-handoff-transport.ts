/** Electron transport for one Runtime Dashboard body-only browser handoff. */

import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { EventEmitter } from 'node:events'
import type {
  BrowserHandoffTransport,
  DashboardNavigation,
} from '@harness-desktop/dsh-host-local-runtime'
import { DesktopReadiness, type DashboardReadyWebContents } from './readiness.ts'

const execFileAsync = promisify(execFile)

/** Platform access operations for a private bootstrap directory and document. */
export interface BrowserBootstrapAccess {
  /** Restrict a directory to the current user. */
  protectDirectory(path: string): Promise<void>
  /** Restrict a file to the current user. */
  protectFile(path: string): Promise<void>
  /** Reject a directory accessible to another user. */
  verifyDirectory(path: string): Promise<void>
  /** Reject a file accessible to another user. */
  verifyFile(path: string): Promise<void>
}

/** Electron window operations required by the bootstrap transport. */
export interface DashboardBrowserWindow {
  readonly webContents: DashboardReadyWebContents & Pick<EventEmitter, 'on' | 'removeListener'>
  /** @param path - secret-free local bootstrap document path. @returns load settlement. */
  loadFile(path: string): Promise<void>
}

/** Injectable filesystem, time, and readiness boundaries for the transport. */
export interface BrowserHandoffTransportOptions {
  /** Existing parent for a fresh owner-only bootstrap directory. */
  readonly parent?: string
  /** Platform-specific access protection and verification. */
  readonly access?: BrowserBootstrapAccess
  /** Clock used for handoff expiry. */
  readonly now?: () => number
  /** Scheduler for exact expiry cleanup. */
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  /** Scheduler cancellation operation. */
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Removal seam for the owned document and directory. */
  readonly remove?: (documentPath: string) => Promise<void>
  /** Process acknowledgement owner shared by Desktop transports. */
  readonly readiness?: DesktopReadiness
}

/** Production owner-only access policy for transient Desktop bootstrap paths. */
export const browserBootstrapAccess: BrowserBootstrapAccess = {
  async protectDirectory(path) {
    if (process.platform === 'win32') await protectWindowsPath(path, 'directory')
    else await chmod(path, 0o700)
  },
  async protectFile(path) {
    if (process.platform === 'win32') await protectWindowsPath(path, 'file')
    else await chmod(path, 0o600)
  },
  async verifyDirectory(path) {
    if (process.platform === 'win32') await verifyWindowsPath(path, 'directory')
    else await verifyMode(path, 0o700)
  },
  async verifyFile(path) {
    if (process.platform === 'win32') await verifyWindowsPath(path, 'file')
    else await verifyMode(path, 0o600)
  },
}

/**
 * Create a one-use Electron bootstrap transport bound to one Main-owned window.
 * @param window - window that loads the local bootstrap and clean Dashboard.
 * @param options - injectable private-path, cleanup, clock, and readiness operations.
 * @returns a transport whose navigation inputs and local-file path never contain the handoff.
 */
export function createBrowserHandoffTransport(
  window: DashboardBrowserWindow,
  options: BrowserHandoffTransportOptions = {},
): BrowserHandoffTransport {
  const parent = options.parent ?? tmpdir()
  const access = options.access ?? browserBootstrapAccess
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const remove = options.remove ?? removeOwnedBootstrap
  const readiness = options.readiness ?? new DesktopReadiness()
  const dispatched = new Set<string>()

  return {
    async open(navigation) {
      const origin = validateNavigation(navigation, now())
      if (dispatched.has(navigation.handoff.id)) {
        throw new Error('Desktop browser handoff was already dispatched.')
      }
      dispatched.add(navigation.handoff.id)

      const directory = await mkdtemp(join(parent, 'harness-desktop-bootstrap-'))
      const documentPath = join(directory, 'index.html')
      try {
        await access.protectDirectory(directory)
        await writeFile(documentPath, bootstrapHtml(origin, navigation.handoff.id), {
          flag: 'wx',
          mode: 0o600,
        })
        await access.protectFile(documentPath)
        await access.verifyDirectory(directory)
        await access.verifyFile(documentPath)
      } catch (error) {
        try {
          await remove(documentPath)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Desktop bootstrap setup and cleanup both failed.')
        }
        throw error
      }

      const abort = new AbortController()
      let cleanup: Promise<void> | undefined
      const clean = (): Promise<void> => {
        cleanup ??= remove(documentPath)
        return cleanup
      }
      const timer = setTimer(() => {
        abort.abort(new Error('Desktop browser handoff expired.'))
        void clean().catch(() => {
          // Expiry cleanup has no synchronous caller to receive a removal failure.
        })
      }, Math.max(0, navigation.handoff.expiresAt - now()))
      timer.unref()
      const detach = (): void => {
        clearTimer(timer)
        window.webContents.removeListener('did-navigate', onNavigate)
        window.webContents.removeListener('did-fail-load', onFailLoad)
      }
      const onNavigate = (_event: unknown, url: unknown): void => {
        if (url !== `${origin}/`) return
        void clean().catch(() => {
          // The awaited startup path observes the same cleanup promise.
        })
      }
      const onFailLoad = (...args: unknown[]): void => {
        if (args[4] === false) return
        void clean().catch(() => {
          // The awaited startup path observes the same cleanup promise.
        })
      }
      window.webContents.on('did-navigate', onNavigate)
      window.webContents.on('did-fail-load', onFailLoad)
      const ready = readiness.wait(window, origin, abort.signal)

      try {
        await Promise.race([window.loadFile(documentPath), ready])
        await ready
        await clean()
      } catch (error) {
        abort.abort(error)
        try {
          await clean()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Desktop bootstrap and cleanup both failed.')
        }
        throw error
      } finally {
        detach()
      }
    },
  }
}

function validateNavigation(navigation: DashboardNavigation, currentTime: number): string {
  const origin = new URL(navigation.origin)
  if (
    origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.port === ''
    || origin.username !== ''
    || origin.password !== ''
    || origin.search !== ''
    || origin.hash !== ''
    || origin.pathname !== '/'
  ) {
    throw new Error('Desktop bootstrap target must be an exact http://127.0.0.1 origin with a port.')
  }
  if (!/^[A-Za-z0-9_-]{32,}$/u.test(navigation.handoff.id)) {
    throw new Error('Desktop browser handoff must be opaque.')
  }
  if (!Number.isSafeInteger(navigation.handoff.expiresAt) || navigation.handoff.expiresAt <= currentTime) {
    throw new Error('Desktop browser handoff has expired.')
  }
  return origin.origin
}

function bootstrapHtml(origin: string, handoff: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><form id="handoff" method="post" autocomplete="off" action="${origin}/_harness/handoff"><input type="hidden" name="handoff" value="${handoff}"></form><script>document.getElementById('handoff').submit()</script>`
}

async function removeOwnedBootstrap(documentPath: string): Promise<void> {
  const entry = await lstat(documentPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (entry !== undefined) {
    if (entry.isDirectory()) throw new Error('Desktop bootstrap document path must not be a directory.')
    await unlink(documentPath)
  }
  await rmdir(dirname(documentPath)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

async function verifyMode(path: string, expected: number): Promise<void> {
  const mode = (await stat(path)).mode & 0o777
  if (mode !== expected) throw new Error(`Desktop bootstrap path must have mode ${expected.toString(8)}.`)
}

async function protectWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$acl=if($env:HARNESS_DESKTOP_PRIVATE_KIND-eq'directory'){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}",
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true,$false)',
    "$inherit=if($env:HARNESS_DESKTOP_PRIVATE_KIND-eq'directory'){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}",
    '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($rule)',
    "if($env:HARNESS_DESKTOP_PRIVATE_KIND-eq'directory'){[IO.Directory]::SetAccessControl($env:HARNESS_DESKTOP_PRIVATE_PATH,$acl)}else{[IO.File]::SetAccessControl($env:HARNESS_DESKTOP_PRIVATE_PATH,$acl)}",
  ].join('; ')
  await runPowerShell(script, path, kind)
}

async function verifyWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$acl=if($env:HARNESS_DESKTOP_PRIVATE_KIND-eq'directory'){[IO.Directory]::GetAccessControl($env:HARNESS_DESKTOP_PRIVATE_PATH)}else{[IO.File]::GetAccessControl($env:HARNESS_DESKTOP_PRIVATE_PATH)}",
    '$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value',
    '$trustees=@($acl.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Select-Object -Unique)',
    "if($owner-ne$sid-or$acl.AreAccessRulesProtected-ne$true-or$trustees.Count-ne1-or$trustees[0]-ne$sid){throw 'path is not restricted to the current user'}",
  ].join('; ')
  await runPowerShell(script, path, kind)
}

async function runPowerShell(script: string, path: string, kind: 'directory' | 'file'): Promise<void> {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_DESKTOP_PRIVATE_PATH: path,
      HARNESS_DESKTOP_PRIVATE_KIND: kind,
    },
  })
}
