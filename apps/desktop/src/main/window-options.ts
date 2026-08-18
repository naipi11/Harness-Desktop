import { productMetadata } from '@harness-desktop/dsh-app-boot/product-metadata'
import type { BrowserWindowConstructorOptions } from 'electron'

/** Creates the fixed BrowserWindow configuration for the Desktop renderer. */
export function createWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: productMetadata.productName,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
}
