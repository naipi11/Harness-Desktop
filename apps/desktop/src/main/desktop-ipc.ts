import type { RedactedRuntimeDiagnostic } from '@harness-desktop/dsh-host-local-runtime'
import {
  desktopChannels,
  isAllowedDesktopExternalLink,
  isDesktopNotification,
  type DesktopNotification,
  type DesktopRecoveryDiagnostic,
  type DesktopStartupResult,
} from '../shared/desktop-api.ts'

type DesktopChannel = (typeof desktopChannels)[keyof typeof desktopChannels]

/** Minimum Electron invocation event consumed by the Desktop IPC handlers. */
export interface DesktopIpcEvent<Sender = unknown> {
  /** Renderer sender owned by Electron. */
  readonly sender: Sender
}

/** Main IPC handler retained by Electron or a focused test registrar. */
export type DesktopIpcHandler<Event extends DesktopIpcEvent = DesktopIpcEvent> = (
  event: Event,
  ...args: unknown[]
) => unknown

/** Raw folder-dialog result projected before it crosses IPC. */
export interface DesktopFolderDialogResult {
  /** Whether the user dismissed the dialog. */
  readonly canceled: boolean
  /** Native paths selected by the user. */
  readonly filePaths: readonly string[]
}

/** Main-only startup value accepted from the Runtime Dashboard controller. */
export type MainDesktopStartupResult =
  | { readonly kind: 'dashboard-loaded' }
  | { readonly kind: 'recovery'; readonly diagnostic: RedactedRuntimeDiagnostic }

/** Native and Runtime adapters used by the fail-closed Desktop handlers. */
export interface DesktopIpcDependencies<
  Window extends object,
  Event extends DesktopIpcEvent = DesktopIpcEvent,
> {
  /** Resolves the BrowserWindow that owns an invocation event. */
  readonly windowFromEvent: (event: Event) => Window | null
  /** Checks whether Electron has destroyed the resolved window. */
  readonly isWindowDestroyed: (window: Window) => boolean
  /** Returns Electron's currently focused BrowserWindow. */
  readonly getFocusedWindow: () => Window | null
  /** Returns Main's current Foundation diagnostic for the window. */
  readonly readRecoveryDiagnostic: (window: Window) => RedactedRuntimeDiagnostic | undefined
  /** Runs only the explicit user-initiated Dashboard retry. */
  readonly retryDashboard: (window: Window) => Promise<MainDesktopStartupResult>
  /** Copies already formatted renderer-safe text. */
  readonly copyText: (text: string) => Promise<void>
  /** Opens one focused-window directory dialog. */
  readonly selectFolder: (window: Window) => Promise<DesktopFolderDialogResult>
  /** Shows a validated native notification. */
  readonly showNotification: (notification: DesktopNotification) => void
  /** Opens a validated external URL. */
  readonly openExternalLink: (url: string) => Promise<void>
}

interface DesktopIpcRegistrar<Event extends DesktopIpcEvent> {
  readonly handle: (channel: DesktopChannel, handler: DesktopIpcHandler<Event>) => void
}

/**
 * Registers the exact six Desktop IPC operations with fixed renderer-visible failures.
 * @param registrar - Electron IPC registrar or a behaviorally equivalent test owner.
 * @param dependencies - Main-only Runtime and native adapters.
 */
export function registerDesktopIpc<
  Window extends object,
  Event extends DesktopIpcEvent = DesktopIpcEvent,
