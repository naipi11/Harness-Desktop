/** Installed Harness Desktop resolution and activation without Runtime ownership. */

import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { Branded } from '@harness-desktop/dsh-brand'

/** Opaque correlation identifier for one Desktop activation diagnostic. */
export type DesktopDiagnosticId = Branded<'DesktopDiagnosticId'>

/** Observable completion required from one native installed-application launch. */
export type InstalledDesktopLaunchResult =
  | { readonly kind: 'spawned' }
  | { readonly kind: 'exited'; readonly exitCode: number | null }

/** Activate the registered Harness Desktop installation. */
export interface InstalledDesktopActivator {
  /** @returns acknowledgement after the installed application accepts activation. */
  activate(): Promise<'activated'>
}

/** Output owned by one Desktop CLI invocation. */
export interface DesktopIO {
  /** Redacted installation diagnostics. */
  readonly stderr: Writable
}

/** Host operations used to resolve and activate an installed desktop application. */
export interface InstalledDesktopActivatorOptions {
  /** Operating system whose native installation registration is resolved. */
  readonly platform?: NodeJS.Platform
  /** Environment used only for operating-system installation roots. */
  readonly env?: Readonly<Partial<Pick<NodeJS.ProcessEnv,
    'HOME' | 'LOCALAPPDATA' | 'ProgramFiles' | 'ProgramFiles(x86)' | 'XDG_DATA_HOME'>>>
  /** Filesystem presence check for one registered installation candidate. */
  readonly exists?: (path: string) => Promise<boolean>
  /** Native application launcher. */
  readonly launch?: (
    command: string,
    args: readonly string[],
    waitForExit: boolean,
  ) => Promise<InstalledDesktopLaunchResult>
  /** Redacted correlation identifier factory. */
  readonly diagnosticId?: () => DesktopDiagnosticId
}

/** Installed Desktop absence containing only its public recovery route and correlation id. */
export class DesktopNotInstalledError extends Error {
  /**
   * @param installationRoute - platform-specific installation correction.
   * @param diagnosticId - redacted correlation identifier.
   */
  constructor(
    readonly installationRoute: string,
    readonly diagnosticId: DesktopDiagnosticId,
  ) {
    super('Harness Desktop is not installed.')
    this.name = 'DesktopNotInstalledError'
  }
}

interface DesktopLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly waitForExit: boolean
}

const HELPER_EXIT_TIMEOUT_MS = 10_000
const DESKTOP_EXECUTABLE_NAME = 'harness-desktop'
const DESKTOP_PACKAGE_INSTALL_ROOT = '@harness-desktopdsh-desktop'
const DESKTOP_PRODUCT_INSTALL_ROOT = 'Harness Desktop'

function installationRoute(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Install Harness Desktop with the Windows NSIS installer from GitHub Releases.'
    case 'darwin':
      return 'Install Harness Desktop from the macOS universal DMG on GitHub Releases.'
    case 'linux':
      return 'Install Harness Desktop with the Linux Deb package from GitHub Releases.'
    default:
      return 'Install Harness Desktop for this platform from GitHub Releases.'
  }
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

