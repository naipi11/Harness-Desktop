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
