/** Main-owned active-work close decisions and tray actions. */

import type {
  ActiveWorkStatus,
  OwnUiWorkStopResult,
  RuntimeClient,
} from '@harness-desktop/dsh-host-local-runtime'
import type { DesktopCloseChoice } from '../shared/desktop-api.ts'

/** Exact active-work choices presented by every Desktop close prompt. */
export const desktopCloseChoices = [
  'minimize-to-tray',
  'safely-stop-own-ui-work',
  'cancel',
] as const satisfies readonly DesktopCloseChoice[]

/** Result of one Desktop close request. */
export type DesktopCloseResult =
  | { readonly kind: 'closed-without-client' }
  | { readonly kind: 'closed'; readonly status: ActiveWorkStatus; readonly stopResult?: OwnUiWorkStopResult }
  | { readonly kind: 'minimized'; readonly status: ActiveWorkStatus }
  | { readonly kind: 'cancelled'; readonly status: ActiveWorkStatus }
  | { readonly kind: 'stop-failed'; readonly status: ActiveWorkStatus; readonly stopResult: Extract<OwnUiWorkStopResult, { readonly kind: 'failed' }> }

/** Native and Runtime operations used by the close policy. */
export interface DesktopClosePolicyDependencies<Window extends object> {
  /** @returns the Foundation client attached to this window, when startup published one. */
  readonly client: (window: Window) => RuntimeClient | undefined
  /** @returns one of the exact active-work close choices. */
  readonly choose: (
    window: Window,
    status: ActiveWorkStatus,
    choices: typeof desktopCloseChoices,
  ) => Promise<DesktopCloseChoice>
  /** Keep the existing window and attachment alive behind a platform tray. */
  readonly minimizeToTray: (window: Window) => void
  /** Release only this Desktop window's attachment and Runtime client. */
  readonly closeOwnClient: (window: Window) => Promise<void>
  /** Complete the already-approved native window close. */
  readonly closeWindow: (window: Window) => void
  /** Present Foundation's exact redacted owner-scoped stop failure. */
  readonly reportStopFailure: (
    window: Window,
    result: Extract<OwnUiWorkStopResult, { readonly kind: 'failed' }>,
  ) => Promise<void>
}

/** Coordinates one close flight per Desktop window without acquiring Runtime-wide authority. */
export class DesktopClosePolicy<Window extends object> {
  private readonly flights = new WeakMap<Window, Promise<DesktopCloseResult>>()

  /** @param dependencies - Main-owned native operations and the window's Foundation client. */
  constructor(private readonly dependencies: DesktopClosePolicyDependencies<Window>) {}

  /**
   * Observe owner-scoped work before deciding whether to close, hide, stop, or cancel.
   * @param window - Desktop window receiving a native close request.
   * @returns the settled decision with Foundation status and stop results preserved by identity.
   */
  request(window: Window): Promise<DesktopCloseResult> {
    const current = this.flights.get(window)
    if (current !== undefined) return current
    const flight = this.decide(window).finally(() => {
      if (this.flights.get(window) === flight) this.flights.delete(window)
    })
    this.flights.set(window, flight)
    return flight
  }

  private async decide(window: Window): Promise<DesktopCloseResult> {
    const client = this.dependencies.client(window)
    if (client === undefined) {
      await this.close(window)
      return { kind: 'closed-without-client' }
    }
    const status = await client.observeActiveWork()
    if (status.ownUiWork.length === 0) {
      await this.close(window)
      return { kind: 'closed', status }
    }
    const choice = await this.dependencies.choose(window, status, desktopCloseChoices)
    switch (choice) {
      case 'minimize-to-tray':
        this.dependencies.minimizeToTray(window)
        return { kind: 'minimized', status }
      case 'cancel':
        return { kind: 'cancelled', status }
      case 'safely-stop-own-ui-work': {
        const stopResult = await client.stopOwnUiWork()
        if (stopResult.kind === 'failed') {
          await this.dependencies.reportStopFailure(window, stopResult)
          return { kind: 'stop-failed', status, stopResult }
        }
        await this.close(window)
        return { kind: 'closed', status, stopResult }
      }
      default:
        return assertNever(choice)
    }
  }

  private async close(window: Window): Promise<void> {
    await this.dependencies.closeOwnClient(window)
    this.dependencies.closeWindow(window)
  }
}

/** One visible native tray action. */
export interface DesktopTrayAction {
  /** Operating-system menu label. */
  readonly label: 'Restore' | 'Quit'
  /** Execute the native lifecycle action. */
  readonly click: () => Promise<void>
}

/** Platform adapter for one lazily created Desktop tray. */
export interface DesktopTrayDependencies<Window extends object, Tray> {
  /** Create the native tray with its complete visible menu. */
  readonly create: (actions: readonly DesktopTrayAction[]) => Tray
  /** Destroy the native tray during application shutdown. */
  readonly destroy: (tray: Tray) => void
  /** @returns whether the retained Desktop window has been destroyed. */
  readonly isDestroyed: (window: Window) => boolean
  /** Show and focus the retained Desktop window. */
  readonly restore: (window: Window) => void
  /** Request the same close decision used by the native window close event. */
  readonly requestClose: (window: Window) => Promise<DesktopCloseResult>
  /** Exit the Electron application after the close policy actually closed its window. */
  readonly quitApplication: () => void
  /** Present a redacted close failure without rejecting the native menu callback. */
  readonly reportCloseFailure: (window: Window, error: unknown) => Promise<void>
}

/** Lazily owns one platform tray for a hidden Desktop window. */
export class DesktopTrayLifecycle<Window extends object, Tray> {
  private tray: Tray | undefined
  private window: Window | undefined

  /** @param dependencies - platform tray and existing-window operations. */
  constructor(private readonly dependencies: DesktopTrayDependencies<Window, Tray>) {}

  /** Create the tray once and retain the current existing window for its actions. */
  ensure(window: Window): void {
    this.window = window
    if (this.tray !== undefined) return
    const restore = (): Promise<void> => {
      const current = this.window
      if (current === undefined || this.dependencies.isDestroyed(current)) return Promise.resolve()
      this.dependencies.restore(current)
      return Promise.resolve()
    }
    const quit = async (): Promise<void> => {
      const current = this.window
      if (current === undefined || this.dependencies.isDestroyed(current)) return
      try {
        const result = await this.dependencies.requestClose(current)
        switch (result.kind) {
          case 'closed':
          case 'closed-without-client':
            this.dependencies.quitApplication()
            return
          case 'minimized':
          case 'cancelled':
          case 'stop-failed':
            return
          default:
            assertNever(result)
        }
      } catch (error) {
        try {
          await this.dependencies.reportCloseFailure(current, error)
        } catch {
          // Native application teardown may make the already-redacted failure dialog unavailable.
        }
      }
    }
    this.tray = this.dependencies.create([
      { label: 'Restore', click: restore },
      { label: 'Quit', click: quit },
    ])
  }

  /** Destroy the tray exactly once during application shutdown. */
  dispose(): void {
    const tray = this.tray
    if (tray === undefined) return
    this.tray = undefined
    this.window = undefined
    this.dependencies.destroy(tray)
  }
}

function assertNever(_value: never): never {
  throw new Error('Desktop close policy received an unsupported discriminant.')
}
