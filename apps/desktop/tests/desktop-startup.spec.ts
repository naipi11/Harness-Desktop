// @vitest-environment jsdom
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopStartup } from '../src/renderer/src/DesktopStartup.tsx'
import type {
  DesktopBridge,
  DesktopRecoveryDiagnostic,
  DesktopStartupResult,
} from '../src/shared/desktop-api.ts'

const diagnostic: DesktopRecoveryDiagnostic = {
  code: 'dashboard-unavailable',
  subject: 'Dashboard',
  message: 'The Harness Dashboard is unavailable.',
  correction: 'Retry the operation.',
  diagnosticId: 'diagnostic-renderer-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => {
    root.unmount()
  })
  container.remove()
})

it('reads Main recovery state without starting a Dashboard retry', async () => {
  const bridge = createBridge({ readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic) })

  await renderStartup(bridge)

  const alert = requiredElement('[role="alert"]')
  expect(alert.textContent).toContain('Dashboard')
  expect(alert.textContent).toContain('dashboard-unavailable')
  expect(alert.textContent).toContain('Retry the operation.')
  expect(alert.textContent).toContain('diagnostic-renderer-fixture')
  expect(requiredButton('Retry Dashboard').disabled).toBe(false)
  expect(requiredButton('Copy diagnostic').disabled).toBe(false)
  expect(bridge.retryDashboard).not.toHaveBeenCalled()
})

it('disables both recovery controls while a Dashboard retry is pending', async () => {
  const retry = deferred<DesktopStartupResult>()
  const bridge = createBridge({
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic),
    retryDashboard: vi.fn(() => retry.promise),
  })
  await renderStartup(bridge)

  click('Retry Dashboard')

  expect(requiredButton('Retry Dashboard').disabled).toBe(true)
  expect(requiredButton('Copy diagnostic').disabled).toBe(true)

  retry.resolve({ kind: 'recovery', diagnostic })
  await retry.promise
  await vi.waitFor(() => {
    expect(requiredButton('Retry Dashboard').disabled).toBe(false)
  })
})

it('delegates a successful Dashboard retry to Main', async () => {
  const retryDashboard = vi.fn().mockResolvedValue({ kind: 'dashboard-loaded' } satisfies DesktopStartupResult)
  const bridge = createBridge({
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic),
    retryDashboard,
  })
  await renderStartup(bridge)

  click('Retry Dashboard')

  await vi.waitFor(() => {
    expect(requiredButton('Retry Dashboard').disabled).toBe(false)
  })

  expect(retryDashboard).toHaveBeenCalledOnce()
  expect(requiredButton('Retry Dashboard').disabled).toBe(false)
  expect(requiredButton('Copy diagnostic').disabled).toBe(false)
})

it('replaces the visible diagnostic when Main returns recovery again', async () => {
  const nextDiagnostic: DesktopRecoveryDiagnostic = {
    code: 'runtime-unavailable',
    subject: 'Runtime',
    message: 'The local Runtime is unavailable.',
    correction: 'Start Harness again.',
    diagnosticId: 'diagnostic-retry-fixture' as DesktopRecoveryDiagnostic['diagnosticId'],
  }
  const bridge = createBridge({
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic),
    retryDashboard: vi.fn().mockResolvedValue({
      kind: 'recovery',
      diagnostic: nextDiagnostic,
    } satisfies DesktopStartupResult),
  })
  await renderStartup(bridge)

  click('Retry Dashboard')

  await vi.waitFor(() => {
    expect(requiredElement('[role="alert"]').textContent).toContain('diagnostic-retry-fixture')
  })

  const alert = requiredElement('[role="alert"]')
  expect(alert.textContent).toContain('Runtime')
  expect(alert.textContent).toContain('runtime-unavailable')
  expect(alert.textContent).toContain('Start Harness again.')
  expect(alert.textContent).toContain('diagnostic-retry-fixture')
  expect(alert.textContent).not.toContain('diagnostic-renderer-fixture')
  expect(requiredButton('Retry Dashboard').disabled).toBe(false)
})

it('copies Main recovery state and announces completion', async () => {
  const copyRecoveryDiagnostic = vi.fn().mockResolvedValue(undefined)
  const bridge = createBridge({
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(diagnostic),
    copyRecoveryDiagnostic,
  })
  await renderStartup(bridge)

  click('Copy diagnostic')

  await vi.waitFor(() => {
    expect(requiredElement('[role="status"]').textContent).toBe('Diagnostic copied')
  })

  expect(copyRecoveryDiagnostic).toHaveBeenCalledOnce()
  expect(requiredElement('[role="status"]').textContent).toBe('Diagnostic copied')
})

async function renderStartup(bridge: DesktopBridge): Promise<void> {
  flushSync(() => {
    root.render(createElement(DesktopStartup, { bridge }))
  })
  await vi.waitFor(() => requiredElement('[role="alert"]'))
}

function click(label: string): void {
  flushSync(() => {
    requiredButton(label).click()
  })
}

function requiredButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`Button ${JSON.stringify(label)} is missing.`)
  return button
}

function requiredElement(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`Element ${JSON.stringify(selector)} is missing.`)
  return element
}

function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    version: 1,
    readRecoveryDiagnostic: vi.fn().mockResolvedValue(undefined),
    retryDashboard: vi.fn().mockResolvedValue({ kind: 'dashboard-loaded' }),
    copyRecoveryDiagnostic: vi.fn().mockResolvedValue(undefined),
    selectFolder: vi.fn().mockResolvedValue({ kind: 'cancelled' }),
    showNotification: vi.fn().mockResolvedValue(undefined),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
