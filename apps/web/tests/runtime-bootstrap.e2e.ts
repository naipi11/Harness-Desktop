/** Real Chromium coverage for the opaque-file handoff and clean Dashboard redirect. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Request, type Response } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface DashboardNavigation {
  readonly origin: string
  readonly handoff: { readonly id: string; readonly expiresAt: number }
}

interface DashboardAuth {
  mintBrowserHandoff(): { readonly id: string; readonly expiresAt: number }
}

interface RuntimeWebServer {
  readonly port: number
  registerFallback(handler: (request: IncomingMessage, response: ServerResponse) => void): () => void
}

interface RuntimeContext {
  readonly webServer: RuntimeWebServer
  readonly fiber: { dispose(): Promise<void> }
  plugin(plugin: unknown, config?: unknown): { await(): Promise<void> }
}

type CreateBrowserHandoffTransport = (options: {
  readonly parent: string
  readonly now: () => number
  readonly dispatch: (url: string) => Promise<void>
}) => { open(target: DashboardNavigation): Promise<void> }

type MountLocalControlRoutes = (context: unknown, options: {
  readonly auth: DashboardAuth
  readonly controlService: { handleDashboard(): Promise<{ readonly kind: string }> }
  readonly onHandoffSettled: () => Promise<void>
}) => void

const RECOVERY = 'Dashboard connection expired. Run harness web to reconnect.'
const appRoot = fileURLToPath(new URL('..', import.meta.url))
let browser: Browser
let context: RuntimeContext
let vite: ViteDevServer
let bootstrapRoot = ''
let origin = ''
let runtimeNow = Date.now()
let auth: DashboardAuth
let createBrowserHandoffTransport: CreateBrowserHandoffTransport
let settledHandoffs = 0

function navigation(id: string, expiresAt: number): DashboardNavigation {
  return {
    origin,
    handoff: { id, expiresAt },
  }
}

async function openBootstrap(
  target: DashboardNavigation,
  page: Page,
  beforeNavigate: () => void = () => {},
): Promise<string> {
  let documentPath = ''
  const transport = createBrowserHandoffTransport({
    parent: bootstrapRoot,
    now: () => runtimeNow,
    dispatch: async (url) => {
      documentPath = fileURLToPath(url)
      beforeNavigate()
      await page.goto(url)
    },
  })
  await transport.open(target)
  return documentPath
}

function observe(page: Page): {
  requests: Request[]
  responses: Response[]
  consoleOutput: string[]
} {
  const requests: Request[] = []
  const responses: Response[] = []
  const consoleOutput: string[] = []
  page.on('request', (request) => { requests.push(request) })
  page.on('response', (response) => { responses.push(response) })
  page.on('console', (message) => { consoleOutput.push(message.text()) })
  return { requests, responses, consoleOutput }
}

async function assertRecovery(page: Page, secret: string, consoleOutput: readonly string[]): Promise<void> {
  await page.getByText(RECOVERY, { exact: true }).waitFor()
  const evidence = await page.evaluate(async () => ({
    body: document.body.textContent,
    cookie: document.cookie,
    localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    indexedDatabases: typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map(database => database.name)
      : [],
  }))
  expect(evidence).toEqual({
    body: RECOVERY,
    cookie: '',
    localStorage: {},
    sessionStorage: {},
    indexedDatabases: [],
  })
  expect(JSON.stringify(evidence)).not.toContain(secret)
  expect(consoleOutput.join('\n')).not.toContain(secret)
}

beforeAll(async () => {
  const cordisSpecifier: string = '@harness-desktop/cordis'
  const webServerSpecifier: string = '@harness-desktop/dsh-host-webserver'
  const authSpecifier = new URL('../../../packages/host/local-runtime/src/auth.ts', import.meta.url).href
  const routesSpecifier = new URL('../../../packages/host/local-runtime/src/control-routes.ts', import.meta.url).href
  const browserSpecifier = new URL('../../cli/src/browser.ts', import.meta.url).href
  const [cordisModule, webServerModule, authModule, routesModule, browserModule] = await Promise.all([
    import(cordisSpecifier),
    import(webServerSpecifier),
    import(authSpecifier),
    import(routesSpecifier),
    import(browserSpecifier),
  ]) as unknown as [
    { readonly Context: new () => RuntimeContext },
    { readonly default: unknown },
    { readonly LocalDashboardAuth: new (options: {
      readonly accessToken: string
      readonly origin: string
      readonly now: () => number
    }) => DashboardAuth },
    { readonly mountLocalControlRoutes: MountLocalControlRoutes },
    { readonly createBrowserHandoffTransport: CreateBrowserHandoffTransport },
  ]
  createBrowserHandoffTransport = browserModule.createBrowserHandoffTransport
  bootstrapRoot = await mkdtemp(join(tmpdir(), 'harness-real-browser-bootstrap-'))
  vite = await createViteServer({
    configFile: false,
    root: appRoot,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    plugins: [{
      name: 'runtime-bootstrap-dashboard-stub',
      enforce: 'pre',
      resolveId(id) { return id === '@harness-desktop/dsh-client-web' ? '\0dashboard-stub' : undefined },
      load(id) {
        if (id !== '\0dashboard-stub') return undefined
        return 'export class AppWebEntry { constructor(root) { this.root = root } async run() { this.root.textContent = \'Protected Dashboard\' } }'
      },
    }],
  })
  context = new cordisModule.Context()
  await context.plugin(webServerModule.default, { host: '127.0.0.1', port: 0 }).await()
  origin = `http://127.0.0.1:${String(context.webServer.port)}`
  auth = new authModule.LocalDashboardAuth({
    accessToken: 'browser-test-native-token',
    origin,
    now: () => runtimeNow,
  })
  const controlService: { handleDashboard(): Promise<{ readonly kind: string }> } = {
    async handleDashboard() { return { kind: 'ready' } },
  }
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext: unknown) {
      routesModule.mountLocalControlRoutes(routeContext, {
        auth,
        controlService,
        async onHandoffSettled() { settledHandoffs += 1 },
      })
    },
  }).await()
  context.webServer.registerFallback((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/unexpected')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><div id="root"></div><script type="module" src="/src/main.ts"></script>')
      return
    }
    vite.middlewares(request, response, () => {
      response.writeHead(404)
      response.end('not found')
    })
  })
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await context?.fiber.dispose().catch(() => {})
  await rm(bootstrapRoot, { recursive: true, force: true })
})

describe('Runtime Dashboard bootstrap', () => {
  it('posts one body-only handoff from an opaque file origin and starts only at clean slash', async () => {
    runtimeNow = Date.now()
    const handoff = auth.mintBrowserHandoff()
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    const observed = observe(page)
    try {
      const beforeSettled = settledHandoffs
      const documentPath = await openBootstrap(navigation(handoff.id, handoff.expiresAt), page)
      await page.getByText('Protected Dashboard', { exact: true }).waitFor()
      await expect.poll(() => page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBe('true')

      const bootstrap = await readFile(documentPath, 'utf8')
      expect(bootstrap.match(new RegExp(handoff.id, 'gu'))).toHaveLength(1)
      expect(observed.requests.map(request => request.url())).toContain(`${origin}/_harness/handoff`)
      expect(observed.requests.map(request => request.url())).toContain(`${origin}/`)
      expect(observed.requests.map(request => request.url())).toContain(`${origin}/src/main.ts`)
      expect(observed.requests.at(-1)?.url()).toBe(`${origin}/_harness/dashboard-control`)
      expect(observed.requests.every(request => !request.url().includes(handoff.id))).toBe(true)
      const handoffRequest = observed.requests.find(request => request.url().endsWith('/_harness/handoff'))
      expect(handoffRequest?.postData()).toBe(new URLSearchParams({ handoff: handoff.id }).toString())
      const safeHeaders = await Promise.all(observed.requests.map(async (request) => {
        const headers = await request.allHeaders()
        delete headers.cookie
        return JSON.stringify(headers)
      }))
      expect(safeHeaders.join('\n')).not.toContain(handoff.id)
      expect(safeHeaders).toContainEqual(expect.stringContaining('"origin":"null"'))
      const exchange = observed.responses.find(response => response.url().endsWith('/_harness/handoff'))
      expect(exchange?.status()).toBe(303)
      expect(await exchange?.headerValue('access-control-allow-origin')).toBeNull()
      expect(settledHandoffs).toBe(beforeSettled + 1)
      const cookie = (await browserContext.cookies(origin)).find(value => value.name === 'harness_session')
      expect(cookie).toBeDefined()
      expect({ name: cookie?.name, httpOnly: cookie?.httpOnly, sameSite: cookie?.sameSite, path: cookie?.path }).toEqual({
        name: 'harness_session',
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      })
      expect(await page.evaluate(() => ({
        href: location.href,
        referrer: document.referrer,
        cookie: document.cookie,
        localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
        sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
        body: document.body.textContent,
        historyLength: history.length,
      }))).toEqual({
        href: `${origin}/`,
        referrer: '',
        cookie: '',
        localStorage: {},
        sessionStorage: {},
        body: 'Protected Dashboard',
        historyLength: 2,
      })
      expect(observed.consoleOutput.join('\n')).not.toContain(handoff.id)
      const pageContent = await page.content()
      expect(pageContent).not.toContain(handoff.id)
      expect([
        pageContent,
        observed.consoleOutput.join('\n'),
        await page.evaluate(() => JSON.stringify({
          localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
          sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
        })),
      ].some(value => cookie !== undefined && value.includes(cookie.value))).toBe(false)
    } finally {
      await browserContext.close()
    }
  }, 60_000)

  it('rejects a non-clean initial Dashboard URL before mounting protected state', async () => {
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    try {
      await page.goto(`${origin}/unexpected?value=private`)
      await page.getByText(RECOVERY, { exact: true }).waitFor()
      expect(await page.getByText('Protected Dashboard', { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => ({
        localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
        sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
      })))
        .toEqual({ localStorage: {}, sessionStorage: {} })
    } finally {
      await browserContext.close()
    }
  }, 60_000)

  it('rejects wrong, expired, and replayed handoffs without leaking them into Dashboard state', async () => {
    runtimeNow = Date.now()
    const wrong = 'wrong_browser_handoff_value_12345678901234567890'
    const wrongContext = await browser.newContext()
    const wrongPage = await wrongContext.newPage()
    const wrongObserved = observe(wrongPage)
    try {
      await openBootstrap(navigation(wrong, runtimeNow + 60_000), wrongPage)
      expect(wrongPage.url()).toBe(`${origin}/_harness/handoff`)
      await assertRecovery(wrongPage, wrong, wrongObserved.consoleOutput)
      expect(await wrongPage.getByText('Protected Dashboard', { exact: true }).count()).toBe(0)
    } finally {
      await wrongContext.close()
    }

    runtimeNow = Date.now()
    const expired = auth.mintBrowserHandoff()
    const expiredContext = await browser.newContext()
    const expiredPage = await expiredContext.newPage()
    const expiredObserved = observe(expiredPage)
    try {
      await openBootstrap(navigation(expired.id, expired.expiresAt), expiredPage, () => { runtimeNow = expired.expiresAt })
      expect(expiredPage.url()).toBe(`${origin}/_harness/handoff`)
      await assertRecovery(expiredPage, expired.id, expiredObserved.consoleOutput)
      expect(await expiredPage.getByText('Protected Dashboard', { exact: true }).count()).toBe(0)
    } finally {
      await expiredContext.close()
    }

    runtimeNow = Date.now()
    const replayed = auth.mintBrowserHandoff()
    const acceptedContext = await browser.newContext()
    const acceptedPage = await acceptedContext.newPage()
    await openBootstrap(navigation(replayed.id, replayed.expiresAt), acceptedPage)
    await acceptedPage.getByText('Protected Dashboard', { exact: true }).waitFor()
    await acceptedContext.close()
    const replayContext = await browser.newContext()
    const replayPage = await replayContext.newPage()
    const replayObserved = observe(replayPage)
    try {
      await openBootstrap(navigation(replayed.id, replayed.expiresAt), replayPage)
      expect(replayPage.url()).toBe(`${origin}/_harness/handoff`)
      await assertRecovery(replayPage, replayed.id, replayObserved.consoleOutput)
      expect(await replayPage.getByText('Protected Dashboard', { exact: true }).count()).toBe(0)
    } finally {
      await replayContext.close()
    }
  }, 60_000)
})
