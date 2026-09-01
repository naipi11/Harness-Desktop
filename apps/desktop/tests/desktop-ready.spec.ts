/** Process acknowledgement for authenticated Dashboard readiness. */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DesktopReadiness,
  isDesktopReadyAcknowledgement,
  type DashboardReadyWindow,
} from '../src/main/readiness.ts'

const ORIGIN = 'http://127.0.0.1:43123'
const readinessModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/main/readiness.ts', import.meta.url))).href
const tsxLoader = import.meta.resolve('tsx')

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

class DeferredErrorOutput extends EventEmitter {
  readonly writes: string[] = []

  constructor(private readonly code = 'EPIPE') { super() }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    queueMicrotask(() => {
      this.emit('error', outputError(this.code))
    })
    return false
  }
}

class SynchronousErrorOutput {
  readonly writes: string[] = []

  constructor(private readonly code = 'EPIPE') {}

  write(chunk: string): boolean {
    this.writes.push(chunk)
    throw outputError(this.code)
  }
}

class RecordingOutput {
  readonly writes: string[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
}

class CallbackErrorOutput extends EventEmitter {
  readonly writes: string[] = []

  constructor(private readonly code = 'EPIPE') { super() }

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk)
    queueMicrotask(() => { callback?.(outputError(this.code)) })
    return false
  }
}

class CallbackThenErrorOutput extends EventEmitter {
  readonly writes: string[] = []

  constructor(private readonly code = 'EPIPE') { super() }

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk)
    const error = outputError(this.code)
    queueMicrotask(() => {
      callback?.(error)
      queueMicrotask(() => { this.emit('error', error) })
    })
    return false
  }
}

class ControlledErrorOutput extends EventEmitter {
  readonly writes: string[] = []
  private callback: ((error?: Error | null) => void) | undefined

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk)
    this.callback = callback
    return false
  }

  fail(): void {
    const error = Object.assign(new Error('broken acknowledgement pipe'), { code: 'EPIPE' })
    this.callback?.(error)
    queueMicrotask(() => { this.emit('error', error) })
  }

  succeed(): void {
    this.callback?.()
  }
}

class FakeWindow implements DashboardReadyWindow {
  readonly webContents = new FakeWebContents()
}

