/** Main-owned Runtime Dashboard attachment and teardown behavior. */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeUnavailableError,
  normalizeRecoveryDiagnostic,
  type BrowserHandoffTransport,
  type DashboardAttachment,
  type DashboardNavigation,
  type RuntimeClient,
} from '@harness-desktop/dsh-host-local-runtime'
import {
  RuntimeDashboardController,
  type DesktopDashboardWindow,
} from '../src/main/runtime-dashboard.ts'

const navigation: DashboardNavigation = {
  origin: 'http://127.0.0.1:43123' as DashboardNavigation['origin'],
  handoff: {
    id: 'desktop_handoff_value_12345678901234567890' as DashboardNavigation['handoff']['id'],
    expiresAt: 61_000,
  },
}

class FakeWindow extends EventEmitter implements DesktopDashboardWindow {
  closed = false

  isDestroyed(): boolean { return this.closed }

  async closeWindow(): Promise<void> {
    this.closed = true
    const listeners = this.listeners('closed') as Array<() => void | Promise<void>>
    this.removeAllListeners('closed')
    await Promise.all(listeners.map(listener => Promise.resolve(listener())))
  }
}

function runtimeClient(overrides: Partial<RuntimeClient>): RuntimeClient {
  const forbidden = (): never => { throw new Error('unrelated Runtime control invoked') }
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
    getDesktopUpdateChannel: forbidden,
    setDesktopUpdateChannel: forbidden,
    recordDesktopUpdateOutcome: forbidden,
    observeActiveWork: forbidden,
    stopOwnUiWork: forbidden,
    close: forbidden,
    ...overrides,
  }
}

function attachment(
  close: () => Promise<void> = async () => {},
  createBrowserHandoff: () => Promise<DashboardNavigation> = async () => navigation,
): DashboardAttachment {
  return { createBrowserHandoff, close }
}

