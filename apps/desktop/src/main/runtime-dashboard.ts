/** Main-only ownership of Runtime Dashboard attachments and recovery results. */

import type { EventEmitter } from 'node:events'
import {
  normalizeRecoveryDiagnostic,
  type BrowserHandoffTransport,
  type DashboardAttachment,
  type RedactedRuntimeDiagnostic,
  type RuntimeClient,
} from '@harness-desktop/dsh-host-local-runtime'

/** Renderer-safe diagnostic accepted by the Desktop recovery surface. */
export type DesktopRecoveryDiagnostic = RedactedRuntimeDiagnostic

/** Main startup result without Runtime control data. */
export type DesktopStartupResult =
  | { readonly kind: 'dashboard-loaded' }
  | { readonly kind: 'recovery'; readonly diagnostic: DesktopRecoveryDiagnostic }

/** Window lifecycle used to release only its Dashboard attachment. */
export interface DesktopDashboardWindow extends Pick<EventEmitter, 'once'> {
  /** @returns whether Electron has already destroyed the native window. */
  isDestroyed?(): boolean
}

/** Owns one Desktop client's current Dashboard attachment and startup flight. */
export class RuntimeDashboardController {
  private attachment: DashboardAttachment | undefined
  private attachmentWindow: DesktopDashboardWindow | undefined
  private startupResult: DesktopStartupResult | undefined
  private startupFlight: Promise<DesktopStartupResult> | undefined
  private retryFlight: Promise<DesktopStartupResult> | undefined
  private closeFlight: Promise<void> | undefined
  private readonly attachmentCloses = new WeakMap<DashboardAttachment, Promise<void>>()
  private readonly closedWindows = new WeakSet<DesktopDashboardWindow>()
  private readonly observedWindows = new WeakSet<DesktopDashboardWindow>()

  /**
   * @param client - token-encapsulating Foundation Runtime client.
   * @param transport - Main-only browser bootstrap transport.
   */
  constructor(
    private readonly client: RuntimeClient,
    private readonly transport: BrowserHandoffTransport,
  ) {}

  /**
   * Attach and load the Dashboard, sharing concurrent initial callers.
   * @param window - Main-owned window associated with the attachment.
   * @returns a loaded result or normalized renderer-safe recovery diagnostic.
   */
  open(window: DesktopDashboardWindow): Promise<DesktopStartupResult> {
    this.observeWindow(window)
    if (this.closeFlight !== undefined || this.isWindowClosed(window)) return Promise.resolve(closedWindowResult())
    if (this.startupResult !== undefined) return Promise.resolve(this.startupResult)
    this.startupFlight ??= this.start(window)
      .then((result) => {
        this.startupResult = result
        return result
      })
      .finally(() => {
        this.startupFlight = undefined
      })
    return this.startupFlight
  }

  /**
   * Replace the current attachment only after an explicit recovery action.
   * @param window - Main-owned window that requested the retry.
   * @returns the fresh startup result.
   */
  retryAfterUserAction(window: DesktopDashboardWindow): Promise<DesktopStartupResult> {
    this.observeWindow(window)
    if (this.closeFlight !== undefined || this.isWindowClosed(window)) return Promise.resolve(closedWindowResult())
    this.retryFlight ??= this.retry(window).finally(() => {
      this.retryFlight = undefined
    })
    return this.retryFlight
  }

  /** Release attachments before the Runtime client, sharing in-flight calls and retrying rejected releases. */
  close(): Promise<void> {
    if (this.closeFlight === undefined) {
      const flight = this.closeOwnedResources()
      this.closeFlight = flight
      void flight.catch(() => {
        if (this.closeFlight === flight) this.closeFlight = undefined
      })
    }
    return this.closeFlight
  }

  private async start(window: DesktopDashboardWindow): Promise<DesktopStartupResult> {
    try {
      const attachment = await this.client.attachDashboard()
      this.attachment = attachment
      this.attachmentWindow = window
      if (this.isWindowClosed(window)) {
        await this.closeCurrentAttachment()
        return closedWindowResult()
      }
      const navigation = await attachment.createBrowserHandoff()
      if (this.isWindowClosed(window)) {
        await this.closeCurrentAttachment()
        return closedWindowResult()
      }
      await this.transport.open(navigation)
      if (this.isWindowClosed(window)) {
        await this.closeCurrentAttachment()
        return closedWindowResult()
      }
      return { kind: 'dashboard-loaded' }
    } catch (error) {
      return { kind: 'recovery', diagnostic: normalizeRecoveryDiagnostic(error) }
    }
  }

  private async retry(window: DesktopDashboardWindow): Promise<DesktopStartupResult> {
    try {
      await this.startupFlight
      await this.closeCurrentAttachment()
      if (this.isWindowClosed(window)) return closedWindowResult()
      this.startupResult = undefined
      return await this.open(window)
    } catch (error) {
      const result: DesktopStartupResult = {
        kind: 'recovery',
        diagnostic: normalizeRecoveryDiagnostic(error),
      }
      this.startupResult = result
      return result
    }
  }

  private observeWindow(window: DesktopDashboardWindow): void {
    if (this.observedWindows.has(window)) return
    this.observedWindows.add(window)
    window.once('closed', () => {
      this.closedWindows.add(window)
      void this.closeWindowAttachment(window).catch(() => {
        // Application shutdown still releases the base Runtime client after a failed child release.
      })
    })
  }

  private isWindowClosed(window: DesktopDashboardWindow): boolean {
    return this.closedWindows.has(window) || window.isDestroyed?.() === true
  }

  private async closeWindowAttachment(window: DesktopDashboardWindow): Promise<void> {
    await this.startupFlight
    if (this.attachmentWindow !== window) return
    await this.closeCurrentAttachment()
  }

  private async closeCurrentAttachment(): Promise<void> {
    const attachment = this.attachment
    if (attachment === undefined) return
    await this.closeAttachment(attachment)
    if (this.attachment !== attachment) return
    this.attachment = undefined
    this.attachmentWindow = undefined
  }

  private closeAttachment(attachment: DashboardAttachment): Promise<void> {
    const existing = this.attachmentCloses.get(attachment)
    if (existing !== undefined) return existing
    const closing = attachment.close()
    this.attachmentCloses.set(attachment, closing)
    void closing.catch(() => {
      if (this.attachmentCloses.get(attachment) === closing) this.attachmentCloses.delete(attachment)
    })
    return closing
  }

  private async closeOwnedResources(): Promise<void> {
    const failures: unknown[] = []
    await Promise.allSettled([this.startupFlight, this.retryFlight].filter(
      (flight): flight is Promise<DesktopStartupResult> => flight !== undefined,
    ))
    try {
      await this.closeCurrentAttachment()
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.client.close()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Desktop Runtime resources could not be closed.')
  }
}

function closedWindowResult(): DesktopStartupResult {
  return {
    kind: 'recovery',
    diagnostic: normalizeRecoveryDiagnostic(new Error('Desktop window is closed.')),
  }
}
