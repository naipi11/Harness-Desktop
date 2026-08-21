/** Security and lifecycle coverage for Electron's local bootstrap transport. */

import { EventEmitter } from 'node:events'
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardNavigation } from '@harness-desktop/dsh-host-local-runtime'
import {
  browserBootstrapAccess,
  createBrowserHandoffTransport,
  type BrowserBootstrapAccess,
  type DashboardBrowserWindow,
} from '../src/main/browser-handoff-transport.ts'
import { DesktopReadiness } from '../src/main/readiness.ts'

const HANDOFF = 'desktop_handoff_value_12345678901234567890'
const ORIGIN = 'http://127.0.0.1:43123'
const roots: string[] = []

function navigation(overrides: {
  readonly origin?: string
  readonly id?: string
  readonly expiresAt?: number
} = {}): DashboardNavigation {
  return {
    origin: (overrides.origin ?? ORIGIN) as DashboardNavigation['origin'],
    handoff: {
      id: (overrides.id ?? HANDOFF) as DashboardNavigation['handoff']['id'],
      expiresAt: overrides.expiresAt ?? 61_000,
    },
  }
}

class FakeWebContents extends EventEmitter {
  url = 'about:blank'
  marker: unknown = true
  readonly scripts: string[] = []

  getURL(): string { return this.url }

  async executeJavaScript(script: string): Promise<unknown> {
    this.scripts.push(script)
    return this.marker
  }
}

class FakeWindow implements DashboardBrowserWindow {
  readonly webContents = new FakeWebContents()
  readonly loaded: string[] = []
  onLoad?: (path: string) => Promise<void>

  async loadFile(path: string): Promise<void> {
    this.loaded.push(path)
    await this.onLoad?.(path)
  }
}