>(
  registrar: DesktopIpcRegistrar<Event>,
  dependencies: DesktopIpcDependencies<Window, Event>,
): void {
  registrar.handle(desktopChannels.readRecoveryDiagnostic, (event, ...args) => {
    requireNoPayload(args)
    const diagnostic = dependencies.readRecoveryDiagnostic(requireSenderWindow(event, dependencies))
    return diagnostic === undefined ? undefined : toDesktopRecoveryDiagnostic(diagnostic)
  })
  registrar.handle(desktopChannels.retryDashboard, async (event, ...args) => {
    requireNoPayload(args)
    const window = requireSenderWindow(event, dependencies)
    try {
      return toDesktopStartupResult(await dependencies.retryDashboard(window))
    } catch {
      throw desktopError('desktop:retry-failed')
    }
  })
  registrar.handle(desktopChannels.copyRecoveryDiagnostic, async (event, ...args) => {
    requireNoPayload(args)
    const diagnostic = dependencies.readRecoveryDiagnostic(requireSenderWindow(event, dependencies))
    if (diagnostic === undefined) throw desktopError('desktop:no-recovery-diagnostic')
    try {
      await dependencies.copyText(formatRecoveryDiagnostic(toDesktopRecoveryDiagnostic(diagnostic)))
    } catch {
      throw desktopError('desktop:copy-failed')
    }
  })
  registrar.handle(desktopChannels.selectFolder, async (event, ...args) => {
    requireNoPayload(args)
    const window = requireSenderWindow(event, dependencies)
    let focusedWindow: Window | null
    try {
      focusedWindow = dependencies.getFocusedWindow()
    } catch {
      throw desktopError('desktop:window-not-focused')
    }
    if (focusedWindow !== window) throw desktopError('desktop:window-not-focused')
    try {
      const selection = await dependencies.selectFolder(window)
      if (selection.canceled) return { kind: 'cancelled' }
      const path = selection.filePaths[0]
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw desktopError('desktop:folder-selection-failed')
      }
      return { kind: 'selected', path }
    } catch {
      throw desktopError('desktop:folder-selection-failed')
    }
  })
  registrar.handle(desktopChannels.showNotification, (event, ...args) => {
    requireSenderWindow(event, dependencies)
    if (args.length !== 1 || !isDesktopNotification(args[0])) {
      throw desktopError('desktop:invalid-notification')
    }
    try {
      dependencies.showNotification(args[0])
    } catch {
      throw desktopError('desktop:notification-failed')
    }
  })
  registrar.handle(desktopChannels.openExternalLink, async (event, ...args) => {
    requireSenderWindow(event, dependencies)
    if (args.length !== 1 || !isAllowedDesktopExternalLink(args[0])) {
      throw desktopError('desktop:external-link-denied')
    }
    try {
      await dependencies.openExternalLink(args[0])
    } catch {
      throw desktopError('desktop:external-link-failed')
    }
  })
}

function requireNoPayload(args: readonly unknown[]): void {
  if (args.length !== 0) throw desktopError('desktop:invalid-invocation')
}

function requireSenderWindow<Window extends object, Event extends DesktopIpcEvent>(
  event: Event,
  dependencies: DesktopIpcDependencies<Window, Event>,
): Window {
  try {
    const window = dependencies.windowFromEvent(event)
    if (window === null || dependencies.isWindowDestroyed(window)) {
      throw desktopError('desktop:window-unavailable')
    }
    return window
  } catch {
    throw desktopError('desktop:window-unavailable')
  }
}

function toDesktopRecoveryDiagnostic(diagnostic: RedactedRuntimeDiagnostic): DesktopRecoveryDiagnostic {
  return {
    code: diagnostic.code,
    subject: diagnostic.subject,
    message: diagnostic.message,
    correction: diagnostic.correction,
    diagnosticId: diagnostic.diagnosticId,
  }
}

function toDesktopStartupResult(result: MainDesktopStartupResult): DesktopStartupResult {
  return result.kind === 'dashboard-loaded'
    ? { kind: 'dashboard-loaded' }
    : { kind: 'recovery', diagnostic: toDesktopRecoveryDiagnostic(result.diagnostic) }
}

function formatRecoveryDiagnostic(diagnostic: DesktopRecoveryDiagnostic): string {
  return [
    `${diagnostic.subject}: ${diagnostic.code}`,
    diagnostic.message,
    diagnostic.correction,
    `Diagnostic ID: ${diagnostic.diagnosticId}`,
  ].join('\n')
}

function desktopError(code: string): Error {
  return new Error(code)
}
