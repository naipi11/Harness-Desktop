/** One cancellable idle timer for the Runtime owner. */

/** Scheduler dependencies kept injectable for deterministic lifecycle tests. */
export interface IdleLifecycleOptions {
  /** Positive or zero wait before an idle Runtime stops. */
  readonly timeoutMs: number
  /** Schedule the one pending idle callback. */
  readonly schedule: (callback: () => Promise<void>, timeoutMs: number) => ReturnType<typeof setTimeout>
  /** Cancel one scheduled idle callback. */
  readonly cancel: (handle: ReturnType<typeof setTimeout>) => void
  /** Stop the Runtime after the timeout still observes an idle owner. */
  readonly onIdle: () => Promise<void>
}

/** Coordinates one idle timeout without allowing duplicate stop requests. */
export class IdleLifecycle {
  private handle: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: IdleLifecycleOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
      throw new Error('host-local-runtime: idleTimeoutMs must be a non-negative safe integer')
    }
  }

  /**
   * Start the idle timeout only while the Runtime has no retained owner.
   * @param idle - whether attachments, work, and background leases are all absent.
   */
  reconcile(idle: boolean): void {
    if (!idle) {
      this.cancel()
      return
    }
    if (this.handle !== undefined) return
    this.handle = this.options.schedule(async () => {
      this.handle = undefined
      await this.options.onIdle()
    }, this.options.timeoutMs)
  }

  /** Cancel a pending idle timeout during new activity or explicit disposal. */
  cancel(): void {
    if (this.handle === undefined) return
    this.options.cancel(this.handle)
    this.handle = undefined
  }
}
