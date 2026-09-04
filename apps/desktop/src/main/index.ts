import { writeFile } from 'node:fs/promises'
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
  Menu,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import { createBrowserHandoffTransport } from './browser-handoff-transport.ts'
import {
  DesktopClosePolicy,
  DesktopTrayLifecycle,
  desktopCloseChoices,
  type DesktopTrayAction,
} from './close-policy.ts'
import { registerDesktopIpc } from './desktop-ipc.ts'
import { completeDesktopDashboardStartup } from './dashboard-startup.ts'
import { DesktopReadiness } from './readiness.ts'
import { DesktopUpdateService } from './update/service.ts'
import {
  mayCheckAutomaticDesktopUpdate,
  NativeDesktopInstallAdapter,
  parseNativeUpdateLaunchNonce,
  shouldAcknowledgeDashboardHealth,
  type NativeUpdateHealth,
} from './update/native-install.ts'
import { launchNativeRollbackWorker } from './update/native-rollback-launcher.ts'
import { scheduleRequiredNativeRollback } from './update/native-update-startup.ts'
import { NativeUpdateOutcomeRecorder, recordAndFinalizeNativeUpdateHealth } from './update/native-update-outcome.ts'
import { DesktopUpdateFlightGate, NativeTransitionGate } from './update/native-transition-gate.ts'
import { settleDesktopMainShutdown } from './update/main-shutdown.ts'
import type { NativeRollbackPlan, NativeUpdateWatchPlan } from './update/native-rollback.ts'
import { loadDesktopUpdateSource, type DesktopUpdateSource } from './update/release-source.ts'
import { resolveSelfUpdateInstallation } from './update/self-installation.ts'
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

if (process.env.DSH_DESKTOP_RUNTIME_PROBE === '1' || process.argv.includes('--dsh-runtime-probe')) {
  const probeStartedFile = process.env.DSH_RUNTIME_PROBE_STARTED_FILE
  if (probeStartedFile !== undefined && probeStartedFile !== '') {
    await writeFile(probeStartedFile, 'started\n', { flag: 'wx', mode: 0o600 })
  }
  try {
    await import('@harness-desktop/dsh-host-local-runtime/bin')
  } catch (error) {
    const probeErrorFile = process.env.DSH_RUNTIME_PROBE_ERROR_FILE
    if (probeErrorFile !== undefined && probeErrorFile !== '') {
      await writeFile(probeErrorFile, `${String(error)}\n`, { flag: 'wx', mode: 0o600 })
    }
    process.stderr.write(`packaged Runtime probe failed: ${String(error)}\n`)
    process.exit(1)
  }
  app.quit()
  process.exit(0)
}

const runtimeConnector = createRuntimeConnector()
const desktopReadiness = new DesktopReadiness()
const ownsDesktopInstance = app.requestSingleInstanceLock()
let nativeUpdateAdapter: NativeDesktopInstallAdapter | undefined
let desktopUpdateSource: DesktopUpdateSource | undefined
let startupNativeUpdateHealth: NativeUpdateHealth = { kind: 'none' }
let automaticUpdateChecked = false
let nativeExitAction: (() => void) | undefined
const nativeTransitionGate = new NativeTransitionGate()
const automaticUpdateGate = new DesktopUpdateFlightGate()
const nativeUpdateOutcomeRecorder = new NativeUpdateOutcomeRecorder()
const startupTasks = new Set<Promise<unknown>>()
const recoveryDiagnostics = new WeakMap<BrowserWindow, RedactedRuntimeDiagnostic>()
const recoveryFlights = new WindowRecoveryFlights<BrowserWindow>()
const runtimeOwners = new WindowRuntimeOwners<BrowserWindow, RuntimeClient, RuntimeDashboardController>()
const windowsByContents = new Map<number, BrowserWindow>()
const policySessions = new WeakSet<Electron.Session>()
const windowStartups = new WindowStartupFlights(startupTasks, startDesktopWindow)
const admittedWindowCloses = new WeakSet<BrowserWindow>()
let shutdownFlight: Promise<void> | undefined
let quitAfterShutdown = false

function showNativeRecoveryBlocked(): void {
  dialog.showErrorBox(
    'Harness Desktop update recovery is blocked',
    'The local update recovery record cannot be validated. Reinstall the last stable signed installer before reopening Harness Desktop.',
  )
}

