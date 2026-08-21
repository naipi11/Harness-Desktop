/** Real Chromium coverage for the authenticated EngineeringWorkbench component. */

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
import type { DashboardControlRequest, RuntimeClientId } from '../../../packages/host/local-runtime/src/runtime-client.ts'

let browser: Browser
let context: Context
let vite: ViteDevServer
let origin = ''
let auth: LocalDashboardAuth
const ENTRY_SOURCE = fileURLToPath(new URL('./dashboard-workbench-entry.ts', import.meta.url))

async function authenticatedPage(): Promise<{
  browserContext: BrowserContext
  page: Page
  errors: string[]
  failedUrls: string[]
}> {
  const browserContext = await browser.newContext()
  const page = await browserContext.newPage()
  const errors: string[] = []
  const failedUrls: string[] = []
  page.on('pageerror', (error) => { errors.push(String(error)) })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 400) failedUrls.push(`${String(response.status())} ${response.url()}`) })
  await page.addInitScript(() => {
    ;(globalThis as Record<string, unknown>).harnessDesktop = { projection: 'desktop-only-secret' }
    localStorage.setItem('harness-workbench', 'local-recovery-secret')
  })
  const handoff = auth.mintBrowserHandoff()
  await page.setContent(`<form id="handoff" method="post" action="${origin}/_harness/handoff"><input type="hidden" name="handoff" value="${handoff.id}"></form>`)
  await Promise.all([
    page.waitForURL(`${origin}/`),
    page.locator('#handoff').evaluate((form: HTMLFormElement) => { form.submit() }),
  ])
  return { browserContext, page, errors, failedUrls }
}

beforeAll(async () => {
  vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
    resolve: {
      alias: {
        '@harness-desktop/cordis': fileURLToPath(new URL('../../../vendor/cordis/src/index.ts', import.meta.url)),
        '@harness-desktop/dsh-client-web-react': fileURLToPath(new URL('../../../packages/client/web-react/lib/index.js', import.meta.url)),
      },
    },
    plugins: [{
      name: 'dashboard-workbench-entry', enforce: 'pre',
      resolveId(id) { return id === '@harness-desktop/dsh-client-web' ? ENTRY_SOURCE : undefined },
    }],
  })
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  origin = `http://127.0.0.1:${String(context.webServer.port)}`
  auth = new LocalDashboardAuth({ accessToken: 'dashboard-workbench-native-token', origin })
  const controlService = {
    sessions: undefined,
    async handleDashboard(owner: RuntimeClientId, request: DashboardControlRequest) {
      if (!owner.startsWith('dashboard-')) throw new Error('Dashboard owner was not authenticated')
      if (request.operation === 'observe-active-work') return { ownUiWork: ['runtime-work'] }
      if (request.operation === 'stop-own-ui-work') return { kind: 'stopped', work: ['runtime-work'] }
      return { kind: 'not-needed' }
    },
  } as unknown as RuntimeControlService
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext: Context) { mountLocalControlRoutes(routeContext, { auth, controlService }) },
  }).await()
  context.webServer.registerFallback((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><div id="root"></div><script type="module" src="/src/main.ts"></script>')
      return
    }
    vite.middlewares(request, response, () => { response.writeHead(404); response.end('not found') })
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await vite?.close()
  await context?.fiber.dispose()
})

describe('authenticated engineering workbench', () => {
  it('renders five projections and restores Dashboard chrome without reconnecting', async () => {
    const { browserContext, page, errors, failedUrls } = await authenticatedPage()
    try {
      await expect.poll(() => page.getByRole('region', { name: 'Engineering workbench' }).count(), {
        timeout: 15_000,
        message: `Workbench failed to mount: ${await page.locator('body').innerText()} ${errors.join(' ')} ${failedUrls.join(' ')}`,
      }).toBe(1)
      expect(await page.getByRole('tab').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-workbench-panel'))))
        .toEqual(['files', 'diff', 'terminal', 'artifacts', 'tasks'])
      await page.getByText('src', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open src' }).click()
      await page.getByRole('tab', { name: 'Diff' }).click()
      await page.getByText('new', { exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Terminal' }).click()
      await page.getByText('48 tests passed', { exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Artifacts' }).click()
      await page.getByText('C:/workspace/src/app.ts', { exact: true }).waitFor()
      await page.getByRole('tab', { name: 'Tasks' }).click()
      await page.getByText('Ship workbench', { exact: true }).waitFor()
      const connectionRequests = (): Promise<number> => page.evaluate(() => performance.getEntriesByType('resource')
        .filter(entry => entry.name.includes('/api/events.mux')).length)
      const requestsBeforeFocus = await connectionRequests()
      await page.getByRole('button', { name: 'Enter focus mode' }).click()
      expect(await page.locator('[data-workbench-dashboard-chrome]').count()).toBe(0)
      expect(await page.getByText('Authenticated workbench', { exact: true }).count()).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Exit focus mode' }).click()
      expect(await page.locator('[data-workbench-dashboard-chrome]').count()).toBe(1)
      expect(await connectionRequests()).toBe(requestsBeforeFocus)
      const evidence = await page.evaluate(() => ({
        actions: (globalThis as Record<string, unknown>).__WORKBENCH_ACTIONS__,
        text: document.querySelector('[aria-label="Engineering workbench"]')?.textContent,
      }))
      expect(evidence.actions).toContainEqual({ method: 'openPath', args: ['C:/workspace/src'] })
      expect(evidence.text).not.toContain('desktop-only-secret')
      expect(evidence.text).not.toContain('local-recovery-secret')
    } finally {
      await browserContext.close()
    }
  })
})