function installationCandidates(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly DesktopLaunch[] {
  switch (platform) {
    case 'win32': {
      const installRoots = [DESKTOP_PACKAGE_INSTALL_ROOT, DESKTOP_PRODUCT_INSTALL_ROOT]
      const localAppData = env.LOCALAPPDATA
      const perUser = nonempty(localAppData)
        ? installRoots.map(root => win32.join(
          localAppData,
          'Programs',
          root,
          `${DESKTOP_EXECUTABLE_NAME}.exe`,
        ))
        : []
      const machineWide = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(nonempty).flatMap(programs => (
        installRoots.map(root => win32.join(programs, root, `${DESKTOP_EXECUTABLE_NAME}.exe`))
      ))
      return [...perUser, ...machineWide].map(application => ({
        command: application,
        args: [],
        waitForExit: false,
      }))
    }
    case 'darwin': {
      const userHome = env.HOME ?? homedir()
      const applicationNames = [`${DESKTOP_EXECUTABLE_NAME}.app`, `${DESKTOP_PRODUCT_INSTALL_ROOT}.app`]
      return [
        ...(nonempty(userHome)
          ? applicationNames.map(application => posix.join(userHome, 'Applications', application))
          : []),
        ...applicationNames.map(application => posix.join('/Applications', application)),
      ].map(application => ({ command: 'open', args: [application], waitForExit: true }))
    }
    case 'linux': {
      const userHome = env.HOME ?? homedir()
      const userData = env.XDG_DATA_HOME ?? (nonempty(userHome) ? posix.join(userHome, '.local', 'share') : undefined)
      const roots = [userData, '/usr/local/share', '/usr/share'].filter(nonempty)
      return roots.flatMap(root => [
        'io.github.naipi11.harness-desktop.desktop',
        'harness-desktop.desktop',
      ].map((entry) => {
        const desktopEntry = posix.join(root, 'applications', entry)
        return { command: 'gio', args: ['launch', desktopEntry], waitForExit: true }
      }))
    }
    default:
      return []
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return false
    }
    throw error
  }
}

function launchNativeApplication(
  command: string,
  args: readonly string[],
  waitForExit: boolean,
): Promise<InstalledDesktopLaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: !waitForExit, stdio: 'ignore', windowsHide: true })
    if (!waitForExit) {
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve({ kind: 'spawned' })
      })
      return
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Desktop activation helper timed out'))
    }, HELPER_EXIT_TIMEOUT_MS)
    timeout.unref()
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timeout)
      resolve({ kind: 'exited', exitCode })
    })
  })
}

/**
 * Create the sole platform resolver and activator for an installed Harness Desktop application.
 * @param options - replaceable operating-system boundaries for deterministic tests and packaging consumers.
 * @returns a zero-argument installed-application activator.
 */
export function createInstalledDesktopActivator(
  options: InstalledDesktopActivatorOptions = {},
): InstalledDesktopActivator {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? pathExists
  const launch = options.launch ?? launchNativeApplication
  const diagnosticId = options.diagnosticId ?? (() => randomUUID() as DesktopDiagnosticId)
  const route = installationRoute(platform)
  return {
    async activate() {
      for (const candidate of installationCandidates(platform, env)) {
        const installedPath = candidate.command === 'open' || candidate.command === 'gio'
          ? candidate.args.at(-1)
          : candidate.command
        if (installedPath === undefined) continue
        let installed = false
        try {
          installed = await exists(installedPath)
        } catch {
          // A candidate that cannot be inspected is not a usable installed application.
        }
        if (!installed) continue
        let result: InstalledDesktopLaunchResult | undefined
        try {
          result = await launch(candidate.command, candidate.args, candidate.waitForExit)
        } catch {
          // A candidate that cannot be activated is not a usable installed application.
        }
        if (!candidate.waitForExit && result?.kind === 'spawned') return 'activated'
        if (candidate.waitForExit && result?.kind === 'exited' && result.exitCode === 0) return 'activated'
      }
      throw new DesktopNotInstalledError(route, diagnosticId())
    },
  }
}

/**
 * Activate only the installed Desktop client and map absence to redacted CLI output.
 * @param activator - installed-application resolver and activator.
 * @param io - Desktop diagnostic output.
 * @returns zero after activation or the public unavailable exit code.
 */
export async function runDesktopInvocation(
  activator: InstalledDesktopActivator,
  io: DesktopIO,
): Promise<number> {
  try {
    await activator.activate()
    return 0
  } catch (error) {
    if (!(error instanceof DesktopNotInstalledError)) throw error
    io.stderr.write(`${error.message}\n${error.installationRoute}\nDiagnostic: ${error.diagnosticId}\n`)
    return 3
  }
}
