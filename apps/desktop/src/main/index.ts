import { join } from 'node:path'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  type RedactedRuntimeDiagnostic,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import {
  desktopChannels,
  isAllowedDesktopExternalLink,
  isDesktopNotification,
  type DesktopRecoveryDiagnostic,
  type DesktopStartupResult,
  type FolderSelectionResult,
} from '../shared/desktop-api.ts'
import { createBrowserHandoffTransport } from './browser-handoff-transport.ts'
import { DesktopReadiness } from './readiness.ts'
import {
  RuntimeDashboardController,
  type DesktopStartupResult as ControllerStartupResult,
} from './runtime-dashboard.ts'
import { createWindowOptions, desktopIconPath } from './window-options.ts'

const runtimeConnector = createRuntimeConnector()
const desktopReadiness = new DesktopReadiness()
const runtimeControllers = new Set<RuntimeDashboardController>()
const windowControllers = new WeakMap<BrowserWindow, RuntimeDashboardController>()
const startupTasks = new Set<Promise<void>>()
const recoveryDiagnostics = new WeakMap<BrowserWindow, RedactedRuntimeDiagnostic>()
let shutdownFlight: Promise<void> | undefined
let quitAfterShutdown = false

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createWindowOptions(
      join(__dirname, '../preload/index.cjs'),
      desktopIconPath(process.platform),
    ),
  )

  window.once('ready-to-show', () => {
    window.show()
    const startup = startDesktopWindow(window).then(() => {}).finally(() => {
      startupTasks.delete(startup)
    })
    startupTasks.add(startup)
  })

  void loadRecoveryDocument(window)

  return window
}

async function startDesktopWindow(window: BrowserWindow): Promise<ControllerStartupResult> {
  try {
    const client = await runtimeConnector.connect({ start: true })
    if (window.isDestroyed()) {
      await client.close()
      return recoveryResult(new Error('Desktop window is closed.'))
    }
    const controller = new RuntimeDashboardController(
      client,
      createBrowserHandoffTransport(window, { readiness: desktopReadiness }),
    )
    runtimeControllers.add(controller)
    windowControllers.set(window, controller)
    const result = await controller.open(window)
    return await publishStartupResult(window, result)
  } catch (error) {
    let diagnostic = normalizeRecoveryDiagnostic(error)
    recoveryDiagnostics.set(window, diagnostic)
    if (!window.isDestroyed()) {
      try {
        await loadRecoveryDocument(window)
      } catch (loadError) {
        diagnostic = normalizeRecoveryDiagnostic(loadError)
        recoveryDiagnostics.set(window, diagnostic)
      }
    }
    return { kind: 'recovery', diagnostic }
  }
}

async function retryDesktopWindow(window: BrowserWindow): Promise<ControllerStartupResult> {
  const controller = windowControllers.get(window)
  if (controller === undefined) return await startDesktopWindow(window)
  return await publishStartupResult(window, await controller.retryAfterUserAction(window))
}

async function publishStartupResult(
  window: BrowserWindow,
  result: ControllerStartupResult,
): Promise<ControllerStartupResult> {
  if (result.kind === 'dashboard-loaded') {
    recoveryDiagnostics.delete(window)
    return result
  }
  let diagnostic = result.diagnostic
  recoveryDiagnostics.set(window, diagnostic)
  if (!window.isDestroyed()) {
    try {
      await loadRecoveryDocument(window)
    } catch (error) {
      diagnostic = normalizeRecoveryDiagnostic(error)
      recoveryDiagnostics.set(window, diagnostic)
    }
  }
  return { kind: 'recovery', diagnostic }
}

function recoveryResult(error: unknown): ControllerStartupResult {
  return { kind: 'recovery', diagnostic: normalizeRecoveryDiagnostic(error) }
}

function loadRecoveryDocument(window: BrowserWindow): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl !== undefined) return window.loadURL(rendererUrl)
  return window.loadFile(join(__dirname, '../renderer/index.html'))
}

async function closeDesktopRuntime(): Promise<void> {
  await Promise.allSettled([...startupTasks])
  const results = await Promise.allSettled([...runtimeControllers].map(controller => controller.close()))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'Desktop Runtime shutdown failed.')
}

