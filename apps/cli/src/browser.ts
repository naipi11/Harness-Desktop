/** Owner-only local-file transport for one Runtime Dashboard handoff. */

import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type {
  BrowserHandoffTransport,
  DashboardNavigation,
} from '@harness-desktop/dsh-host-local-runtime'

const execFileAsync = promisify(execFile)

/** Platform-specific protection and verification for one bootstrap directory and file. */
export interface BrowserBootstrapAccess {
  /** Restrict a newly created directory to the current user. */
  protectDirectory(path: string): Promise<void>
  /** Restrict a newly created file to the current user. */
  protectFile(path: string): Promise<void>
  /** Reject a directory that is not restricted to the current user. */
  verifyDirectory(path: string): Promise<void>
  /** Reject a file that is not restricted to the current user. */
  verifyFile(path: string): Promise<void>
}

/** Process lifecycle signal for a dispatched bootstrap awaiting expiry. */
export interface BrowserBootstrapLifecycle {
  /** Register ownership transfer for a natural Node process exit. */
  addBeforeExitListener(listener: () => void): void
  /** Detach a cleanup listener after another settlement path wins. */
  removeBeforeExitListener(listener: () => void): void
}

/** Durable process owner for a bootstrap whose launcher is exiting. */
export interface BrowserBootstrapDurableOwner {
  /** Retain and remove one private document at its existing expiry. */
  ownUntil(documentPath: string, expiresAt: number): Promise<void>
}

/** Injectable operating-system boundaries for the production browser transport. */
export interface BrowserHandoffTransportOptions {
  /** Existing directory beneath which a fresh private directory is created. */
  readonly parent?: string
  /** Protect and verify the bootstrap paths. */
  readonly access?: BrowserBootstrapAccess
  /** Hand the clean local file URL to the operating system. */
  readonly dispatch?: (url: string) => Promise<void>
  /** Wall clock used to reject and expire the one-use document. */
  readonly now?: () => number
  /** Scheduler used for expiry-bound cleanup. */
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  /** Cancel the expiry scheduler after another settlement path wins. */
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Remove only the owned document and its now-empty directory. */
  readonly remove?: (documentPath: string) => Promise<void>
  /** Signal natural process exit before handoff expiry. */
  readonly lifecycle?: BrowserBootstrapLifecycle
  /** Accept cleanup ownership when the launcher exits before expiry. */
  readonly durableOwner?: BrowserBootstrapDurableOwner
}

/** Production owner-only access policy for transient browser bootstrap paths. */
export const browserBootstrapAccess: BrowserBootstrapAccess = {
  async protectDirectory(path) {
    if (process.platform === 'win32') {
      await protectWindowsPath(path, 'directory')
      return
    }
    await chmod(path, 0o700)
  },
  async protectFile(path) {
    if (process.platform === 'win32') {
      await protectWindowsPath(path, 'file')
      return
    }
    await chmod(path, 0o600)
  },
  async verifyDirectory(path) {
    if (process.platform === 'win32') {
      await verifyWindowsPath(path, 'directory')
      return
    }
    await verifyMode(path, 0o700)
  },
  async verifyFile(path) {
    if (process.platform === 'win32') {
      await verifyWindowsPath(path, 'file')
      return
    }
    await verifyMode(path, 0o600)
  },
}

const browserBootstrapLifecycle: BrowserBootstrapLifecycle = {
  addBeforeExitListener(listener) { process.on('beforeExit', listener) },
  removeBeforeExitListener(listener) { process.off('beforeExit', listener) },
}

const browserBootstrapDurableOwner: BrowserBootstrapDurableOwner = {
  ownUntil(documentPath, expiresAt) {
    const helper = fileURLToPath(new URL('../browser-cleanup.mjs', import.meta.url))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, documentPath, String(expiresAt)], {
        detached: true,
        env: {},
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  },
}

/**
 * Create the launcher-owned local-file browser transport.
 * The Runtime API exposes no handoff-exchange settlement to this client, so
 * successful dispatch remains owned until handoff expiry. Natural process exit
 * transfers that deadline to a detached cleanup helper without forwarding credentials.
 * @param options - injectable private-path, dispatch, clock, and cleanup boundaries.
 * @returns a transport that never puts a handoff in its dispatched URL.
 */
