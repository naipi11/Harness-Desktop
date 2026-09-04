import { fileURLToPath } from 'node:url'
import type { EventEmitter } from 'node:events'
import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * Resolve the generated native icon appropriate for a desktop platform.
 * @param platform - Node platform identifier that selects the native asset format.
 * @returns Absolute path to the generated icon included with the Desktop application.
 */
export function desktopIconPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return fileURLToPath(new URL('../../resources/icons/win/harness-desktop.ico', import.meta.url))
  }
  if (platform === 'darwin') {
    return fileURLToPath(new URL('../../resources/icons/mac/harness-desktop.icns', import.meta.url))
  }
  return fileURLToPath(new URL('../../resources/icons/linux/harness-desktop-512.png', import.meta.url))
}

/**
 * Create the fixed BrowserWindow configuration for the Desktop renderer.
 * @param preload - Absolute path to the sandboxed preload entry.
 * @param icon - Absolute path to the generated native window icon.
 * @returns BrowserWindow options with the generated native icon.
 */
export function createWindowOptions(
  preload: string,
  icon: string = desktopIconPath(process.platform),
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: productMetadata.productName,
    icon,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}

/** Electron navigation event whose default action Main may reject. */
export interface DesktopNavigationEvent {
  /** Reject the pending top-level navigation. */
  preventDefault(): void
}

/** Minimal WebContents face used by the fixed Desktop navigation policy. */
export interface DesktopNavigationContents extends Pick<EventEmitter, 'on'> {
  /** Install the policy for renderer requests that would create a child window. */
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void
}

/** Exact local documents and Runtime origin accepted by Desktop navigation. */
export interface DesktopNavigationPolicy {
  /** Local recovery document URL. */
  readonly recoveryUrl: string
  /** @returns the current controller's exact loopback Dashboard origin, when attached. */
  readonly dashboardOrigin: () => string | undefined
}

/**
 * Deny renderer child windows and navigation outside the local recovery document or attached Runtime.
 * @param contents - Main-owned Electron WebContents.
 * @param policy - current exact recovery and Runtime locations.
 */
export function installWindowNavigationPolicy(
  contents: DesktopNavigationContents,
  policy: DesktopNavigationPolicy,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event: DesktopNavigationEvent, target: string) => {
    if (target === policy.recoveryUrl || isCurrentDashboardNavigation(target, policy.dashboardOrigin())) return
    event.preventDefault()
  })
}

function isCurrentDashboardNavigation(target: string, expectedOrigin: string | undefined): boolean {
  if (expectedOrigin === undefined) return false
  try {
    const url = new URL(target)
    return url.origin === expectedOrigin
  } catch {
    return false
  }
}

/**
 * Build the Desktop Dashboard policy with one exact loopback event-stream origin.
 * @param dashboardOrigin - validated current Runtime HTTP origin.
 * @returns complete response policy without a broad WebSocket source.
 */
export function createDashboardContentSecurityPolicy(dashboardOrigin: string): string {
  const origin = new URL(dashboardOrigin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '') {
    throw new Error('Desktop Dashboard CSP requires an exact loopback Runtime origin.')
  }
  const websocketOrigin = `ws://127.0.0.1:${origin.port}`
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${websocketOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Coalesces one recovery operation per Main-owned window. */
export class WindowRecoveryFlights<Window extends object> {
  private readonly flights = new WeakMap<Window, Promise<void>>()

  /**
   * Register a flight before deferring its operation, so synchronous event reentry observes it.
   * @param window - window whose recovery operation is being admitted.
   * @param operation - one asynchronous recovery document load.
   * @returns the existing or newly admitted recovery settlement.
   */
  run(window: Window, operation: () => Promise<void>): Promise<void> {
    const existing = this.flights.get(window)
    if (existing !== undefined) return existing
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const flight = new Promise<void>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    this.flights.set(window, flight)
    const settle = (): void => {
      if (this.flights.get(window) === flight) this.flights.delete(window)
    }
    void Promise.resolve().then(operation).then(resolve, reject)
    void flight.then(settle, settle)
    return flight
  }
}

/** Minimum controller lifetime owned by one Desktop window. */
export interface ClosableWindowController {
  /** Release the controller's attachment and Runtime client. */
  close(): Promise<void>
}

/** Tracks the current Runtime client, controller, and exact origin for every Desktop window. */
export class WindowRuntimeOwners<
  Window extends object,
  Client,
  Controller extends ClosableWindowController,
> {
  private readonly clients = new WeakMap<Window, Client>()
  private readonly controllers = new WeakMap<Window, Controller>()
  private readonly origins = new WeakMap<Window, string>()
  private readonly retirements = new WeakMap<Window, {
    readonly client: Client | undefined
    readonly controller: Controller
    flight: Promise<void> | undefined
  }>()
  private readonly activeControllers = new Set<Controller>()

  /** Publish one fully constructed window owner. */
  publish(window: Window, client: Client, controller: Controller, origin: string): void {
    if (this.retirements.has(window)) {
      throw new Error('Desktop window Runtime owner retirement is incomplete.')
    }
    this.clients.set(window, client)
    this.controllers.set(window, controller)
    this.origins.set(window, origin)
    this.activeControllers.add(controller)
  }

  /** @returns the window's current Runtime client. */
  client(window: Window): Client | undefined {
    return this.clients.get(window) ?? this.retirements.get(window)?.client
  }

  /** @returns the window's current Dashboard controller. */
  controller(window: Window): Controller | undefined { return this.controllers.get(window) }

  /** @returns the window's current exact Dashboard origin. */
  origin(window: Window): string | undefined { return this.origins.get(window) }

  /** Replace only the current client's validated Dashboard origin. */
  setOrigin(window: Window, origin: string): void { this.origins.set(window, origin) }

  /** @returns every controller still owned by the Desktop process. */
  active(): readonly Controller[] { return [...this.activeControllers] }

  /** @returns whether retry must finish a prior owner retirement before reconnecting. */
  retiring(window: Window): boolean { return this.retirements.has(window) }

  /**
   * Remove an owner from admission before closing it, so a replacement cannot be deleted by late settlement.
   * @param window - window whose unreachable owner is retired.
   */
  async retire(window: Window): Promise<void> {
    let retirement = this.retirements.get(window)
    if (retirement === undefined) {
      const client = this.clients.get(window)
      const controller = this.controllers.get(window)
      this.clients.delete(window)
      this.controllers.delete(window)
      this.origins.delete(window)
      if (controller === undefined) return
      retirement = { client, controller, flight: undefined }
      this.retirements.set(window, retirement)
    }
    if (retirement.flight !== undefined) return retirement.flight
    const current = retirement
    const flight = current.controller.close().then(
      () => {
        if (this.retirements.get(window) !== current) return
        this.retirements.delete(window)
        this.activeControllers.delete(current.controller)
      },
      (error: unknown) => {
        if (this.retirements.get(window) === current) current.flight = undefined
        throw error
      },
    )
    current.flight = flight
    return flight
  }
}
