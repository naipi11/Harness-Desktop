/** Main-owned close decisions and tray lifecycle. */

import { describe, expect, it, vi } from 'vitest'
import {
  normalizeRecoveryDiagnostic,
  type ActiveWorkStatus,
  type OwnUiWorkStopResult,
  type RuntimeClient,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  DesktopClosePolicy,
  DesktopTrayLifecycle,
  desktopCloseChoices,
  type DesktopCloseResult,
  type DesktopClosePolicyDependencies,
  type DesktopTrayAction,
} from '../src/main/close-policy.ts'
import { WindowRuntimeOwners } from '../src/main/window-options.ts'

interface FakeWindow {
  destroyed: boolean
  hidden: boolean
  focused: boolean
}

const activeStatus = {
  ownUiWork: ['desktop-owned-work'],
} as unknown as ActiveWorkStatus

function runtimeClient(overrides: Partial<RuntimeClient>): RuntimeClient {
  const forbidden = (): never => { throw new Error('unrelated Runtime operation invoked') }
  return {
    openTerminal: forbidden,
    attachDashboard: forbidden,
    acquireBackgroundLease: forbidden,
    status: forbidden,
    releaseBackgroundLease: forbidden,
    getLegacyMigration: forbidden,
    acceptLegacyMigration: forbidden,
    declineLegacyMigration: forbidden,
    retryLegacyMigration: forbidden,
    observeActiveWork: forbidden,
    stopOwnUiWork: forbidden,
    close: forbidden,
    ...overrides,
  }
}

function setupPolicy(options: {
  readonly status: ActiveWorkStatus
  readonly choice?: (typeof desktopCloseChoices)[number]
  readonly stopResult?: OwnUiWorkStopResult | Promise<OwnUiWorkStopResult>
}): {
  readonly policy: DesktopClosePolicy<FakeWindow>
  readonly window: FakeWindow
  readonly client: RuntimeClient
  readonly events: string[]
  readonly choose: ReturnType<typeof vi.fn>
  readonly reportStopFailure: ReturnType<typeof vi.fn>
} {
  const events: string[] = []
  const window: FakeWindow = { destroyed: false, hidden: false, focused: false }
  const observeActiveWork = vi.fn(async () => {
    events.push('observe')
    return options.status
  })
  const stopOwnUiWork = vi.fn(async () => {
    events.push('stop-own-ui-work')
    const defaultResult: OwnUiWorkStopResult = { kind: 'none-active' }
    return await (options.stopResult ?? defaultResult)
  })
  const client = runtimeClient({ observeActiveWork, stopOwnUiWork })
  const choose = vi.fn(async (
    _window: FakeWindow,
    _status: ActiveWorkStatus,
    _choices: typeof desktopCloseChoices,
  ) => {
    events.push('choose')
    return options.choice ?? 'cancel'
  })
  const reportStopFailure = vi.fn(async () => { events.push('report-stop-failure') })
  const dependencies: DesktopClosePolicyDependencies<FakeWindow> = {
    client: candidate => candidate === window ? client : undefined,
    choose,
    minimizeToTray: (candidate) => {
      events.push('minimize-to-tray')
      candidate.hidden = true
    },
    closeOwnClient: async (candidate) => {
      expect(candidate).toBe(window)
      events.push('close-own-client')
    },
    closeWindow: (candidate) => {
      events.push('close-window')
      candidate.destroyed = true
    },
    reportStopFailure,
  }
  return {
    policy: new DesktopClosePolicy(dependencies),
    window,
    client,
    events,
    choose,
    reportStopFailure,
  }
}