export function createBrowserHandoffTransport(
  options: BrowserHandoffTransportOptions = {},
): BrowserHandoffTransport {
  const parent = options.parent ?? tmpdir()
  const access = options.access ?? browserBootstrapAccess
  const dispatch = options.dispatch ?? dispatchBrowserDocument
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const remove = options.remove ?? removeOwnedBootstrap
  const lifecycle = options.lifecycle ?? browserBootstrapLifecycle
  const durableOwner = options.durableOwner ?? browserBootstrapDurableOwner
  return {
    async open(navigation) {
      validateNavigation(navigation, now())
      const directory = await mkdtemp(join(parent, 'harness-bootstrap-'))
      const documentPath = join(directory, 'index.html')
      try {
        await access.protectDirectory(directory)
        await writeFile(documentPath, bootstrapHtml(navigation), { flag: 'wx', mode: 0o600 })
        await access.protectFile(documentPath)
        await access.verifyDirectory(directory)
        await access.verifyFile(documentPath)
      } catch (error) {
        try {
          await remove(documentPath)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'browser bootstrap protection and cleanup both failed')
        }
        throw error
      }

      let cleanup: Promise<void> | undefined
      let transfer: Promise<void> | undefined
      let transferred = false
      let listenerAttached = false
      const beforeExit = (): void => { transferOwnership() }
      const detach = (): void => {
        clearTimer(timer)
        if (!listenerAttached) return
        listenerAttached = false
        lifecycle.removeBeforeExitListener(beforeExit)
      }
      const clean = (): Promise<void> => {
        if (transferred) return Promise.resolve()
        if (cleanup === undefined) {
          detach()
          cleanup = remove(documentPath)
        }
        return cleanup
      }
      function observeCleanup(): void {
        void clean().catch(() => {
          // Expiry cleanup has no caller to receive a removal failure.
        })
      }
      function transferOwnership(): void {
        if (transferred || cleanup !== undefined || transfer !== undefined) return
        transfer = durableOwner.ownUntil(documentPath, navigation.handoff.expiresAt).then(
          () => {
            if (cleanup !== undefined) return
            transferred = true
            detach()
          },
          () => {
            // A failed helper launch keeps this process alive until its existing expiry cleanup.
            timer.ref()
          },
        )
      }
      const timer = setTimer(observeCleanup, Math.max(0, navigation.handoff.expiresAt - now()))
      timer.unref()
      lifecycle.addBeforeExitListener(beforeExit)
      listenerAttached = true
      try {
        await dispatch(pathToFileURL(documentPath).href)
      } catch (error) {
        try {
          await clean()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'browser bootstrap dispatch and cleanup both failed')
        }
        throw error
      }
    },
  }
}

function validateNavigation(navigation: DashboardNavigation, currentTime: number): void {
  const origin = new URL(navigation.origin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) {
    throw new Error('browser bootstrap target must be an exact http://127.0.0.1 origin')
  }
  if (!/^[A-Za-z0-9_-]{32,}$/u.test(navigation.handoff.id)) {
    throw new Error('browser bootstrap handoff must be opaque')
  }
  if (!Number.isSafeInteger(navigation.handoff.expiresAt) || navigation.handoff.expiresAt <= currentTime) {
    throw new Error('browser bootstrap handoff has expired')
  }
}

function bootstrapHtml(navigation: DashboardNavigation): string {
  return `<!doctype html><meta charset="utf-8"><form id="handoff" method="post" action="${navigation.origin}/_harness/handoff"><input type="hidden" name="handoff" value="${navigation.handoff.id}"></form><script>document.getElementById('handoff').submit()</script>`
}

async function dispatchBrowserDocument(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:HARNESS_BROWSER_BOOTSTRAP_URL',
    ], {
      windowsHide: true,
      env: { ...process.env, HARNESS_BROWSER_BOOTSTRAP_URL: url },
    })
    return
  }
  await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { windowsHide: true })
}

async function removeOwnedBootstrap(documentPath: string): Promise<void> {
  const entry = await lstat(documentPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (entry !== undefined) {
    if (entry.isDirectory()) throw new Error('browser bootstrap document path must not be a directory')
    await unlink(documentPath)
  }
  await rmdir(dirname(documentPath)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

async function verifyMode(path: string, expected: number): Promise<void> {
  const mode = (await stat(path)).mode & 0o777
  if (mode !== expected) throw new Error(`browser bootstrap path must have mode ${expected.toString(8)}`)
}

async function protectWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$acl=if($env:HARNESS_BROWSER_PRIVATE_KIND-eq'directory'){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}",
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true,$false)',
    "$inherit=if($env:HARNESS_BROWSER_PRIVATE_KIND-eq'directory'){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}",
    '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($rule)',
    "if($env:HARNESS_BROWSER_PRIVATE_KIND-eq'directory'){[IO.Directory]::SetAccessControl($env:HARNESS_BROWSER_PRIVATE_PATH,$acl)}else{[IO.File]::SetAccessControl($env:HARNESS_BROWSER_PRIVATE_PATH,$acl)}",
  ].join('; ')
  await runPowerShell(script, path, kind)
}

async function verifyWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$acl=if($env:HARNESS_BROWSER_PRIVATE_KIND-eq'directory'){[IO.Directory]::GetAccessControl($env:HARNESS_BROWSER_PRIVATE_PATH)}else{[IO.File]::GetAccessControl($env:HARNESS_BROWSER_PRIVATE_PATH)}",
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
      HARNESS_BROWSER_PRIVATE_PATH: path,
      HARNESS_BROWSER_PRIVATE_KIND: kind,
    },
  })
}