app.setAppUserModelId(productMetadata.appId)
ipcMain.handle(desktopChannels.readRecoveryDiagnostic, (event, ...args: unknown[]) => {
  requireNoPayload(args)
  const diagnostic = recoveryDiagnostics.get(requireSenderWindow(event))
  return diagnostic === undefined ? undefined : toDesktopRecoveryDiagnostic(diagnostic)
})
ipcMain.handle(desktopChannels.retryDashboard, async (event, ...args: unknown[]) => {
  requireNoPayload(args)
  const window = requireSenderWindow(event)
  try {
    return toDesktopStartupResult(await retryDesktopWindow(window))
  } catch {
    throw desktopError('desktop:retry-failed')
  }
})
ipcMain.handle(desktopChannels.copyRecoveryDiagnostic, async (event, ...args: unknown[]) => {
  requireNoPayload(args)
  const diagnostic = recoveryDiagnostics.get(requireSenderWindow(event))
  if (diagnostic === undefined) throw desktopError('desktop:no-recovery-diagnostic')
  try {
    await copyText(formatRecoveryDiagnostic(toDesktopRecoveryDiagnostic(diagnostic)))
  } catch {
    throw desktopError('desktop:copy-failed')
  }
})
ipcMain.handle(desktopChannels.selectFolder, async (event, ...args: unknown[]): Promise<FolderSelectionResult> => {
  requireNoPayload(args)
  const window = requireSenderWindow(event)
  let focusedWindow: BrowserWindow | null
  try {
    focusedWindow = BrowserWindow.getFocusedWindow()
  } catch {
    throw desktopError('desktop:window-not-focused')
  }
  if (focusedWindow !== window) throw desktopError('desktop:window-not-focused')
  try {
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
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
ipcMain.handle(desktopChannels.showNotification, (event, ...args: unknown[]) => {
  requireSenderWindow(event)
  if (args.length !== 1 || !isDesktopNotification(args[0])) {
    throw desktopError('desktop:invalid-notification')
  }
  try {
    new Notification(args[0]).show()
  } catch {
    throw desktopError('desktop:notification-failed')
  }
})
ipcMain.handle(desktopChannels.openExternalLink, async (event, ...args: unknown[]) => {
  requireSenderWindow(event)
  if (args.length !== 1 || !isAllowedDesktopExternalLink(args[0])) {
    throw desktopError('desktop:external-link-denied')
  }
  try {
    await shell.openExternal(args[0])
  } catch {
    throw desktopError('desktop:external-link-failed')
  }
})

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterShutdown) return
  event.preventDefault()
  shutdownFlight ??= closeDesktopRuntime()
  void shutdownFlight.then(
    () => {
      quitAfterShutdown = true
      app.quit()
    },
    () => {
      // Failed local release cannot leave the application resident after quit.
      quitAfterShutdown = true
      app.quit()
    },
  )
})

app.on('will-quit', () => {
  void closeDesktopRuntime().catch(() => {
    // before-quit already awaited and handled the same idempotent local release.
  })
})

function requireNoPayload(args: readonly unknown[]): void {
  if (args.length !== 0) throw desktopError('desktop:invalid-invocation')
}

function requireSenderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  try {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) throw desktopError('desktop:window-unavailable')
    return window
  } catch {
    throw desktopError('desktop:window-unavailable')
  }
}

/**
 * Copies only the five renderer-safe diagnostic fields into a new IPC value.
 * @param diagnostic - Foundation diagnostic retained by Main.
 * @returns a value without Runtime authority or internal fields.
 */
function toDesktopRecoveryDiagnostic(diagnostic: RedactedRuntimeDiagnostic): DesktopRecoveryDiagnostic {
  return {
    code: diagnostic.code,
    subject: diagnostic.subject,
    message: diagnostic.message,
    correction: diagnostic.correction,
    diagnosticId: diagnostic.diagnosticId,
  }
}

function toDesktopStartupResult(result: ControllerStartupResult): DesktopStartupResult {
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

function copyText(text: string): Promise<void> {
  clipboard.writeText(text)
  return Promise.resolve()
}

function desktopError(code: string): Error {
  return new Error(code)
}
