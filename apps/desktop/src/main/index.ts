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
import { createBrowserHandoffTransport } from './browser-handoff-transport.ts'
import { registerDesktopIpc } from './desktop-ipc.ts'
import { DesktopReadiness } from './readiness.ts'
import {
  RuntimeDashboardController,
  type DesktopStartupResult as ControllerStartupResult,
} from './runtime-dashboard.ts'
import { WindowStartupFlights } from './window-startup-flights.ts'
import { createWindowOptions, desktopIconPath } from './window-options.ts'

const runtimeConnector = createRuntimeConnector()
const desktopReadiness = new DesktopReadiness()
const runtimeControllers = new Set<RuntimeDashboardController>()
const windowControllers = new WeakMap<BrowserWindow, RuntimeDashboardController>()
const startupTasks = new Set<Promise<unknown>>()
const recoveryDiagnostics = new WeakMap<BrowserWindow, RedactedRuntimeDiagnostic>()
const windowStartups = new WindowStartupFlights(startupTasks, startDesktopWindow)
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
    void windowStartups.run(window).catch(() => {
      // Application shutdown may close startup admission before this one-shot event runs.
    })
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
  if (controller === undefined) return await windowStartups.run(window)
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
  await windowStartups.close()
  const results = await Promise.allSettled([...runtimeControllers].map(controller => controller.close()))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'Desktop Runtime shutdown failed.')
}

app.setAppUserModelId(productMetadata.appId)
registerDesktopIpc<BrowserWindow, IpcMainInvokeEvent>({
  handle: (channel, handler) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => handler(event, ...args))
  },
}, {
  windowFromEvent: event => BrowserWindow.fromWebContents(event.sender),
  isWindowDestroyed: window => window.isDestroyed(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  readRecoveryDiagnostic: window => recoveryDiagnostics.get(window),
  retryDashboard: retryDesktopWindow,
  copyText,
  selectFolder: window => dialog.showOpenDialog(window, { properties: ['openDirectory'] }),
  showNotification: (notification) => { new Notification(notification).show() },
  openExternalLink: url => shell.openExternal(url),
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

function copyText(text: string): Promise<void> {
  clipboard.writeText(text)
  return Promise.resolve()
}