async function initializeNativeUpdates(): Promise<'continue' | 'rollback-scheduled' | 'recovery-blocked'> {
  const installation = await selfUpdateInstallation()
  if (!app.isPackaged || installation === undefined) return 'continue'
  let source: DesktopUpdateSource
  try {
    source = await loadDesktopUpdateSource({
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
      currentVersion: app.getVersion(),
    })
  } catch {
    dialog.showErrorBox(
      'Harness Desktop updates are unavailable',
      'The packaged update policy cannot be validated. Automatic updates are disabled until a signed stable installer is reinstalled.',
    )
    return 'continue'
  }
  const candidateLaunchNonce = process.platform === 'win32' ? parseNativeUpdateLaunchNonce(process.argv) : undefined
  const adapter = new NativeDesktopInstallAdapter({
    appId: productMetadata.appId,
    source,
    storageDirectory: app.getPath('userData'),
    platform: process.platform,
    arch: process.arch,
    currentVersion: app.getVersion(),
    applicationPath: installation.applicationPath,
    ...(candidateLaunchNonce === undefined ? {} : { candidateLaunchNonce }),
    healthCheckTimeoutMs: source.healthCheckTimeoutMs,
    nativeWorkerReadyTimeoutMs: source.nativeWorkerReadyTimeoutMs,
    requestRestart: requestNativeInstall,
    ...(installation.appImagePath === undefined ? {} : { appImagePath: installation.appImagePath }),
  })
  nativeUpdateAdapter = adapter
  desktopUpdateSource = source
  try {
    startupNativeUpdateHealth = await adapter.beginDashboardHealthCheck(app.getVersion())
  } catch {
    showNativeRecoveryBlocked()
    return 'recovery-blocked'
  }
  if (startupNativeUpdateHealth.kind === 'recovery-blocked') {
    showNativeRecoveryBlocked()
    return 'recovery-blocked'
  }
  if (startupNativeUpdateHealth.kind !== 'rollback-required') return 'continue'
  try {
    const resolution = await scheduleRequiredNativeRollback(adapter)
    if (resolution.result === 'continue') startupNativeUpdateHealth = resolution.health
    return resolution.result
  } catch {
    dialog.showErrorBox(
      'Harness Desktop rollback is blocked',
      'The verified rollback installer could not be started. Reinstall the last stable signed installer before reopening Harness Desktop.',
    )
    return 'recovery-blocked'
  }
}

async function selfUpdateInstallation() {
  return await resolveSelfUpdateInstallation({
    platform: process.platform,
    executablePath: process.execPath,
    appImagePath: process.env.APPIMAGE,
    appDirectory: process.env.APPDIR,
  })
}

async function requestNativeInstall(
  plan: NativeRollbackPlan | NativeUpdateWatchPlan,
  workerReadyTimeoutMs: number,
  afterWorkerReady?: () => Promise<void>,
): Promise<void> {
  if (shutdownFlight !== undefined) throw new Error('native Desktop transition cannot begin during shutdown')
  await nativeTransitionGate.start(async () => {
    await launchNativeRollbackWorker({
      platform: process.platform,
      executablePath: process.execPath,
      workerPath: join(process.resourcesPath, 'native-rollback-worker.js'),
      windowsSupervisorTemplatePath: join(process.resourcesPath, 'windows-native-update-supervisor.exe'),
      windowsWorkerTemplatePath: join(process.resourcesPath, 'windows-native-rollback-worker.ps1'),
      plan,
      workerReadyTimeoutMs,
      ...(afterWorkerReady === undefined ? {} : { afterReady: afterWorkerReady }),
    })
    nativeExitAction = () => { app.quit() }
  })
  app.quit()
}

/** @returns whether no detached native watchdog still owns the current update journal. */
async function settleNativeDashboardHealth(client: RuntimeClient): Promise<boolean> {
  const adapter = nativeUpdateAdapter
  if (adapter === undefined) return true
  try {
    if (shouldAcknowledgeDashboardHealth(startupNativeUpdateHealth)) {
      const health = await adapter.acknowledgeDashboardHealth(app.getVersion())
      startupNativeUpdateHealth = health
    }
    await recordAndFinalizeNativeUpdateHealth(
      nativeUpdateOutcomeRecorder,
      client,
      startupNativeUpdateHealth,
      app.getVersion(),
      async (health) => { await adapter.finalizeDashboardHealth(health) },
    )
    return nativeUpdateTransactionSettled(startupNativeUpdateHealth)
  } catch {
    // A failed persistence or cleanup step retains enough private state for a later settlement attempt.
    return false
  }
}

