import { describe, expect, it, vi } from 'vitest'
import {
  registerDesktopIpc,
  type DesktopIpcDependencies,
  type DesktopIpcEvent,
  type DesktopIpcHandler,
} from '../src/main/desktop-ipc.ts'
import { WindowStartupFlights } from '../src/main/window-startup-flights.ts'
import {
  desktopChannels,
  type DesktopRecoveryDiagnostic,
  type DesktopStartupResult,
} from '../src/shared/desktop-api.ts'

interface FakeWindow {
  readonly id: string
  destroyed: boolean
}

const window: FakeWindow = { id: 'main', destroyed: false }
const otherWindow: FakeWindow = { id: 'other', destroyed: false }
const event: DesktopIpcEvent = { sender: 'renderer' }
const diagnostic: DesktopRecoveryDiagnostic = {
  code: 'runtime-unavailable',
  subject: 'Runtime',
  message: 'The local Harness Runtime is unavailable.',
  correction: 'Retry the operation.',
  diagnosticId: 'desktop-ipc-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
}

function createHarness(overrides: Partial<DesktopIpcDependencies<FakeWindow>> = {}) {
  const handlers = new Map<string, DesktopIpcHandler>()
  const copyText = vi.fn(async () => {})
  const selectFolder = vi.fn(async () => ({ canceled: false, filePaths: ['C:\\projects\\harness'] }))
  const showNotification = vi.fn()
  const openExternalLink = vi.fn(async () => {})
  const dependencies: DesktopIpcDependencies<FakeWindow> = {
    windowFromEvent: () => window,
    isWindowDestroyed: candidate => candidate.destroyed,
    getFocusedWindow: () => window,
    readRecoveryDiagnostic: () => diagnostic,
    retryDashboard: async () => ({ kind: 'recovery', diagnostic }),
    copyText,
    selectFolder,
    showNotification,
    openExternalLink,
    ...overrides,
  }
  registerDesktopIpc({
    handle: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      handlers.set(channel, handler)
    },
  }, dependencies)

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error('desktop:unknown-channel')
    return await handler(event, ...args)
  }
  return { handlers, invoke, copyText, selectFolder, showNotification, openExternalLink }
}

