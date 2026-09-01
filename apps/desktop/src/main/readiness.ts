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
  /** @param chunk - one complete JSONL record. @param callback - completion error observer. @returns the writer-specific result. */
  write(chunk: string, callback?: (error?: Error | null) => void): unknown
}

/** Writable acknowledgement output that can report an asynchronous pipe failure. */
interface EventedDesktopReadyOutput extends DesktopReadyOutput {
  /** @param event - output failure event. @param listener - one failure observer. @returns the writer-specific result. */
  on(event: 'error', listener: (error: Error) => void): unknown
  /** @param event - output failure event. @param listener - previously registered observer. @returns the writer-specific result. */
  removeListener(event: 'error', listener: (error: Error) => void): unknown
}

/** Exact acknowledgement emitted after authenticated Dashboard boot. */
export const desktopReadyAcknowledgement: DesktopReadyAcknowledgement = {
  kind: 'desktop-dashboard-ready',
  version: 1,
}

/**
 * Checks the exact public acknowledgement accepted after authenticated Dashboard boot.
 * @param value - untrusted candidate-process result.
 * @returns whether the result has only the established acknowledgement fields and values.
 */
export function isDesktopReadyAcknowledgement(value: unknown): value is DesktopReadyAcknowledgement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('version')) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const kind = descriptors.kind
  const version = descriptors.version
  return isAcknowledgementField(kind, desktopReadyAcknowledgement.kind)
    && isAcknowledgementField(version, desktopReadyAcknowledgement.version)
}

function isAcknowledgementField(descriptor: PropertyDescriptor | undefined, expected: unknown): boolean {
  return descriptor !== undefined
    && descriptor.enumerable === true
    && 'value' in descriptor
    && descriptor.value === expected
}

const READY_RECORD = `${JSON.stringify(desktopReadyAcknowledgement)}\n`
const READY_PROBE = `new Promise(resolve => {
  const ready = () => document.querySelector('[data-harness-dashboard-ready="true"]') !== null
  if (ready()) { resolve(true); return }
  const observer = new MutationObserver(() => {
    if (!ready()) return
    observer.disconnect()
    resolve(true)
  })
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true })
})`

/** Validates every Dashboard navigation and emits the constant process acknowledgement at most once. */
export class DesktopReadiness {
  private acknowledgement: AcknowledgementWrite | undefined

  /** @param output - process output receiving the constant JSONL record. */
  constructor(private readonly output: DesktopReadyOutput | null | undefined = process.stdout) {}

  /**
   * Wait for a clean exact-origin document with the authenticated-ready marker.
   * @param window - Main-owned Dashboard window.
   * @param expectedOrigin - exact Runtime Dashboard origin.
   * @param signal - optional startup cancellation or expiry signal.
   * @returns settlement after the marker is observed and the first acknowledgement is written.
   */
  wait(window: DashboardReadyWindow, expectedOrigin: string, signal?: AbortSignal): Promise<void> {
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
        const error = signal?.reason instanceof Error ? signal.reason : new Error('Desktop Dashboard startup was cancelled.')
        finish(error)
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
          async (ready) => {
            checking = false
            if (settled) return
            if (ready !== true) {
              finish(new Error('Desktop Dashboard did not report authenticated readiness.'))
              return
            }
            try {
              this.acknowledgement ??= createAcknowledgementWrite(this.output)
              await this.acknowledgement.promise
            } catch {
              finish(new Error('Desktop readiness acknowledgement could not be written.'))
              return
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

/** One shared acknowledgement write that can absorb the output error emitted after its callback. */
interface AcknowledgementWrite {
  /** Settlement after the acknowledgement is durably accepted or rejected. */
  readonly promise: Promise<void>
}

/** Start one acknowledgement write while converting a broken output pipe into the startup result. */
function createAcknowledgementWrite(output: DesktopReadyOutput | null | undefined): AcknowledgementWrite {
  if (output === undefined || output === null) return { promise: Promise.resolve() }
  if (!isEventedOutput(output)) {
    try {
      output.write(READY_RECORD)
      return { promise: Promise.resolve() }
    } catch (error) {
      const reason = error instanceof Error ? error : new Error('Desktop acknowledgement output failed.')
      return {
        promise: isBrokenAcknowledgementPipe(reason) ? Promise.resolve() : Promise.reject(reason),
      }
    }
  }
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false
    let error: Error | undefined
    let settlement: NodeJS.Immediate | undefined
    let cleanup: NodeJS.Immediate | undefined
    const remove = (): void => {
      if (cleanup !== undefined) clearImmediate(cleanup)
      output.removeListener('error', onError)
    }
    const removeAfterGrace = (): void => {
      if (cleanup !== undefined) return
      cleanup = setImmediate(() => {
        cleanup = setImmediate(remove)
      })
    }
    const settle = (): void => {
      if (settled) return
      settled = true
      if (error === undefined || isBrokenAcknowledgementPipe(error)) resolve()
      else reject(error)
      removeAfterGrace()
    }
    const schedule = (): void => {
      if (settlement !== undefined) return
      settlement = setImmediate(() => {
        settlement = undefined
        settle()
      })
    }
    const onError = (reason: Error): void => {
      error ??= reason
      schedule()
    }
    const finish = (reason?: Error | null): void => {
      if (reason !== undefined && reason !== null) error ??= reason
      schedule()
    }
    output.on('error', onError)
    try {
      output.write(READY_RECORD, finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Desktop acknowledgement output failed.'))
    }
  })
  return { promise }
}

function isEventedOutput(output: DesktopReadyOutput): output is EventedDesktopReadyOutput {
  return typeof (output as Partial<EventedDesktopReadyOutput>).on === 'function'
    && typeof (output as Partial<EventedDesktopReadyOutput>).removeListener === 'function'
}

/** @returns whether a detached Desktop has no acknowledgement consumer. */
function isBrokenAcknowledgementPipe(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPIPE'
}
