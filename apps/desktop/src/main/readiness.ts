/** Authenticated Dashboard readiness and process-level acknowledgement. */

import type { EventEmitter } from 'node:events'

/** Process-observable confirmation that the authenticated Dashboard is ready. */
export interface DesktopReadyAcknowledgement {
  readonly kind: 'desktop-dashboard-ready'
  readonly version: 1
}

/** Minimal Electron WebContents operations required to observe Dashboard readiness. */
export interface DashboardReadyWebContents extends Pick<EventEmitter, 'on' | 'removeListener'> {
  /** @returns the currently committed top-level URL. */
  getURL(): string
  /** @param script - constant, secret-free readiness probe. @returns the probe value. */
  executeJavaScript(script: string): Promise<unknown>
}

/** Browser window surface required by the readiness observer. */
export interface DashboardReadyWindow {
  readonly webContents: DashboardReadyWebContents
}

/** Writable process output used for the one acknowledgement record. */
export interface DesktopReadyOutput {
  /** @param chunk - one complete JSONL record. @returns the writer-specific result. */
  write(chunk: string): unknown
}

/** Exact acknowledgement emitted after authenticated Dashboard boot. */
export const desktopReadyAcknowledgement: DesktopReadyAcknowledgement = {
  kind: 'desktop-dashboard-ready',
  version: 1,
}

const READY_RECORD = `${JSON.stringify(desktopReadyAcknowledgement)}\n`
const READY_PROBE = 'document.querySelector(\'[data-harness-dashboard-ready="true"]\') !== null'

/** Emits the constant process acknowledgement at most once. */
export class DesktopReadiness {
  private acknowledged = false

  /** @param output - process output receiving the constant JSONL record. */
  constructor(private readonly output: DesktopReadyOutput = process.stdout) {}

  /**
   * Wait for a clean exact-origin document with the authenticated-ready marker.
   * @param window - Main-owned Dashboard window.
   * @param expectedOrigin - exact Runtime Dashboard origin.
   * @param signal - optional startup cancellation or expiry signal.
   * @returns settlement after the marker is observed and acknowledgement written.
   */
  wait(window: DashboardReadyWindow, expectedOrigin: string, signal?: AbortSignal): Promise<void> {
    if (this.acknowledged) return Promise.resolve()
    const expectedUrl = `${expectedOrigin}/`
    return new Promise((resolve, reject) => {
      let settled = false
      let checking = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        window.webContents.removeListener('did-finish-load', onFinishLoad)
        window.webContents.removeListener('did-fail-load', onFailLoad)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onAbort = (): void => {
        finish(signal?.reason instanceof Error ? signal.reason : new Error('Desktop Dashboard startup was cancelled.'))
      }
      const onFailLoad = (...args: unknown[]): void => {
        if (args[4] === false) return
        finish(new Error('Desktop Dashboard navigation failed.'))
      }
      const onFinishLoad = (): void => {
        if (checking || settled) return
        const currentUrl = window.webContents.getURL()
        if (currentUrl.startsWith('file:')) return
        if (currentUrl !== expectedUrl) {
          finish(new Error('Desktop opened an unexpected Dashboard navigation.'))
          return
        }
        checking = true
        void window.webContents.executeJavaScript(READY_PROBE).then(
          (ready) => {
            checking = false
            if (ready !== true) {
              finish(new Error('Desktop Dashboard did not report authenticated readiness.'))
              return
            }
            if (!this.acknowledged) {
              try {
                this.output.write(READY_RECORD)
                this.acknowledged = true
              } catch {
                finish(new Error('Desktop readiness acknowledgement could not be written.'))
                return
              }
            }
            finish()
          },
          () => {
            checking = false
            finish(new Error('Desktop Dashboard readiness could not be verified.'))
          },
        )
      }

      window.webContents.on('did-finish-load', onFinishLoad)
      window.webContents.on('did-fail-load', onFailLoad)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
  }
}