/** @returns whether a prior native update has committed or reached a terminal stable state. */
function nativeUpdateTransactionSettled(health: NativeUpdateHealth): boolean {
  return health.kind === 'none' || health.kind === 'applied' || health.kind === 'rolled-back'
}

function scheduleAutomaticDesktopUpdate(client: RuntimeClient): void {
  const adapter = nativeUpdateAdapter
  const source = desktopUpdateSource
  if (automaticUpdateChecked || adapter === undefined || source === undefined) return
  automaticUpdateChecked = true
  const service = new DesktopUpdateService({
    appId: productMetadata.appId,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    trust: source.trust,
    runtime: client,
    loadManifest: async (...arguments_) => await source.loadManifest(...arguments_),
    adapter,
  })
  void automaticUpdateGate.start(async (signal) => {
    const result = await service.checkAndStage(signal)
    if (result.kind === 'staged') await service.applyStagedUpdate(signal)
  }).catch(() => {
    // The service records redacted update outcomes after a configured source transaction fails.
  })
}

const trayLifecycle = new DesktopTrayLifecycle<BrowserWindow, Tray>({
  create: createTray,
  destroy: (tray) => { tray.destroy() },
  isDestroyed: window => window.isDestroyed(),
  restore: restoreWindow,
  requestClose: window => closePolicy.request(window),
  quitApplication: () => { app.quit() },
  reportCloseFailure,
})
const closePolicy = new DesktopClosePolicy<BrowserWindow>({
  client: window => runtimeOwners.client(window),
  choose: chooseActiveWorkClose,
  minimizeToTray: (window) => {
    trayLifecycle.ensure(window)
    window.hide()
  },
  closeOwnClient: window => runtimeOwners.retire(window),
  closeWindow: (window) => {
    if (window.isDestroyed()) return
    admittedWindowCloses.add(window)
    window.close()
  },
  reportStopFailure: reportActiveWorkStopFailure,
})

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
  window.on('close', (event) => {
    if (quitAfterShutdown || admittedWindowCloses.delete(window)) return
    event.preventDefault()
    void closePolicy.request(window).catch((error: unknown) => {
      void reportCloseFailure(window, error).catch(() => {
        // Native teardown may make the already-redacted close-failure dialog unavailable.
      })
    })
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
    return await controller.ownStartupSettlement(
      completeDesktopWindowStartup(window, client, () => controller.open(window)),
    )
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
  if (runtimeOwners.retiring(window)) {
    try {
      await runtimeOwners.retire(window)
    } catch (error) {
      return await publishStartupResult(window, recoveryResult(error))
    }
    return await windowStartups.run(window)
  }
  const controller = runtimeOwners.controller(window)
  if (controller === undefined) return await windowStartups.run(window)
  const client = runtimeOwners.client(window)
  if (client !== undefined) {
    try {
      const origin = (await client.status()).dashboardOrigin
      const previousOrigin = runtimeOwners.origin(window)
      if (previousOrigin !== undefined && previousOrigin !== origin) {
        try {
          await runtimeOwners.retire(window)
        } catch (error) {
          return await publishStartupResult(window, recoveryResult(error))
        }
        return await windowStartups.run(window)
      }
      runtimeOwners.setOrigin(window, origin)
    } catch (error) {
      try {
        await runtimeOwners.retire(window)
      } catch (retireError) {
        return await publishStartupResult(window, recoveryResult(new AggregateError(
          [error, retireError],
          'Desktop Runtime owner retirement failed.',
        )))
      }
      try {
        return await windowStartups.run(window)
      } catch (restartError) {
        return await publishStartupResult(window, recoveryResult(new AggregateError(
          [error, restartError],
          'Desktop Runtime owner replacement failed.',
        )))
      }
    }
    return await controller.ownStartupSettlement(
      completeDesktopWindowStartup(
        window,
        client,
        () => controller.retryAfterUserAction(window),
      ),
    )
  }
  return await publishStartupResult(window, await controller.retryAfterUserAction(window))
}

function completeDesktopWindowStartup(
  window: BrowserWindow,
  client: RuntimeClient,
  load: () => Promise<ControllerStartupResult>,
): Promise<ControllerStartupResult> {
  return completeDesktopDashboardStartup(client, load, {
    publish: async result => await publishStartupResult(window, result),
    settleNativeHealth: settleNativeDashboardHealth,
    mayCheckAutomaticUpdate: () => mayCheckAutomaticDesktopUpdate(startupNativeUpdateHealth),
    scheduleAutomaticUpdate: scheduleAutomaticDesktopUpdate,
  })
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

void app.whenReady().then(async () => {
  if (!ownsDesktopInstance) {
    app.quit()
    return
  }
  const nativeUpdateStartup = await initializeNativeUpdates()
  if (nativeUpdateStartup !== 'continue') {
    app.quit()
    return
  }
  createWindow()

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (existing === undefined) createWindow()
    else restoreWindow(existing)
  })
})

