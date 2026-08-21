import { join } from 'node:path'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  type RedactedRuntimeDiagnostic,
} from '@harness-desktop/dsh-host-local-runtime'
import { app, BrowserWindow, ipcMain } from 'electron'
import { desktopChannels } from '../shared/desktop-api.ts'
import { createBrowserHandoffTransport } from './browser-handoff-transport.ts'
import { DesktopReadiness } from './readiness.ts'
import { RuntimeDashboardController } from './runtime-dashboard.ts'
import { createWindowOptions, desktopIconPath } from './window-options.ts'

const runtimeConnector = createRuntimeConnector()
const desktopReadiness = new DesktopReadiness()
const runtimeControllers = new Set<RuntimeDashboardController>()
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
    const startup = startDesktopWindow(window).finally(() => {
      startupTasks.delete(startup)
    })
    startupTasks.add(startup)
  })

  void loadRecoveryDocument(window)

  return window
}

async function startDesktopWindow(window: BrowserWindow): Promise<void> {
  try {
    const client = await runtimeConnector.connect({ start: true })
    if (window.isDestroyed()) {
      await client.close()
      return
    }
    const controller = new RuntimeDashboardController(
      client,
      createBrowserHandoffTransport(window, { readiness: desktopReadiness }),
    )
    runtimeControllers.add(controller)
    const result = await controller.open(window)
    if (result.kind === 'dashboard-loaded') {
      recoveryDiagnostics.delete(window)
      return
    }
    recoveryDiagnostics.set(window, result.diagnostic)
    if (!window.isDestroyed()) await loadRecoveryDocument(window)
  } catch (error) {
    recoveryDiagnostics.set(window, normalizeRecoveryDiagnostic(error))
    if (!window.isDestroyed()) {
      try {
        await loadRecoveryDocument(window)
      } catch (loadError) {
        recoveryDiagnostics.set(window, normalizeRecoveryDiagnostic(loadError))
      }
    }
  }
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
ipcMain.handle(desktopChannels.productMetadata, () => productMetadata)

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
