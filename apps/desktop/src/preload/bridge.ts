import type { DesktopBridge, DesktopInvoke } from '../shared/desktop-api.ts'
import {
  desktopChannels,
  isAllowedDesktopExternalLink,
  isDesktopNotification,
} from '../shared/desktop-api.ts'

/** Creates the renderer's only main-process bridge. */
export function createDesktopBridge(invoke: DesktopInvoke): DesktopBridge {
  return {
    version: 1,
    readRecoveryDiagnostic: (...args: readonly unknown[]) => args.length === 0
      ? invoke(desktopChannels.readRecoveryDiagnostic)
      : reject('desktop:invalid-invocation'),
    retryDashboard: (...args: readonly unknown[]) => args.length === 0
      ? invoke(desktopChannels.retryDashboard)
      : reject('desktop:invalid-invocation'),
    copyRecoveryDiagnostic: (...args: readonly unknown[]) => args.length === 0
      ? invoke(desktopChannels.copyRecoveryDiagnostic)
      : reject('desktop:invalid-invocation'),
    selectFolder: (...args: readonly unknown[]) => args.length === 0
      ? invoke(desktopChannels.selectFolder)
      : reject('desktop:invalid-invocation'),
    showNotification: (...args: readonly unknown[]) => {
      if (args.length !== 1) return reject('desktop:invalid-invocation')
      const notification = args[0]
      return isDesktopNotification(notification)
        ? invoke(desktopChannels.showNotification, notification)
        : reject('desktop:invalid-notification')
    },
    openExternalLink: (...args: readonly unknown[]) => {
      if (args.length !== 1) return reject('desktop:invalid-invocation')
      const url = args[0]
      return isAllowedDesktopExternalLink(url)
        ? invoke(desktopChannels.openExternalLink, url)
        : reject('desktop:external-link-denied')
    },
  }
}

function reject(code: string): Promise<never> {
  return Promise.reject(new Error(code))
}