app.on('second-instance', () => {
  const existing = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
  if (existing !== undefined) restoreWindow(existing)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterShutdown) return
  event.preventDefault()
  shutdownFlight ??= settleDesktopMainShutdown(automaticUpdateGate, nativeTransitionGate, closeDesktopRuntime)
  void shutdownFlight.then(
    completeApplicationQuit,
    completeApplicationQuit,
  )
})

function completeApplicationQuit(): void {
  quitAfterShutdown = true
  const nativeAction = nativeExitAction
  nativeExitAction = undefined
  if (nativeAction === undefined) {
    app.quit()
    return
  }
  try {
    nativeAction()
  } catch {
    // A failed native installer action must still let its already-ready watchdog restore the retained release.
    app.quit()
  }
}

app.on('will-quit', () => {
  trayLifecycle.dispose()
  void closeDesktopRuntime().catch(() => {
    // before-quit already awaited and handled the same idempotent local release.
  })
})

function copyText(text: string): Promise<void> {
  clipboard.writeText(text)
  return Promise.resolve()
}

function createTray(actions: readonly DesktopTrayAction[]): Tray {
  const tray = new Tray(desktopIconPath(process.platform))
  tray.setToolTip(productMetadata.productName)
  tray.setContextMenu(Menu.buildFromTemplate(actions.map(action => ({
    label: action.label,
    click: () => {
      void action.click().catch(() => {
        // Tray actions report close failures before their returned promise settles.
      })
    },
  }))))
  tray.on('click', () => {
    void actions[0]?.click().catch(() => {
      // Tray actions report close failures before their returned promise settles.
    })
  })
  return tray
}

function restoreWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.show()
  window.focus()
}

async function chooseActiveWorkClose(
  window: BrowserWindow,
  _status: Awaited<ReturnType<RuntimeClient['observeActiveWork']>>,
): Promise<'minimize-to-tray' | 'safely-stop-own-ui-work' | 'cancel'> {
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Active work is running',
    message: 'Choose what Harness Desktop should do with your active work.',
    detail: 'Keep it running in the tray, stop only this Desktop client’s work safely, or cancel closing.',
    buttons: ['Minimize to Tray', 'Safely Stop My Work', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  return desktopCloseChoices[result.response] ?? 'cancel'
}

async function reportActiveWorkStopFailure(
  window: BrowserWindow,
  result: Extract<Awaited<ReturnType<RuntimeClient['stopOwnUiWork']>>, { readonly kind: 'failed' }>,
): Promise<void> {
  await dialog.showMessageBox(window, {
    type: 'error',
    title: result.diagnostic.subject,
    message: result.diagnostic.message,
    detail: `${result.diagnostic.correction}\nDiagnostic ID: ${result.diagnostic.diagnosticId}`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
}

async function reportCloseFailure(window: BrowserWindow, error: unknown): Promise<void> {
  if (window.isDestroyed()) return
  const diagnostic = normalizeRecoveryDiagnostic(error)
  await dialog.showMessageBox(window, {
    type: 'error',
    title: diagnostic.subject,
    message: diagnostic.message,
    detail: `${diagnostic.correction}\nDiagnostic ID: ${diagnostic.diagnosticId}`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
}