describe('DesktopClosePolicy', () => {
  it('observes active work first and minimizes with all three literal choices unchanged', async () => {
    const fixture = setupPolicy({ status: activeStatus, choice: 'minimize-to-tray' })

    const result = await fixture.policy.request(fixture.window)

    expect(result).toEqual({ kind: 'minimized', status: activeStatus })
    if (result.kind !== 'minimized') throw new Error('expected a minimized result')
    expect(result.status).toBe(activeStatus)
    expect(fixture.choose).toHaveBeenCalledWith(
      fixture.window,
      activeStatus,
      ['minimize-to-tray', 'safely-stop-own-ui-work', 'cancel'],
    )
    expect(fixture.events).toEqual(['observe', 'choose', 'minimize-to-tray'])
    expect(fixture.window).toEqual({ destroyed: false, hidden: true, focused: false })
  })

  it('waits for the exact safe-stop result before closing only this Desktop owner', async () => {
    const stop = deferred<OwnUiWorkStopResult>()
    const stopResult = {
      kind: 'stopped',
      work: activeStatus.ownUiWork,
    } satisfies OwnUiWorkStopResult
    const fixture = setupPolicy({
      status: activeStatus,
      choice: 'safely-stop-own-ui-work',
      stopResult: stop.promise,
    })

    const decision = fixture.policy.request(fixture.window)
    await vi.waitFor(() => { expect(fixture.events).toEqual(['observe', 'choose', 'stop-own-ui-work']) })
    expect(fixture.window.destroyed).toBe(false)

    stop.resolve(stopResult)
    const result = await decision

    expect(result).toEqual({ kind: 'closed', status: activeStatus, stopResult })
    if (result.kind !== 'closed') throw new Error('expected a closed result')
    expect(result.status).toBe(activeStatus)
    expect(result.stopResult).toBe(stopResult)
    expect(fixture.events).toEqual([
      'observe',
      'choose',
      'stop-own-ui-work',
      'close-own-client',
      'close-window',
    ])
    expect(fixture.window.destroyed).toBe(true)
  })

  it('keeps the owner open and reports the exact redacted safe-stop failure', async () => {
    const stopResult = {
      kind: 'failed',
      diagnostic: normalizeRecoveryDiagnostic(new Error('safe stop failed')),
    } satisfies OwnUiWorkStopResult
    const fixture = setupPolicy({
      status: activeStatus,
      choice: 'safely-stop-own-ui-work',
      stopResult,
    })

    const result = await fixture.policy.request(fixture.window)

    expect(result).toEqual({ kind: 'stop-failed', status: activeStatus, stopResult })
    if (result.kind !== 'stop-failed') throw new Error('expected a stop-failed result')
    expect(result.stopResult).toBe(stopResult)
    expect(fixture.reportStopFailure).toHaveBeenCalledWith(fixture.window, stopResult)
    expect(fixture.events).toEqual([
      'observe',
      'choose',
      'stop-own-ui-work',
      'report-stop-failure',
    ])
    expect(fixture.window.destroyed).toBe(false)
  })

  it('leaves the window and active work untouched when closing is cancelled', async () => {
    const fixture = setupPolicy({ status: activeStatus, choice: 'cancel' })

    const result = await fixture.policy.request(fixture.window)

    expect(result).toEqual({ kind: 'cancelled', status: activeStatus })
    expect(fixture.events).toEqual(['observe', 'choose'])
    expect(fixture.window).toEqual({ destroyed: false, hidden: false, focused: false })
  })

  it('releases the Desktop attachment and client normally when no UI work is active', async () => {
    const idleStatus = { ownUiWork: [] } satisfies ActiveWorkStatus
    const fixture = setupPolicy({ status: idleStatus })

    const result = await fixture.policy.request(fixture.window)

    expect(result).toEqual({ kind: 'closed', status: idleStatus })
    if (result.kind !== 'closed') throw new Error('expected a closed result')
    expect(result.status).toBe(idleStatus)
    expect(fixture.choose).not.toHaveBeenCalled()
    expect(fixture.events).toEqual(['observe', 'close-own-client', 'close-window'])
  })

  it('observes fresh active work before retrying a rejected owner retirement', async () => {
    const window: FakeWindow = { destroyed: false, hidden: false, focused: false }
    const idleStatus = { ownUiWork: [] } satisfies ActiveWorkStatus
    const observeActiveWork = vi.fn()
      .mockResolvedValueOnce(idleStatus)
      .mockResolvedValueOnce(activeStatus)
    const client = runtimeClient({ observeActiveWork })
    const retirementFailure = new Error('client release failed')
    const controller = {
      close: vi.fn()
        .mockRejectedValueOnce(retirementFailure)
        .mockResolvedValueOnce(undefined),
    }
    const owners = new WindowRuntimeOwners<FakeWindow, RuntimeClient, typeof controller>()
    owners.publish(window, client, controller, 'http://127.0.0.1:43123')
    const closeWindow = vi.fn()
    const choose = vi.fn(async () => 'cancel' as const)
    const policy = new DesktopClosePolicy<FakeWindow>({
      client: candidate => owners.client(candidate),
      choose,
      minimizeToTray: () => {},
      closeOwnClient: candidate => owners.retire(candidate),
      closeWindow,
      reportStopFailure: async () => {},
    })

    await expect(policy.request(window)).rejects.toBe(retirementFailure)
    expect(owners.client(window)).toBe(client)
    await expect(policy.request(window)).resolves.toEqual({ kind: 'cancelled', status: activeStatus })
    expect(observeActiveWork).toHaveBeenCalledTimes(2)
    expect(choose).toHaveBeenCalledWith(window, activeStatus, desktopCloseChoices)
    expect(controller.close).toHaveBeenCalledOnce()
    expect(closeWindow).not.toHaveBeenCalled()
  })
})

