import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createDashboardContentSecurityPolicy,
  createWindowOptions,
  installWindowNavigationPolicy,
  WindowRecoveryFlights,
  WindowRuntimeOwners,
} from '../src/main/window-options.ts'

it('keeps the desktop window sandboxed behind the supplied preload', () => {
  const options = createWindowOptions('C:\\app\\preload.js')

  expect(options.webPreferences).toEqual({
    preload: 'C:\\app\\preload.js',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  })
})

it('keeps a retiring owner visible to shutdown until close settles', async () => {
  const owners = new WindowRuntimeOwners<object, object, { close(): Promise<void> }>()
  const window = {}
  let releaseClose!: () => void
  const close = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve }))
  const original = { close }
  const replacement = { close: vi.fn(async () => {}) }
  owners.publish(window, {}, original, 'http://127.0.0.1:41001')

  const retiring = owners.retire(window)
  expect(owners.controller(window)).toBeUndefined()
  expect(owners.client(window)).toBeUndefined()
  expect(owners.origin(window)).toBeUndefined()
  expect(owners.active()).toEqual([original])

  owners.publish(window, {}, replacement, 'http://127.0.0.1:41002')
  expect(owners.active()).toEqual([original, replacement])
  releaseClose()
  await retiring
  expect(close).toHaveBeenCalledOnce()
  expect(owners.controller(window)).toBe(replacement)
  expect(owners.origin(window)).toBe('http://127.0.0.1:41002')
  expect(owners.active()).toEqual([replacement])
})

it('retains a failed retirement for shutdown retry and propagates the failure', async () => {
  const owners = new WindowRuntimeOwners<object, object, { close(): Promise<void> }>()
  const window = {}
  const failure = new Error('client close failed')
  const close = vi.fn(async () => { throw failure })
  const original = { close }
  owners.publish(window, {}, original, 'http://127.0.0.1:41001')

  await expect(owners.retire(window)).rejects.toBe(failure)
  expect(owners.controller(window)).toBeUndefined()
  expect(owners.client(window)).toBeUndefined()
  expect(owners.origin(window)).toBeUndefined()
  expect(owners.active()).toEqual([original])

  const shutdown = await Promise.allSettled(owners.active().map(controller => controller.close()))
  expect(shutdown).toEqual([{ status: 'rejected', reason: failure }])
  expect(close).toHaveBeenCalledTimes(2)
})

it('registers a recovery flight before its operation can synchronously reenter', async () => {
  const flights = new WindowRecoveryFlights<object>()
  const window = {}
  let calls = 0
  let nested: Promise<void> | undefined

  const outer = flights.run(window, async () => {
    calls += 1
    nested = flights.run(window, async () => { calls += 1 })
  })

  await outer
  await nested
  expect(calls).toBe(1)
})

it('limits Dashboard connections to self and the exact Runtime WebSocket origin', () => {
  expect(createDashboardContentSecurityPolicy('http://127.0.0.1:41234')).toBe(
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: blob:; font-src 'self' data:; "
    + "connect-src 'self' ws://127.0.0.1:41234; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
})

it('denies child windows and permits navigation only to recovery or the current exact Runtime origin', () => {
  const contents = new EventEmitter() as EventEmitter & {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  }
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined
  contents.setWindowOpenHandler = (handler) => { openHandler = handler }
  installWindowNavigationPolicy(contents, {
    recoveryUrl: 'file:///C:/app/renderer/index.html',
    dashboardOrigin: () => 'http://127.0.0.1:41234',
  })

  expect(openHandler?.({ url: 'https://github.com' })).toEqual({ action: 'deny' })
  for (const [url, prevented] of [
    ['file:///C:/app/renderer/index.html', false],
    ['http://127.0.0.1:41234/', false],
    ['http://127.0.0.1:41234/settings', false],
    ['http://localhost:41234/', true],
    ['http://127.0.0.1:43123/', true],
    ['https://github.com/', true],
  ] as const) {
    let wasPrevented = false
    contents.emit('will-navigate', { preventDefault: () => { wasPrevented = true } }, url)
    expect(wasPrevented, url).toBe(prevented)
  }
})
