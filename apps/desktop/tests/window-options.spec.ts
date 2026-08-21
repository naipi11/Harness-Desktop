import { expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createDashboardContentSecurityPolicy,
  createWindowOptions,
  installWindowNavigationPolicy,
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