describe('DesktopTrayLifecycle', () => {
  it('creates one tray with visible Restore and Quit actions for the existing window', async () => {
    const window: FakeWindow = { destroyed: false, hidden: true, focused: false }
    const createdActions: DesktopTrayAction[][] = []
    const closeRequests: FakeWindow[] = []
    const quitApplication = vi.fn()
    const reportCloseFailure = vi.fn(async () => {})
    let destroys = 0
    const tray = new DesktopTrayLifecycle<FakeWindow, object>({
      create: (actions) => {
        createdActions.push([...actions])
        return {}
      },
      destroy: () => { destroys += 1 },
      isDestroyed: candidate => candidate.destroyed,
      restore: (candidate) => {
        candidate.hidden = false
        candidate.focused = true
      },
      requestClose: async (candidate) => {
        closeRequests.push(candidate)
        return { kind: 'cancelled', status: activeStatus }
      },
      quitApplication,
      reportCloseFailure,
    })

    tray.ensure(window)
    tray.ensure(window)

    expect(createdActions).toHaveLength(1)
    expect(createdActions[0]!.map(action => action.label)).toEqual(['Restore', 'Quit'])
    await createdActions[0]![0]!.click()
    expect(window).toEqual({ destroyed: false, hidden: false, focused: true })
    await createdActions[0]![1]!.click()
    expect(closeRequests).toEqual([window])
    expect(quitApplication).not.toHaveBeenCalled()
    expect(reportCloseFailure).not.toHaveBeenCalled()
    expect(destroys).toBe(0)

    tray.dispose()
    expect(destroys).toBe(1)
  })

  it.each([
    ['closed', { kind: 'closed', status: activeStatus } satisfies DesktopCloseResult, 1],
    ['closed without a client', { kind: 'closed-without-client' } satisfies DesktopCloseResult, 1],
    ['minimized again', { kind: 'minimized', status: activeStatus } satisfies DesktopCloseResult, 0],
    ['cancelled', { kind: 'cancelled', status: activeStatus } satisfies DesktopCloseResult, 0],
  ] as const)('quits only after the same close request is %s', async (_label, result, quitCalls) => {
    const window: FakeWindow = { destroyed: false, hidden: true, focused: false }
    let actions: readonly DesktopTrayAction[] = []
    const quitApplication = vi.fn()
    const tray = new DesktopTrayLifecycle<FakeWindow, object>({
      create: (created) => { actions = created; return {} },
      destroy: () => {},
      isDestroyed: candidate => candidate.destroyed,
      restore: () => {},
      requestClose: async () => result,
      quitApplication,
      reportCloseFailure: async () => {},
    })
    tray.ensure(window)

    await actions[1]!.click()

    expect(quitApplication).toHaveBeenCalledTimes(quitCalls)
  })

  it('reports a rejected Quit close request without rejecting the native menu callback', async () => {
    const window: FakeWindow = { destroyed: false, hidden: true, focused: false }
    const failure = new Error('close observation failed')
    let actions: readonly DesktopTrayAction[] = []
    const reportCloseFailure = vi.fn(async () => {})
    const quitApplication = vi.fn()
    const tray = new DesktopTrayLifecycle<FakeWindow, object>({
      create: (created) => { actions = created; return {} },
      destroy: () => {},
      isDestroyed: candidate => candidate.destroyed,
      restore: () => {},
      requestClose: async () => { throw failure },
      quitApplication,
      reportCloseFailure,
    })
    tray.ensure(window)

    await expect(actions[1]!.click()).resolves.toBeUndefined()
    expect(reportCloseFailure).toHaveBeenCalledWith(window, failure)
    expect(quitApplication).not.toHaveBeenCalled()
  })
})

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
