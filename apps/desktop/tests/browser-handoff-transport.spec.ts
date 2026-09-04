/** Security and lifecycle coverage for Electron's local bootstrap transport. */

import { EventEmitter } from 'node:events'
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page, type Request } from '@playwright/test'
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

class ChromiumWebContents extends EventEmitter {
  constructor(private readonly page: Page) {
    super()
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.emit('did-navigate', {}, frame.url(), 0, '')
    })
    page.on('load', () => { this.emit('did-finish-load') })
    page.on('requestfailed', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.emit('did-fail-load', {}, -1, 'navigation failed', request.url(), true)
      }
    })
  }

  getURL(): string { return this.page.url() }

  executeJavaScript(script: string): Promise<unknown> { return this.page.evaluate(script) }
}

class ChromiumWindow implements DashboardBrowserWindow {
  readonly webContents: ChromiumWebContents
  loadedPath = ''
  bootstrapBody = ''

  constructor(private readonly page: Page) {
    this.webContents = new ChromiumWebContents(page)
  }

  async loadFile(path: string): Promise<void> {
    this.loadedPath = path
    this.bootstrapBody = await readFile(path, 'utf8')
    await this.page.goto(pathToFileURL(path).href, { waitUntil: 'commit' })
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
  it('executes one opaque-file form POST and follows the clean cookie-authenticated redirect in Chromium', async () => {
    const handoff = 'real_chromium_handoff_value_12345678901234567890'
    const session = 'real_chromium_session_value_12345678901234567890'
    const parent = await mkdtemp(join(tmpdir(), 'harness-desktop-bootstrap-browser-test-'))
    roots.push(parent)
    const captures: Array<{
      readonly method: string
      readonly url: string
      readonly headers: IncomingHttpHeaders
      readonly body: string
    }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => { chunks.push(Buffer.from(chunk as Uint8Array)) })
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        captures.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        })
        if (request.method === 'POST' && request.url === '/_harness/handoff') {
          response.writeHead(303, {
            location: '/',
            'cache-control': 'no-store',
            'set-cookie': `harness_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
          })
          response.end()
          return
        }
        if (request.method === 'GET' && request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end(`<!doctype html><div id="root">Protected Dashboard</div><script>
            fetch('/_harness/dashboard-control', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: '{"operation":"get-legacy-migration"}'
            }).then(response => {
              if (response.ok) document.getElementById('root').dataset.harnessDashboardReady = 'true'
            })
          </script>`)
          return
        }
        if (request.method === 'POST' && request.url === '/_harness/dashboard-control') {
          response.writeHead(
            request.headers.cookie === `harness_session=${session}` ? 200 : 403,
            { 'content-type': 'application/json; charset=utf-8' },
          )
          response.end('{"kind":"ready"}')
          return
        }
        response.writeHead(404)
        response.end('not found')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${String(address.port)}`
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    const page = await context.newPage()
    const requests: Request[] = []
    const responses: import('@playwright/test').Response[] = []
    const consoleOutput: string[] = []
    page.on('request', (request) => { requests.push(request) })
    page.on('response', (response) => { responses.push(response) })
    page.on('console', (message) => { consoleOutput.push(message.text()) })
    const output: string[] = []
    const window = new ChromiumWindow(page)
    try {
      await createBrowserHandoffTransport(window, {
        parent,
        readiness: new DesktopReadiness({ write: chunk => output.push(chunk) }),
      }).open(navigation({
        origin,
        id: handoff,
        expiresAt: Date.now() + 60_000,
      }))

      const handoffPosts = captures.filter(capture => (
        capture.method === 'POST' && capture.url === '/_harness/handoff'
      ))
      expect(handoffPosts).toHaveLength(1)
      expect(handoffPosts[0]).toMatchObject({
        url: '/_harness/handoff',
        body: new URLSearchParams({ handoff }).toString(),
      })
      expect(handoffPosts[0]?.headers.origin).toBe('null')
      expect(handoffPosts[0]?.headers.referer).toBeUndefined()
      const rootRequest = captures.find(capture => capture.method === 'GET' && capture.url === '/')
      expect(rootRequest?.headers.cookie).toBeUndefined()
      expect(rootRequest?.headers.referer).toBeUndefined()
      const authenticatedRequest = captures.find(capture => capture.url === '/_harness/dashboard-control')
      expect(authenticatedRequest?.headers.cookie).toBe(`harness_session=${session}`)
      expect(authenticatedRequest?.body).toBe('{"operation":"get-legacy-migration"}')
      const exchange = responses.find(response => response.url() === `${origin}/_harness/handoff`)
      expect(exchange?.status()).toBe(303)
      expect(await exchange?.headerValue('access-control-allow-origin')).toBeNull()
      expect(window.loadedPath).not.toContain(handoff)
      expect(window.bootstrapBody.match(new RegExp(handoff, 'gu'))).toHaveLength(1)
      expect(requests.every(request => !request.url().includes(handoff))).toBe(true)
      const secretFreeHeaders = await Promise.all(requests.map(async (request) => {
        const headers = await request.allHeaders()
        delete headers.cookie
        return JSON.stringify(headers)
      }))
      expect(secretFreeHeaders.join('\n')).not.toContain(handoff)
      expect(await page.evaluate(() => ({
        href: location.href,
        referrer: document.referrer,
        cookie: document.cookie,
        localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
        sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
      }))).toEqual({
        href: `${origin}/`,
        referrer: '',
        cookie: '',
        localStorage: {},
        sessionStorage: {},
      })
      expect(await page.content()).not.toContain(handoff)
      expect(consoleOutput.join('\n')).not.toContain(handoff)
      expect(output).toEqual(['{"kind":"desktop-dashboard-ready","version":1}\n'])
    } finally {
      await context.close()
      await browser.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  }, 60_000)

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
