import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  type RedactedRuntimeDiagnostic,
  type RuntimeClient,
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
import {
  createWindowOptions,
  createDashboardContentSecurityPolicy,
  desktopIconPath,
  installWindowNavigationPolicy,
  WindowRecoveryFlights,
  WindowRuntimeOwners,
} from './window-options.ts'

const runtimeConnector = createRuntimeConnector()
const desktopReadiness = new DesktopReadiness()
const startupTasks = new Set<Promise<unknown>>()
const recoveryDiagnostics = new WeakMap<BrowserWindow, RedactedRuntimeDiagnostic>()
const recoveryFlights = new WindowRecoveryFlights<BrowserWindow>()
const runtimeOwners = new WindowRuntimeOwners<BrowserWindow, RuntimeClient, RuntimeDashboardController>()
const windowsByContents = new Map<number, BrowserWindow>()
const policySessions = new WeakSet<Electron.Session>()
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
  const webContentsId = window.webContents.id
  windowsByContents.set(webContentsId, window)
  installWindowNavigationPolicy(window.webContents, {
    recoveryUrl: recoveryDocumentUrl(),
    dashboardOrigin: () => runtimeOwners.origin(window),
  })
  installDashboardResponsePolicy(window)
  window.webContents.on('render-process-gone', (_event, details) => {
    void recoverDesktopWindow(window, new Error(`Desktop renderer stopped: ${details.reason}`))
  })
  window.once('closed', () => {
    windowsByContents.delete(webContentsId)
  })
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    void recoverDesktopWindow(window, new Error(`Desktop document failed to load: ${description}`))
  })

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
  let unownedClient: RuntimeClient | undefined
  try {
    const client = await runtimeConnector.connect({ start: true })
    unownedClient = client
    if (window.isDestroyed()) {
      await client.close()
      unownedClient = undefined
      return recoveryResult(new Error('Desktop window is closed.'))
    }
    const dashboardOrigin = (await client.status()).dashboardOrigin
    const controller = new RuntimeDashboardController(
      client,
      createBrowserHandoffTransport(window, { readiness: desktopReadiness }),
    )
    runtimeOwners.publish(window, client, controller, dashboardOrigin)
    unownedClient = undefined
    const result = await controller.open(window)
    return await publishStartupResult(window, result)
  } catch (error) {
    let failure = error
    if (unownedClient !== undefined) {
      try {
        await unownedClient.close()
      } catch (closeError) {
        failure = new AggregateError([error, closeError], 'Desktop startup and client release both failed.')
      }
    }
    let diagnostic = normalizeRecoveryDiagnostic(failure)
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

function installDashboardResponsePolicy(window: BrowserWindow): void {
  const browserSession = window.webContents.session
  if (policySessions.has(browserSession)) return
  policySessions.add(browserSession)
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    let origin: string
    try {
      origin = new URL(details.url).origin
    } catch {
      callback(unchangedResponseHeaders(details.responseHeaders))
      return
    }
    const ownerWindow = responseOwnerWindow(browserSession, details.webContentsId, origin)
    if (ownerWindow === undefined) {
      callback(unchangedResponseHeaders(details.responseHeaders))
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [createDashboardContentSecurityPolicy(origin)],
      },
    })
    const path = new URL(details.url).pathname
    if (details.statusCode === 401 || (details.statusCode === 403 && path === '/_harness/dashboard-control')) {
      setImmediate(() => {
        void recoverDesktopWindow(ownerWindow, new Error('Dashboard authentication expired.'))
      })
    }
  })
}

function unchangedResponseHeaders(
  responseHeaders: Record<string, string[]> | undefined,
): Electron.HeadersReceivedResponse {
  return responseHeaders === undefined ? {} : { responseHeaders }
}

function responseOwnerWindow(
  browserSession: Electron.Session,
  webContentsId: number | undefined,
  origin: string,
): BrowserWindow | undefined {
  const direct = webContentsId === undefined ? undefined : windowsByContents.get(webContentsId)
  if (direct !== undefined) return runtimeOwners.origin(direct) === origin ? direct : undefined
  const candidates = BrowserWindow.getAllWindows().filter(window =>
    !window.isDestroyed()
    && window.webContents.session === browserSession
    && runtimeOwners.origin(window) === origin)
  return candidates.length === 1 ? candidates[0] : undefined
}

async function retryDesktopWindow(window: BrowserWindow): Promise<ControllerStartupResult> {
  const controller = runtimeOwners.controller(window)
  if (controller === undefined) return await windowStartups.run(window)
  const client = runtimeOwners.client(window)
  if (client !== undefined) {
    try {
      const origin = (await client.status()).dashboardOrigin
      const previousOrigin = runtimeOwners.origin(window)
      if (previousOrigin !== undefined && previousOrigin !== origin) {
        await runtimeOwners.retire(window).catch(() => {})
        return await windowStartups.run(window)
      }
      runtimeOwners.setOrigin(window, origin)
    } catch (error) {
      await runtimeOwners.retire(window).catch(() => {})
      try {
        return await windowStartups.run(window)
      } catch (restartError) {
        return await publishStartupResult(window, recoveryResult(new AggregateError(
          [error, restartError],
          'Desktop Runtime owner replacement failed.',
        )))
      }
    }
  }
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

async function recoverDesktopWindow(window: BrowserWindow, error: unknown): Promise<void> {
  if (window.isDestroyed()) return
  return recoveryFlights.run(window, async () => {
    recoveryDiagnostics.set(window, normalizeRecoveryDiagnostic(error))
    try {
      await loadRecoveryDocument(window)
    } catch (loadError) {
      recoveryDiagnostics.set(window, normalizeRecoveryDiagnostic(loadError))
    }
  })
}

function recoveryResult(error: unknown): ControllerStartupResult {
  return { kind: 'recovery', diagnostic: normalizeRecoveryDiagnostic(error) }
}

function loadRecoveryDocument(window: BrowserWindow): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl !== undefined) return window.loadURL(rendererUrl)
  return window.loadFile(join(__dirname, '../renderer/index.html'))
}

function recoveryDocumentUrl(): string {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl !== undefined) return rendererUrl
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

async function closeDesktopRuntime(): Promise<void> {
  await windowStartups.close()
  const results = await Promise.allSettled(runtimeOwners.active().map(controller => controller.close()))
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
