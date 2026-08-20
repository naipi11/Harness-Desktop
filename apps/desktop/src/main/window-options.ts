import { fileURLToPath } from 'node:url'
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