describe('Desktop Dashboard readiness', () => {
  it.each([
    ['a non-enumerable extra field', () => Object.defineProperty({ kind: 'desktop-dashboard-ready', version: 1 }, 'extra', { value: true })],
    ['an enumerable symbol field', () => ({ kind: 'desktop-dashboard-ready', version: 1, [Symbol('extra')]: true })],
    ['an acknowledgement accessor', () => Object.defineProperty({ version: 1 }, 'kind', { enumerable: true, get: () => 'desktop-dashboard-ready' })],
  ])('rejects %s', (_name, create) => {
    expect(isDesktopReadyAcknowledgement(create())).toBe(false)
  })

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

  it('keeps Dashboard readiness after a delayed EPIPE acknowledgement failure', async () => {
    const output = new DeferredErrorOutput()
    const readiness = new DesktopReadiness(output)
    const window = new FakeWindow()
    window.webContents.url = `${ORIGIN}/`
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).resolves.toBeUndefined()
    await settleOutputEvents()
    expect(output.listenerCount('error')).toBe(0)
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('keeps Dashboard readiness after a synchronous EPIPE acknowledgement failure', async () => {
    const output = new SynchronousErrorOutput()
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).resolves.toBeUndefined()
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('keeps Dashboard readiness after an EPIPE acknowledgement callback failure', async () => {
    const output = new CallbackErrorOutput()
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).resolves.toBeUndefined()
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('keeps Dashboard readiness after the output error emitted after an EPIPE callback failure', async () => {
    const output = new CallbackThenErrorOutput()
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).resolves.toBeUndefined()
    await settleOutputEvents()
    expect(output.listenerCount('error')).toBe(0)
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('rejects a non-EPIPE synchronous acknowledgement failure', async () => {
    const output = new SynchronousErrorOutput('EIO')
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).rejects.toThrow('acknowledgement could not be written')
  })

  it('rejects a non-EPIPE acknowledgement callback failure', async () => {
    const output = new CallbackThenErrorOutput('EIO')
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).rejects.toThrow('acknowledgement could not be written')
    await settleOutputEvents()
    expect(output.listenerCount('error')).toBe(0)
  })

  it('keeps Dashboard readiness when no acknowledgement output is attached', async () => {
    const readiness = new DesktopReadiness(null)
    const window = readyWindow()
    const ready = readiness.wait(window, ORIGIN)

    window.webContents.emit('did-finish-load')

    await expect(ready).resolves.toBeUndefined()
  })

  it('writes one acknowledgement when two windows become ready concurrently through a non-event output', async () => {
    const output = new RecordingOutput()
    const readiness = new DesktopReadiness(output)
    const first = readyWindow()
    const second = readyWindow()
    const firstReady = readiness.wait(first, ORIGIN)
    const secondReady = readiness.wait(second, ORIGIN)

    first.webContents.emit('did-finish-load')
    second.webContents.emit('did-finish-load')

    await expect(Promise.all([firstReady, secondReady])).resolves.toEqual([undefined, undefined])
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('removes the acknowledgement listener after an aborted waiter drains callback and error', async () => {
    const output = new ControlledErrorOutput()
    const readiness = new DesktopReadiness(output)
    const window = readyWindow()
    const abort = new AbortController()
    const ready = readiness.wait(window, ORIGIN, abort.signal)

    window.webContents.emit('did-finish-load')
    await Promise.resolve()
    expect(output.listenerCount('error')).toBe(1)
    abort.abort(new Error('startup entered recovery'))
    output.fail()
    await expect(ready).rejects.toThrow()
    await settleOutputEvents()
    expect(output.listenerCount('error')).toBe(0)
  })

  it('keeps a shared acknowledgement write for a later waiter after the first waiter aborts', async () => {
    const output = new ControlledErrorOutput()
    const readiness = new DesktopReadiness(output)
    const first = readyWindow()
    const firstAbort = new AbortController()
    const firstReady = readiness.wait(first, ORIGIN, firstAbort.signal)

    first.webContents.emit('did-finish-load')
    await Promise.resolve()
    expect(output.listenerCount('error')).toBe(1)
    firstAbort.abort(new Error('startup entered recovery'))
    await expect(firstReady).rejects.toThrow('startup entered recovery')

    const second = readyWindow()
    const secondReady = readiness.wait(second, ORIGIN)
    second.webContents.emit('did-finish-load')
    await Promise.resolve()
    output.succeed()

    await expect(secondReady).resolves.toBeUndefined()
    await settleOutputEvents()
    expect(output.writes).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
    expect(output.listenerCount('error')).toBe(0)
  })

  it('survives a real disconnected stdout pipe after callback before output error', async () => {
    const result = await runDisconnectedAcknowledgementProcess()

    expect(result).toEqual({
      exitCode: 0,
      stderr: '{"result":"resolved","sequence":["callback:EPIPE","error:EPIPE"]}\n',
    })
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

function readyWindow(): FakeWindow {
  const window = new FakeWindow()
  window.webContents.url = `${ORIGIN}/`
  return window
}

function outputError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error('broken acknowledgement output'), { code })
}

async function settleOutputEvents(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(() => { setImmediate(() => { setImmediate(resolve) }) }) })
}

async function runDisconnectedAcknowledgementProcess(): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  const source = [
    "import { EventEmitter } from 'node:events'",
    `import { DesktopReadiness } from ${JSON.stringify(readinessModuleUrl)}`,
    'const sequence = []',
    'const emit = process.stdout.emit.bind(process.stdout)',
    'process.stdout.emit = (event, ...args) => { if (event === "error") sequence.push(`error:${args[0]?.code ?? "unknown"}`); return emit(event, ...args) }',
    'const write = process.stdout.write.bind(process.stdout)',
    'process.stdout.write = (chunk, callback) => write(chunk, error => { sequence.push(`callback:${error?.code ?? "none"}`); callback?.(error) })',
    'class WebContents extends EventEmitter { getURL() { return "http://127.0.0.1:43123/" } async executeJavaScript() { return true } }',
    'const window = { webContents: new WebContents() }',
    'const readiness = new DesktopReadiness()',
    'const ready = readiness.wait(window, "http://127.0.0.1:43123")',
    'window.webContents.emit("did-finish-load")',
    'let result',
    'try { await ready; result = "resolved" } catch { result = "rejected" }',
    'await new Promise(resolve => setImmediate(() => setImmediate(resolve)))',
    'process.stderr.write(JSON.stringify({ result, sequence }) + "\\n")',
  ].join('; ')
  const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.destroy()
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { resolve(code) })
  })
  return { exitCode, stderr }
}