describe('RuntimeDashboardController', () => {
  it('normalizes an attachment failure without attempting browser navigation', async () => {
    const failure = new RuntimeUnavailableError()
    const open = vi.fn()
    const transport: BrowserHandoffTransport = { open }
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard: async () => { throw failure },
      close: async () => {},
    }), transport)

    await expect(controller.open(new FakeWindow())).resolves.toEqual({
      kind: 'recovery',
      diagnostic: normalizeRecoveryDiagnostic(failure),
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('shares concurrent startup and forwards the unchanged navigation once', async () => {
    let releaseAttach!: (value: DashboardAttachment) => void
    const pendingAttach = new Promise<DashboardAttachment>((resolve) => { releaseAttach = resolve })
    const createBrowserHandoff = vi.fn(async () => navigation)
    const attachDashboard = vi.fn(async () => pendingAttach)
    const open = vi.fn(async () => {})
    const transport: BrowserHandoffTransport = { open }
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard,
      close: async () => {},
    }), transport)
    const window = new FakeWindow()

    const first = controller.open(window)
    const second = controller.open(window)
    releaseAttach(attachment(async () => {}, createBrowserHandoff))

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'dashboard-loaded' },
      { kind: 'dashboard-loaded' },
    ])
    expect(attachDashboard).toHaveBeenCalledTimes(1)
    expect(createBrowserHandoff).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(navigation)
  })

  it('retries only after explicit user action and replaces the failed attachment', async () => {
    const firstFailure = new Error('bootstrap contained secret details')
    const firstClose = vi.fn(async () => {})
    const secondClose = vi.fn(async () => {})
    const attachments = [attachment(firstClose), attachment(secondClose)]
    const attachDashboard = vi.fn(async () => attachments.shift()!)
    const open = vi.fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(undefined)
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard,
      close: async () => {},
    }), { open })
    const window = new FakeWindow()

    const recovery = await controller.open(window)
    expect(recovery).toMatchObject({
      kind: 'recovery',
      diagnostic: {
        code: 'runtime-start-failed',
        subject: 'Runtime',
        message: 'The local Harness Runtime operation failed.',
        correction: 'Retry the operation, then use the diagnostic identifier if the failure continues.',
      },
    })
    await expect(controller.open(window)).resolves.toBe(recovery)
    await Promise.resolve()
    expect(attachDashboard).toHaveBeenCalledTimes(1)
    expect(firstClose).not.toHaveBeenCalled()

    await expect(controller.retryAfterUserAction(window)).resolves.toEqual({ kind: 'dashboard-loaded' })
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(secondClose).not.toHaveBeenCalled()
    expect(attachDashboard).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('normalizes a retry failure without reflecting its raw details', async () => {
    const retryFailure = new Error('http://127.0.0.1:43123/?handoff=secret')
    const firstClose = vi.fn(async () => {})
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard: vi.fn()
        .mockResolvedValueOnce(attachment(firstClose))
        .mockRejectedValueOnce(retryFailure),
      close: async () => {},
    }), { open: vi.fn(async () => {}) })
    const window = new FakeWindow()

    await controller.open(window)
    const result = await controller.retryAfterUserAction(window)

    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      kind: 'recovery',
      diagnostic: {
        code: 'runtime-start-failed',
        subject: 'Runtime',
        message: 'The local Harness Runtime operation failed.',
        correction: 'Retry the operation, then use the diagnostic identifier if the failure continues.',
      },
    })
    expect(JSON.stringify(result)).not.toContain('43123')
    expect(JSON.stringify(result)).not.toContain('handoff')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('does not publish a replacement attachment after the window closes during retry', async () => {
    let releaseClose!: () => void
    const firstClose = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve }))
    const secondClose = vi.fn(async () => {})
    const attachments = [attachment(firstClose), attachment(secondClose)]
    const attachDashboard = vi.fn(async () => attachments.shift()!)
    const open = vi.fn(async () => {})
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard,
      close: async () => {},
    }), { open })
    const window = new FakeWindow()

    await controller.open(window)
    await window.closeWindow()
    const retry = controller.retryAfterUserAction(window)
    releaseClose()

    await expect(retry).resolves.toMatchObject({ kind: 'recovery' })
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(secondClose).not.toHaveBeenCalled()
    expect(attachDashboard).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('closes an attachment published after its window closes without navigating', async () => {
    let releaseAttach!: (value: DashboardAttachment) => void
    const pendingAttach = new Promise<DashboardAttachment>((resolve) => { releaseAttach = resolve })
    const closeAttachment = vi.fn(async () => {})
    const attachDashboard = vi.fn(async () => pendingAttach)
    const open = vi.fn(async () => {})
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard,
      close: async () => {},
    }), { open })
    const window = new FakeWindow()

    const startup = controller.open(window)
    await vi.waitFor(() => { expect(attachDashboard).toHaveBeenCalledOnce() })
    await window.closeWindow()
    releaseAttach(attachment(closeAttachment))

    await expect(startup).resolves.toMatchObject({ kind: 'recovery' })
    expect(closeAttachment).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it('closes the window attachment before the Runtime client during shutdown', async () => {
    const order: string[] = []
    const closeAttachment = vi.fn(async () => { order.push('attachment') })
    const closeClient = vi.fn(async () => { order.push('client') })
    const client = runtimeClient({
      attachDashboard: async () => attachment(closeAttachment),
      close: closeClient,
    })
    const controller = new RuntimeDashboardController(client, { open: async () => {} })
    const window = new FakeWindow()

    await controller.open(window)
    await window.closeWindow()
    await vi.waitFor(() => { expect(closeAttachment).toHaveBeenCalledTimes(1) })
    expect(closeClient).not.toHaveBeenCalled()

    await controller.close()
    await controller.close()
    expect(order).toEqual(['attachment', 'client'])
    expect(closeClient).toHaveBeenCalledTimes(1)
  })

  it('retries a rejected attachment release on the next controller close', async () => {
    const failure = new Error('attachment release failed')
    const closeAttachment = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
    const closeClient = vi.fn(async () => {})
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard: async () => attachment(closeAttachment),
      close: closeClient,
    }), { open: async () => {} })
    await controller.open(new FakeWindow())

    await expect(controller.close()).rejects.toThrow('Desktop Runtime resources could not be closed.')
    expect(closeClient).not.toHaveBeenCalled()
    await expect(controller.close()).resolves.toBeUndefined()
    expect(closeAttachment).toHaveBeenCalledTimes(2)
    expect(closeClient).toHaveBeenCalledOnce()
  })

  it('retries a rejected Runtime client release on the next controller close', async () => {
    const failure = new Error('client release failed')
    const closeAttachment = vi.fn(async () => {})
    const closeClient = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
    const controller = new RuntimeDashboardController(runtimeClient({
      attachDashboard: async () => attachment(closeAttachment),
      close: closeClient,
    }), { open: async () => {} })
    await controller.open(new FakeWindow())

    await expect(controller.close()).rejects.toThrow('Desktop Runtime resources could not be closed.')
    await expect(controller.close()).resolves.toBeUndefined()
    expect(closeAttachment).toHaveBeenCalledOnce()
    expect(closeClient).toHaveBeenCalledTimes(2)
  })
})
