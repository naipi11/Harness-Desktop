/** One Main-process admission gate for a native update or rollback transition. */

/** Serializes native transition handoff so shutdown can await the worker-readiness flight. */
export class NativeTransitionGate {
  private flight: Promise<void> | undefined

  /** @returns the registered worker-readiness flight, if a native transition has been admitted. */
  get pending(): Promise<void> | undefined { return this.flight }

  /**
   * Reserve native transition ownership before the supplied asynchronous worker launch begins.
   * @param launch - local worker launch that must settle before Main can exit for a native transition.
   * @returns the single admitted readiness flight.
   */
  start(launch: () => Promise<void>): Promise<void> {
    if (this.flight !== undefined) throw new Error('a native Desktop transition is already requested')
    const flight = Promise.resolve().then(launch)
    this.flight = flight
    void flight.catch(() => {
      if (this.flight === flight) this.flight = undefined
    })
    return flight
  }
}

/** Owns every automatic-update task admitted by Main until shutdown settles it. */
export class DesktopUpdateFlightGate {
  private readonly controller = new AbortController()
  private readonly flights = new Set<Promise<void>>()
  private closed = false

  /**
   * Admit one update operation before its first asynchronous action.
   * @param operation - complete check, download, stage, installation handoff, and outcome-persistence flight.
   * @returns the admitted operation result.
   */
  start(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('Desktop update admission is closed')
    const flight = Promise.resolve().then(async () => { await operation(this.controller.signal) })
    this.flights.add(flight)
    void flight.finally(() => { this.flights.delete(flight) }).catch(() => {
      // The caller observes the original failure; this branch only contains finally's mirror rejection.
    })
    return flight
  }

  /** Stop network work, reject new admission, and wait until all admitted transactions reach a safe local settlement. */
  async close(): Promise<void> {
    this.closed = true
    this.controller.abort()
    await Promise.allSettled([...this.flights])
  }
}
