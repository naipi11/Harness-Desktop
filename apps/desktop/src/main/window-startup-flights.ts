/** Serializes one startup operation per Desktop window and exposes every flight to shutdown. */
export class WindowStartupFlights<Window extends object, Result> {
  private readonly flights = new WeakMap<Window, Promise<Result>>()
  private closed = false
  private closeFlight: Promise<void> | undefined

  /**
   * @param activeTasks - Process-wide task set awaited before Runtime shutdown.
   * @param start - Startup operation that creates or attaches one window controller.
   */
  constructor(
    private readonly activeTasks: Set<Promise<unknown>>,
    private readonly start: (window: Window) => Promise<Result>,
  ) {}

  /**
   * Shares one in-flight startup for a window and removes it after settlement.
   * @param window - Main-owned Desktop window.
   * @returns the existing or newly started operation.
   */
  run(window: Window): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Desktop window startup is closed.'))
    const existing = this.flights.get(window)
    if (existing !== undefined) return existing
    const flight = Promise.resolve().then(() => this.start(window))
    this.flights.set(window, flight)
    this.activeTasks.add(flight)
    const settle = (): void => {
      if (this.flights.get(window) === flight) this.flights.delete(window)
      this.activeTasks.delete(flight)
    }
    void flight.then(settle, settle)
    return flight
  }

  /** Closes startup admission before waiting for every currently tracked operation. */
  close(): Promise<void> {
    this.closed = true
    this.closeFlight ??= Promise.allSettled([...this.activeTasks]).then(() => {})
    return this.closeFlight
  }
}