describe('Desktop Main IPC', () => {
  it('registers only six literal channels and rejects malformed payloads before native adapters', async () => {
    const harness = createHarness()

    expect([...harness.handlers.keys()].sort()).toEqual([
      'desktop:copy-recovery-diagnostic',
      'desktop:open-external-link',
      'desktop:read-recovery-diagnostic',
      'desktop:retry-dashboard',
      'desktop:select-folder',
      'desktop:show-notification',
    ])
    await expect(harness.invoke('desktop:get-product-metadata')).rejects.toThrow('desktop:unknown-channel')
    await expect(harness.invoke(desktopChannels.readRecoveryDiagnostic, 'extra'))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(harness.invoke(desktopChannels.retryDashboard, {}))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(harness.invoke(desktopChannels.copyRecoveryDiagnostic, true))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(harness.invoke(desktopChannels.selectFolder, 'C:\\secret'))
      .rejects.toThrow('desktop:invalid-invocation')
    await expect(harness.invoke(desktopChannels.showNotification, { title: 'missing body' }))
      .rejects.toThrow('desktop:invalid-notification')
    await expect(harness.invoke(desktopChannels.openExternalLink, 'http://github.com/deepseek-ai'))
      .rejects.toThrow('desktop:external-link-denied')
    expect(harness.copyText).not.toHaveBeenCalled()
    expect(harness.selectFolder).not.toHaveBeenCalled()
    expect(harness.showNotification).not.toHaveBeenCalled()
    expect(harness.openExternalLink).not.toHaveBeenCalled()
  })

  it('projects recovery values, formats copy text, and preserves only fixed adapter errors', async () => {
    const rawDiagnostic = { ...diagnostic, token: 'must-not-cross-ipc', process: 4412 }
    const retry: DesktopStartupResult = { kind: 'recovery', diagnostic: rawDiagnostic }
    const harness = createHarness({
      readRecoveryDiagnostic: () => rawDiagnostic,
      retryDashboard: async () => retry,
    })

    await expect(harness.invoke(desktopChannels.readRecoveryDiagnostic)).resolves.toEqual(diagnostic)
    await expect(harness.invoke(desktopChannels.retryDashboard)).resolves.toEqual({
      kind: 'recovery',
      diagnostic,
    })
    await expect(harness.invoke(desktopChannels.copyRecoveryDiagnostic)).resolves.toBeUndefined()
    expect(harness.copyText).toHaveBeenCalledWith([
      'Runtime: runtime-unavailable',
      'The local Harness Runtime is unavailable.',
      'Retry the operation.',
      'Diagnostic ID: desktop-ipc-fixture',
    ].join('\n'))
    expect(JSON.stringify(await harness.invoke(desktopChannels.retryDashboard))).not.toContain('token')

    await expect(createHarness({ readRecoveryDiagnostic: () => undefined })
      .invoke(desktopChannels.copyRecoveryDiagnostic)).rejects.toThrow('desktop:no-recovery-diagnostic')
    await expect(createHarness({ copyText: async () => { throw new Error('clipboard raw failure') } })
      .invoke(desktopChannels.copyRecoveryDiagnostic)).rejects.toThrow('desktop:copy-failed')
    await expect(createHarness({ retryDashboard: async () => { throw new Error('Runtime token leaked') } })
      .invoke(desktopChannels.retryDashboard)).rejects.toThrow('desktop:retry-failed')
  })

  it('requires a live sender and focused folder owner while redacting Electron failures', async () => {
    await expect(createHarness({ windowFromEvent: () => null })
      .invoke(desktopChannels.readRecoveryDiagnostic)).rejects.toThrow('desktop:window-unavailable')
    await expect(createHarness({ windowFromEvent: () => { throw new Error('sender raw failure') } })
      .invoke(desktopChannels.readRecoveryDiagnostic)).rejects.toThrow('desktop:window-unavailable')
    await expect(createHarness({ isWindowDestroyed: () => { throw new Error('BrowserWindow raw failure') } })
      .invoke(desktopChannels.readRecoveryDiagnostic)).rejects.toThrow('desktop:window-unavailable')
    await expect(createHarness({ getFocusedWindow: () => otherWindow })
      .invoke(desktopChannels.selectFolder)).rejects.toThrow('desktop:window-not-focused')
    await expect(createHarness({ getFocusedWindow: () => { throw new Error('focus raw failure') } })
      .invoke(desktopChannels.selectFolder)).rejects.toThrow('desktop:window-not-focused')

    await expect(createHarness().invoke(desktopChannels.selectFolder)).resolves.toEqual({
      kind: 'selected',
      path: 'C:\\projects\\harness',
    })
    await expect(createHarness({ selectFolder: async () => ({ canceled: true, filePaths: [] }) })
      .invoke(desktopChannels.selectFolder)).resolves.toEqual({ kind: 'cancelled' })
    await expect(createHarness({ selectFolder: async () => { throw new Error('dialog raw path') } })
      .invoke(desktopChannels.selectFolder)).rejects.toThrow('desktop:folder-selection-failed')
  })

  it('bounds notifications and allows only fixed HTTPS hosts with redacted adapter failures', async () => {
    const harness = createHarness()
    const notification = { title: 'Harness', body: 'Task finished.' }

    await expect(harness.invoke(desktopChannels.showNotification, notification)).resolves.toBeUndefined()
    expect(harness.showNotification).toHaveBeenCalledWith(notification)
    await expect(harness.invoke(desktopChannels.openExternalLink, 'https://github.com/deepseek-ai'))
      .resolves.toBeUndefined()
    expect(harness.openExternalLink).toHaveBeenCalledWith('https://github.com/deepseek-ai')

    await expect(createHarness({ showNotification: () => { throw new Error('notification raw failure') } })
      .invoke(desktopChannels.showNotification, notification)).rejects.toThrow('desktop:notification-failed')
    await expect(createHarness({ openExternalLink: async () => { throw new Error('shell raw failure') } })
      .invoke(desktopChannels.openExternalLink, 'https://github.com/deepseek-ai'))
      .rejects.toThrow('desktop:external-link-failed')
  })

  it('shares one late startup across concurrent retry IPC and includes it in shutdown tasks', async () => {
    const startupTasks = new Set<Promise<unknown>>()
    let connectAttempts = 0
    let controllers = 0
    let attachments = 0
    let releaseConnect!: () => void
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve })
    const flights = new WindowStartupFlights<FakeWindow, DesktopStartupResult>(startupTasks, async () => {
      connectAttempts += 1
      if (connectAttempts === 1) return { kind: 'recovery', diagnostic }
      await connectGate
      controllers += 1
      attachments += 1
      return { kind: 'dashboard-loaded' }
    })
    await flights.run(window)
    const harness = createHarness({ retryDashboard: candidate => flights.run(candidate) })

    const first = harness.invoke(desktopChannels.retryDashboard)
    const second = harness.invoke(desktopChannels.retryDashboard)
    await vi.waitFor(() => { expect(connectAttempts).toBe(2) })
    expect(startupTasks).toHaveLength(1)
    let shutdownSettled = false
    const shutdown = flights.close().then(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    releaseConnect()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'dashboard-loaded' },
      { kind: 'dashboard-loaded' },
    ])
    await shutdown
    expect(connectAttempts).toBe(2)
    expect(controllers).toBe(1)
    expect(attachments).toBe(1)
    expect(startupTasks).toHaveLength(0)
    await expect(flights.run(window)).rejects.toThrow('Desktop window startup is closed.')
    expect(connectAttempts).toBe(2)
  })
})
