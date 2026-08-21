/** Real-browser readiness evidence at the cookie-authenticated Dashboard entry. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { LocalDashboardAuth } from '../../../packages/host/local-runtime/src/auth.ts'
import { mountLocalControlRoutes } from '../../../packages/host/local-runtime/src/control-routes.ts'
import type { RuntimeControlService } from '../../../packages/host/local-runtime/src/control-service.ts'

const RECOVERY = 'Dashboard connection expired. Run harness web to reconnect.'
let browser: Browser
let context: Context
let vite: ViteDevServer
let origin = ''
let auth: LocalDashboardAuth

async function authenticatedPage(failedBoot = false): Promise<{ browserContext: BrowserContext; page: Page }> {
  const browserContext = await browser.newContext()
  const page = await browserContext.newPage()
  if (failedBoot) {
    await page.addInitScript(() => {
      ;(globalThis as Record<string, unknown>).__HARNESS_TEST_WEB_BOOT_FAIL__ = true
    })
  }
  const handoff = auth.mintBrowserHandoff()
  await page.setContent(
    `<form id="handoff" method="post" action="${origin}/_harness/handoff">`
      + `<input type="hidden" name="handoff" value="${handoff.id}"></form>`,
  )
  await Promise.all([
    page.waitForURL(`${origin}/`),
    page.locator('#handoff').evaluate((form: HTMLFormElement) => { form.submit() }),
  ])
  return { browserContext, page }
}

beforeAll(async () => {
  vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    plugins: [{
      name: 'dashboard-ready-entry-stub',
      enforce: 'pre',
      resolveId(id) { return id === '@harness-desktop/dsh-client-web' ? '\0dashboard-ready-stub' : undefined },
      load(id) {
        if (id !== '\0dashboard-ready-stub') return undefined
        return `export class AppWebEntry {
          constructor(root) { this.root = root }
          async run() {
            if (globalThis.__HARNESS_TEST_WEB_BOOT_FAIL__ === true) {
              this.root.textContent = 'Failed to load plugins'
              return false
            }
            this.root.textContent = 'Protected Dashboard'
            return true
          }
        }`
      },
    }],
  })
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  origin = `http://127.0.0.1:${String(context.webServer.port)}`
  auth = new LocalDashboardAuth({ accessToken: 'dashboard-ready-native-token', origin })
  const controlService = {
    sessions: undefined,
    async handleDashboard() { return { kind: 'not-needed' } },
  } as unknown as RuntimeControlService
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext: Context) {
      mountLocalControlRoutes(routeContext, { auth, controlService })
    },
  }).await()
  context.webServer.registerFallback((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/') {
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
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  await context?.fiber.dispose()
})

describe('Dashboard authenticated ready marker', () => {
  it('appears only after cookie-authenticated application boot and carries no private fields', async () => {
    const { browserContext, page } = await authenticatedPage()
    try {
      await page.getByText('Protected Dashboard', { exact: true }).waitFor()
      const root = page.locator('#root')
      await expect.poll(() => root.getAttribute('data-harness-dashboard-ready')).toBe('true')
      expect(await root.evaluate(element => [...element.attributes].map(attribute => [attribute.name, attribute.value])))
        .toEqual([['id', 'root'], ['data-harness-dashboard-ready', 'true']])
      expect(await root.evaluate(element => element.outerHTML)).not.toMatch(
        /origin|handoff|cookie|token|credential|path|process|session/iu,
      )
    } finally {
      await browserContext.close()
    }
  })

  it('leaves readiness absent for an unauthenticated request', async () => {
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    try {
      await page.goto(origin)
      await page.getByText(RECOVERY, { exact: true }).waitFor()
      expect(await page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBeNull()
    } finally {
      await browserContext.close()
    }
  })

  it('preserves the plugin failure report without readiness', async () => {
    const { browserContext, page } = await authenticatedPage(true)
    try {
      await page.getByText('Failed to load plugins', { exact: true }).waitFor()
      expect(await page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBeNull()
    } finally {
      await browserContext.close()
    }
  })
})
