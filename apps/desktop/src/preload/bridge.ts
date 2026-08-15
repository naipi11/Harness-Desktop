import type { DesktopBridge, DesktopInvoke } from '../shared/desktop-api.ts'
import { desktopChannels } from '../shared/desktop-api.ts'

/** Creates the renderer's only main-process bridge. */
export function createDesktopBridge(invoke: DesktopInvoke): DesktopBridge {
  return {
    getProductMetadata: () => invoke(desktopChannels.productMetadata),
  }
}
