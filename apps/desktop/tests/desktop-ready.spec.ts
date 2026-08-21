/** Process acknowledgement for authenticated Dashboard readiness. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { DesktopReadiness, type DashboardReadyWindow } from '../src/main/readiness.ts'

const ORIGIN = 'http://127.0.0.1:43123'

class FakeWebContents extends EventEmitter {
  url = 'about:blank'
  marker: unknown = true
  markerFailure: Error | undefined
  markerPromise: Promise<unknown> | undefined

  getURL(): string { return this.url }

  async executeJavaScript(): Promise<unknown> {
    if (this.markerFailure !== undefined) throw this.markerFailure
    if (this.markerPromise !== undefined) return this.markerPromise
    return this.marker
  }
}

class FakeWindow implements DashboardReadyWindow {
  readonly webContents = new FakeWebContents()
}

describe('Desktop Dashboard readiness', () => {
  it('writes one constant JSONL record only after exact-origin authenticated readiness', async () => {
    const chunks: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => chunks.push(chunk) })
    const window = new FakeWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.url = 'file:///private/bootstrap/index.html'
    window.webContents.emit('did-finish-load')
    await Promise.resolve()
    expect(chunks).toEqual([])

    window.webContents.url = `${ORIGIN}/`
    window.webContents.emit('did-finish-load')
    await expect(ready).resolves.toBeUndefined()
    expect(chunks).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])

    const secondWindow = new FakeWindow()
    const secondReady = readiness.wait(secondWindow, ORIGIN)
    secondWindow.webContents.emit('did-finish-load')
    await expect(secondReady).rejects.toThrow('unexpected Dashboard navigation')

    const thirdWindow = new FakeWindow()
    thirdWindow.webContents.url = `${ORIGIN}/`
    const thirdReady = readiness.wait(thirdWindow, ORIGIN)
    thirdWindow.webContents.emit('did-finish-load')
    await expect(thirdReady).resolves.toBeUndefined()
    expect(chunks).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('does not acknowledge an aborted navigation whose marker probe settles later', async () => {
    const chunks: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => chunks.push(chunk) })
    const window = new FakeWindow()
    const abort = new AbortController()
    let resolveMarker!: (value: unknown) => void
    window.webContents.markerPromise = new Promise((resolve) => { resolveMarker = resolve })
    window.webContents.url = `${ORIGIN}/`
    const ready = readiness.wait(window, ORIGIN, abort.signal)
    const rejected = expect(ready).rejects.toThrow('startup entered recovery')

    window.webContents.emit('did-finish-load')
    abort.abort(new Error('startup entered recovery'))
    resolveMarker(true)

    await rejected
    await Promise.resolve()
    expect(chunks).toEqual([])
  })

  it('emits nothing for recovery or bootstrap-only state', async () => {
    const chunks: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => chunks.push(chunk) })
    const recoveryWindow = new FakeWindow()
    const bootstrapWindow = new FakeWindow()
    const abort = new AbortController()
    const waiting = readiness.wait(bootstrapWindow, ORIGIN, abort.signal)

    bootstrapWindow.webContents.url = 'file:///private/bootstrap/index.html'
    bootstrapWindow.webContents.emit('did-finish-load')
    abort.abort(new Error('startup entered recovery'))
    await expect(waiting).rejects.toThrow('startup entered recovery')
    recoveryWindow.webContents.emit('did-finish-load')
    expect(chunks).toEqual([])
  })

  it.each([
    ['a resolved Web boot failure without the marker', false, undefined],
    ['a marker evaluation failure', true, new Error('marker failed')],
  ])('emits nothing for %s', async (_name, marker, markerFailure) => {
    const chunks: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => chunks.push(chunk) })
    const window = new FakeWindow()
    window.webContents.marker = marker
    window.webContents.markerFailure = markerFailure
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.url = `${ORIGIN}/`
    window.webContents.emit('did-finish-load')

    await expect(ready).rejects.toThrow()
    expect(chunks).toEqual([])
  })

  it('rejects a foreign navigation without reflecting it or acknowledging readiness', async () => {
    const chunks: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => chunks.push(chunk) })
    const window = new FakeWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.url = 'http://127.0.0.1:49999/?handoff=secret'
    window.webContents.emit('did-finish-load')

    await expect(ready).rejects.toThrow('unexpected Dashboard navigation')
    await expect(ready).rejects.not.toThrow('49999')
    expect(chunks).toEqual([])
  })
})