const permissiveAccess: BrowserBootstrapAccess = {
  async protectDirectory() {},
  async protectFile() {},
  async verifyDirectory() {},
  async verifyFile() {},
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Electron browser handoff transport', () => {
  it('puts the handoff only in a verified private document and one opaque-origin POST body', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-test-'))
    roots.push(parent)
    const output: string[] = []
    const readiness = new DesktopReadiness({ write: chunk => output.push(chunk) })
    const window = new FakeWindow()
    const capture: {
      url?: string
      method?: string
      body?: string
      referrer?: string
      headers?: Record<string, string>
      responseHeaders?: Record<string, string>
    } = {}
    window.onLoad = async (documentPath) => {
      const fileUrl = pathToFileURL(documentPath).href
      const html = await readFile(documentPath, 'utf8')
      expect(fileUrl).not.toContain(HANDOFF)
      expect(documentPath).not.toContain(HANDOFF)
      expect(html.match(new RegExp(HANDOFF, 'gu'))).toHaveLength(1)
      expect(html).toContain('<meta name="referrer" content="no-referrer">')
      expect(html).toContain('method="post"')
      expect(html).toContain('autocomplete="off"')
      expect(html).toContain(`action="${ORIGIN}/_harness/handoff"`)
      expect(html).toContain(`type="hidden" name="handoff" value="${HANDOFF}"`)
      await browserBootstrapAccess.verifyDirectory(dirname(documentPath))
      await browserBootstrapAccess.verifyFile(documentPath)

      capture.url = `${ORIGIN}/_harness/handoff`
      capture.method = 'POST'
      capture.body = `handoff=${encodeURIComponent(HANDOFF)}`
      capture.referrer = ''
      capture.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      capture.responseHeaders = { location: '/' }
      window.webContents.url = `${ORIGIN}/`
      window.webContents.emit('did-navigate', {}, `${ORIGIN}/`, 303, 'See Other')
      window.webContents.emit('did-finish-load')
    }

    await expect(createBrowserHandoffTransport(window, {
      parent,
      now: () => 1_000,
      readiness,
    }).open(navigation())).resolves.toBeUndefined()

    expect(window.loaded).toHaveLength(1)
    expect(capture).toEqual({
      url: `${ORIGIN}/_harness/handoff`,
      method: 'POST',
      body: `handoff=${encodeURIComponent(HANDOFF)}`,
      referrer: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      responseHeaders: { location: '/' },
    })
    expect(capture.responseHeaders).not.toHaveProperty('access-control-allow-origin')
    expect(window.webContents.url).toBe(`${ORIGIN}/`)
    expect(new URL(window.webContents.url).search).toBe('')
    expect(new URL(window.webContents.url).hash).toBe('')
    expect(window.webContents.scripts.join('\n')).not.toContain(HANDOFF)
    expect(output.join('')).not.toContain(HANDOFF)
    expect(JSON.stringify({ ...capture, body: '[REDACTED]' })).not.toContain(HANDOFF)
    expect(output).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
  })

  it('rejects a broader-access bootstrap before loading it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-test-'))
    roots.push(parent)
    const window = new FakeWindow()
    const rejectingAccess: BrowserBootstrapAccess = {
      async protectDirectory() {},
      async protectFile(path) {
        if (process.platform !== 'win32') await chmod(path, 0o644)
      },
      async verifyDirectory() {},
      async verifyFile() { throw new Error('bootstrap path is broader than the current user') },
    }

    await expect(createBrowserHandoffTransport(window, {
      parent,
      access: rejectingAccess,
      now: () => 1_000,
    }).open(navigation())).rejects.toThrow('broader than the current user')
    expect(window.loaded).toEqual([])
  })

  it('uses one cleanup for dispatch failure, failed exchange, and undispatched expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-test-'))
    roots.push(parent)
    const removed: string[] = []
    const remove = async (path: string): Promise<void> => { removed.push(path) }

    const failedDispatchWindow = new FakeWindow()
    failedDispatchWindow.onLoad = async () => { throw new Error('loadFile failed') }
    await expect(createBrowserHandoffTransport(failedDispatchWindow, {
      parent, access: permissiveAccess, now: Date.now, remove,
    }).open(navigation({ expiresAt: 2_000 }))).rejects.toThrow('loadFile failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(1)

    const failedExchangeWindow = new FakeWindow()
    failedExchangeWindow.onLoad = async () => {
      failedExchangeWindow.webContents.emit('did-fail-load', {}, -324, 'EMPTY_RESPONSE', `${ORIGIN}/_harness/handoff`, true)
    }
    await expect(createBrowserHandoffTransport(failedExchangeWindow, {
      parent, access: permissiveAccess, now: Date.now, remove,
    }).open(navigation({ id: `${HANDOFF}_failed`, expiresAt: 3_000 }))).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(2)

    let releaseLoad!: () => void
    let markLoadStarted!: () => void
    const loadStarted = new Promise<void>((resolve) => { markLoadStarted = resolve })
    const neverDispatchedWindow = new FakeWindow()
    neverDispatchedWindow.onLoad = () => {
      markLoadStarted()
      return new Promise<void>((resolve) => { releaseLoad = resolve })
    }
    const opening = createBrowserHandoffTransport(neverDispatchedWindow, {
      parent, access: permissiveAccess, now: Date.now, remove,
    }).open(navigation({ id: `${HANDOFF}_expiry`, expiresAt: 4_000 }))
    const expired = expect(opening).rejects.toThrow('expired')
    await loadStarted
    await vi.advanceTimersByTimeAsync(1_000)
    await expired
    releaseLoad()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(3)
  })

  it('removes the real document and directory exactly once after a clean exchange', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-test-'))
    roots.push(parent)
    const window = new FakeWindow()
    let documentPath = ''
    window.onLoad = async (path) => {
      documentPath = path
      window.webContents.url = `${ORIGIN}/`
      window.webContents.emit('did-navigate', {}, `${ORIGIN}/`, 303, 'See Other')
      window.webContents.emit('did-finish-load')
    }

    await createBrowserHandoffTransport(window, {
      parent,
      now: Date.now,
      readiness: new DesktopReadiness({ write() {} }),
    }).open(navigation({ expiresAt: 2_000 }))
    await expect(access(documentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(dirname(documentPath))).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(access(dirname(documentPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['foreign host', { origin: 'http://localhost:43123' }],
    ['missing port', { origin: 'http://127.0.0.1' }],
    ['userinfo', { origin: 'http://user@127.0.0.1:43123' }],
    ['query', { origin: 'http://127.0.0.1:43123?handoff=secret' }],
    ['fragment', { origin: 'http://127.0.0.1:43123#secret' }],
    ['wrong handoff', { id: 'wrong' }],
    ['expired handoff', { expiresAt: 1_000 }],
  ])('rejects %s before loading', async (_name, overrides) => {
    const window = new FakeWindow()
    await expect(createBrowserHandoffTransport(window, {
      access: permissiveAccess,
      now: () => 1_000,
    }).open(navigation(overrides))).rejects.toThrow()
    expect(window.loaded).toEqual([])
  })

  it('rejects a second dispatch of the same handoff', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-test-'))
    roots.push(parent)
    const window = new FakeWindow()
    window.onLoad = async () => {
      window.webContents.url = `${ORIGIN}/`
      window.webContents.emit('did-navigate', {}, `${ORIGIN}/`, 303, 'See Other')
      window.webContents.emit('did-finish-load')
    }
    const transport = createBrowserHandoffTransport(window, {
      parent,
      access: permissiveAccess,
      now: () => 1_000,
      readiness: new DesktopReadiness({ write() {} }),
    })

    await transport.open(navigation())
    await expect(transport.open(navigation())).rejects.toThrow('already dispatched')
    expect(window.loaded).toHaveLength(1)
  })
})
