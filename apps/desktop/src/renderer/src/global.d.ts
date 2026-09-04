import type { DesktopBridge } from '../../shared/desktop-api.ts'

declare global {
  interface Window {
    harnessDesktop: DesktopBridge
  }
}

export {}
