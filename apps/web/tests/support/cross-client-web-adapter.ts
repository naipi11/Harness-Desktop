/** App-owned Chromium adapter for the built authenticated Dashboard acceptance lane. */

import { constants } from 'node:fs'
import { access, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, BrowserContext, Page, Request } from 'playwright'
import type {
  DashboardAttachment,
  RuntimeClient,
} from '@harness-desktop/dsh-host-local-runtime'
import type {
  CrossClientAppAdapter,
  CrossClientAppContext,
  CrossClientAppHandle,
} from '@harness-desktop/dsh-cross-client-runtime'

const WEB_DIST_ENTRY = fileURLToPath(new URL('../../dist/index.html', import.meta.url))
const HANDOFF_PATH = '/_harness/handoff'
const require = createRequire(import.meta.url)
const RUNTIME_ENTRY = require.resolve('@harness-desktop/dsh-host-local-runtime')

type RuntimeApi = typeof import('@harness-desktop/dsh-host-local-runtime')

interface WebAdapterDependencies {
  requireWebDist(): Promise<void>
  loadRuntimeApi(): Promise<Pick<RuntimeApi, 'createRuntimeConnector'>>
}

/** Secret-free evidence returned after the browser has exercised the Dashboard. */
export interface WebHandoffAudit {
  readonly handoffPostCount: number
  readonly requestUrlsClean: boolean
  readonly requestHeadersClean: boolean
  readonly referrerClean: boolean
  readonly handoffOnlyInPostBody: boolean
  readonly finalUrlClean: boolean
  readonly finalDomClean: boolean
  readonly historyClean: boolean
  readonly localStorageClean: boolean
  readonly sessionStorageClean: boolean
  readonly consoleClean: boolean
  readonly sessionCookieProtected: boolean
  readonly consoleErrorCount: number
  readonly pageErrorCount: number
}

/** Live browser probe whose audit never returns handoff, cookie, storage, request, or console values. */
export interface WebDashboardProbe {
  readonly page: Page
  /** @returns token-free handoff, storage, history, and error evidence for the current page. */
  audit(): Promise<WebHandoffAudit>
}

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly postData: string | null
  readonly headers: Promise<Record<string, string> | undefined>
}

interface PageState {
  readonly href: string
  readonly referrer: string
  readonly html: string
  readonly localStorage: Record<string, string | null>
  readonly sessionStorage: Record<string, string | null>
}

type CloseStage = 'page' | 'browser-context' | 'dashboard' | 'runtime-client' | 'bootstrap-file'

class CrossClientWebAdapterError extends Error {
  constructor(message = 'The built Web acceptance adapter failed.') {
    super(message)
    this.name = 'CrossClientWebAdapterError'
  }
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function bootstrapDocument(origin: string, handoff: string): string {
  return '<!doctype html><html><body>'
    + `<form id="handoff" method="post" action="${htmlAttribute(`${origin}${HANDOFF_PATH}`)}">`
    + `<input type="hidden" name="handoff" value="${htmlAttribute(handoff)}">`
    + '</form></body></html>\n'
}

async function builtRuntimeApi(): Promise<RuntimeApi> {
  await access(RUNTIME_ENTRY, constants.R_OK)
  return import(pathToFileURL(RUNTIME_ENTRY).href) as Promise<RuntimeApi>
}

const DEFAULT_DEPENDENCIES: WebAdapterDependencies = {
  requireWebDist: () => access(WEB_DIST_ENTRY, constants.R_OK),
  loadRuntimeApi: builtRuntimeApi,
}

function containsPrivateValue(value: string, handoff: string, cookie: string | undefined): boolean {
  return value.includes(handoff) || (cookie !== undefined && value.includes(cookie))
}

function capturedRequest(request: Request): CapturedRequest {
  return {
    url: request.url(),
    method: request.method(),
    postData: request.postData(),
    headers: request.allHeaders().catch(() => undefined),
  }
}

function cleanHeaders(
  headers: readonly (Record<string, string> | undefined)[],
  handoff: string,
  cookie: string | undefined,
): boolean {
  return headers.every(row => row !== undefined && Object.entries(row).every(([name, value]) => {
    if (value.includes(handoff)) return false
    if (cookie === undefined || !value.includes(cookie)) return true
    return name.toLowerCase() === 'cookie'
  }))
}

function cleanReferrers(
  headers: readonly (Record<string, string> | undefined)[],
  referrer: string,
  origin: string,
  handoff: string,
  cookie: string | undefined,
): boolean {
  if (referrer !== '') return false
  return headers.every((row) => {
    const value = row?.referer ?? row?.referrer
    if (value === undefined) return true
    if (containsPrivateValue(value, handoff, cookie)) return false
    try {
      const parsed = new URL(value)
      return parsed.origin === origin && parsed.search === '' && parsed.hash === ''
    } catch {
      return false
    }
  })
}

function stableCloseError(stage: CloseStage): Error {
  return new Error(`cross-client Web cleanup failed at ${stage}`)
}

function closeResources(resources: {
  readonly page: () => Page | undefined
  readonly browserContext: () => BrowserContext | undefined
  readonly dashboard: () => DashboardAttachment | undefined
  readonly runtime: () => RuntimeClient | undefined
  readonly bootstrapPath: () => string | undefined
  readonly settled: Set<CloseStage>
}): () => Promise<void> {
  let closePromise: Promise<void> | undefined
  const closeStage = async (stage: CloseStage, action: () => Promise<void>, failures: Error[]): Promise<void> => {
    if (resources.settled.has(stage)) return
    try {
      await action()
      resources.settled.add(stage)
    } catch (_privateCloseFailure) {
      failures.push(stableCloseError(stage))
    }
  }
  const closeOnce = async (): Promise<void> => {
    const failures: Error[] = []
    const page = resources.page()
    if (page !== undefined) await closeStage('page', () => page.close(), failures)
    const browserContext = resources.browserContext()
    if (browserContext !== undefined) {
      await closeStage('browser-context', () => browserContext.close(), failures)
    }
    const dashboard = resources.dashboard()
    if (dashboard !== undefined) await closeStage('dashboard', () => dashboard.close(), failures)
    const runtime = resources.runtime()
    if (runtime !== undefined) await closeStage('runtime-client', () => runtime.close(), failures)
    const bootstrapPath = resources.bootstrapPath()
    if (bootstrapPath !== undefined) {
      await closeStage('bootstrap-file', () => unlink(bootstrapPath), failures)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Cross-client Web cleanup failed.')
  }
  return (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closePromise = closeOnce().catch((error: unknown) => {
      closePromise = undefined
      throw error
    })
    return closePromise
  }
}

async function retryOpenFailureCleanup(close: () => Promise<void>): Promise<Error | undefined> {
  let cleanupFailure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await close()
      return undefined
    } catch (error) {
      cleanupFailure = error
    }
  }
  if (cleanupFailure instanceof AggregateError) {
    return new AggregateError(
      (cleanupFailure.errors as Error[]).map(error => new Error(error.message)),
      cleanupFailure.message,
    )
  }
  return new Error('Cross-client Web cleanup failed.')
}

function createAudit(input: {
  readonly page: Page
  readonly browserContext: BrowserContext
  readonly origin: string
  readonly handoff: string
  readonly requests: readonly CapturedRequest[]
  readonly consoleRows: readonly { readonly type: string; readonly text: string }[]
  readonly pageErrors: readonly string[]
}): () => Promise<WebHandoffAudit> {
  return async (): Promise<WebHandoffAudit> => {
    const headers = await Promise.all(input.requests.map(request => request.headers))
    const cookies = await input.browserContext.cookies(input.origin)
    const sessionCookie = cookies.find(cookie => cookie.name === 'harness_session')
    const cookie = sessionCookie?.value
    const pageState = await input.page.evaluate<PageState>(() => ({
      href: location.href,
      referrer: document.referrer,
      html: document.documentElement.outerHTML,
      localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
      sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    }))
    const cdp = await input.browserContext.newCDPSession(input.page)
    let historyUrls: readonly string[] | undefined
    try {
      const result: unknown = await cdp.send('Page.getNavigationHistory')
      if (typeof result === 'object' && result !== null && 'entries' in result && Array.isArray(result.entries)) {
        const values = result.entries.map((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null || !('url' in entry) || typeof entry.url !== 'string') {
            return undefined
          }
          return entry.url
        })
        if (values.every((value): value is string => value !== undefined)) historyUrls = values
      }
    } finally {
      await cdp.detach()
    }
    const handoffRequests = input.requests.filter(request =>
      request.method === 'POST' && request.url === `${input.origin}${HANDOFF_PATH}`)
    const exactBody = new URLSearchParams({ handoff: input.handoff }).toString()
    const otherBodies = input.requests.filter(request => request !== handoffRequests[0])
      .map(request => request.postData ?? '')
    const serializedLocal = JSON.stringify(pageState.localStorage)
    const serializedSession = JSON.stringify(pageState.sessionStorage)
    const serializedConsole = input.consoleRows.map(row => row.text).join('\n')
    const historyClean = historyUrls !== undefined && historyUrls.length > 0
      && historyUrls.every(url => !containsPrivateValue(url, input.handoff, cookie))
    const handoffOnlyInPostBody = handoffRequests.length === 1
      && handoffRequests[0]?.postData === exactBody
      && otherBodies.every(body => !body.includes(input.handoff))
      && input.requests.every(request => !request.url.includes(input.handoff))
      && headers.every(row => row !== undefined && !JSON.stringify(row).includes(input.handoff))
      && !pageState.html.includes(input.handoff)
      && !serializedLocal.includes(input.handoff)
      && !serializedSession.includes(input.handoff)
      && !serializedConsole.includes(input.handoff)
      && historyClean
    return {
      handoffPostCount: handoffRequests.length,
      requestUrlsClean: input.requests.every(request =>
        !containsPrivateValue(request.url, input.handoff, cookie)),
      requestHeadersClean: cleanHeaders(headers, input.handoff, cookie),
      referrerClean: cleanReferrers(headers, pageState.referrer, input.origin, input.handoff, cookie),
      handoffOnlyInPostBody,
      finalUrlClean: pageState.href === `${input.origin}/`,
      finalDomClean: !containsPrivateValue(pageState.html, input.handoff, cookie),
      historyClean,
      localStorageClean: !containsPrivateValue(serializedLocal, input.handoff, cookie),
      sessionStorageClean: !containsPrivateValue(serializedSession, input.handoff, cookie),
      consoleClean: !containsPrivateValue(serializedConsole, input.handoff, cookie),
      sessionCookieProtected: sessionCookie !== undefined
        && sessionCookie.value.length > 0
        && sessionCookie.httpOnly
        && sessionCookie.sameSite === 'Strict'
        && sessionCookie.path === '/',
      consoleErrorCount: input.consoleRows.filter(row => row.type === 'error').length,
      pageErrorCount: input.pageErrors.length,
    }
  }
}

/**
 * Create the Host-side Web adapter for one caller-owned Chromium instance.
 * @param browser - browser whose isolated context belongs to the returned app handle.
 * @param dependencies - physical built-entry loaders overridden only by focused owner-failure tests.
 * @returns the fixture adapter and the latest live token-free Dashboard probe.
 */
export function createCrossClientWebAdapter(
  browser: Browser,
  dependencies: WebAdapterDependencies = DEFAULT_DEPENDENCIES,
): {
  readonly adapter: CrossClientAppAdapter
  readonly latest: () => WebDashboardProbe
} {
  let latestProbe: WebDashboardProbe | undefined
  return {
    latest(): WebDashboardProbe {
      if (latestProbe === undefined) throw new CrossClientWebAdapterError('No cross-client Web Dashboard is open.')
      return latestProbe
    },
    adapter: {
      async open(context: CrossClientAppContext): Promise<CrossClientAppHandle> {
        try {
          await dependencies.requireWebDist()
        } catch (_missingWebBuild) {
          throw new CrossClientWebAdapterError('built Web acceptance requires apps/web/dist; run pnpm run build first')
        }

        let runtime: RuntimeClient | undefined
        let dashboard: DashboardAttachment | undefined
        let browserContext: BrowserContext | undefined
        let page: Page | undefined
        let bootstrapPath: string | undefined
        const settled = new Set<CloseStage>()
        const close = closeResources({
          page: () => page,
          browserContext: () => browserContext,
          dashboard: () => dashboard,
          runtime: () => runtime,
          bootstrapPath: () => bootstrapPath,
          settled,
        })
        try {
          const runtimeApi = await dependencies.loadRuntimeApi()
          runtime = await runtimeApi.createRuntimeConnector({
            input: { env: { HARNESS_HOME: context.home }, homeDir: context.platformHome },
          }).connect({ start: false })
          const status = await runtime.status()
          if (status.state !== 'running') throw new CrossClientWebAdapterError()
          dashboard = await runtime.attachDashboard()
          const navigation = await dashboard.createBrowserHandoff()
          if (navigation.origin !== status.dashboardOrigin) throw new CrossClientWebAdapterError()
          browserContext = await browser.newContext({
            locale: 'en-US',
            viewport: { width: 1680, height: 1000 },
          })
          page = await browserContext.newPage()
          const requests: CapturedRequest[] = []
          const consoleRows: Array<{ type: string; text: string }> = []
          const pageErrors: string[] = []
          page.on('request', (request) => { requests.push(capturedRequest(request)) })
          page.on('console', (message) => { consoleRows.push({ type: message.type(), text: message.text() }) })
          page.on('pageerror', (error) => { pageErrors.push(String(error)) })
          bootstrapPath = join(context.platformHome, `.cross-client-web-${randomUUID()}.html`)
          await writeFile(bootstrapPath, bootstrapDocument(navigation.origin, navigation.handoff.id), {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          })
          await page.goto(pathToFileURL(bootstrapPath).href, { waitUntil: 'domcontentloaded' })
          await Promise.all([
            page.waitForURL(`${navigation.origin}/`, { waitUntil: 'domcontentloaded' }),
            page.locator('#handoff').evaluate((form: HTMLFormElement) => { form.submit() }),
          ])
          await page.locator('#root[data-harness-dashboard-ready="true"]').waitFor({ timeout: 30_000 })
          await page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 30_000 })
          await unlink(bootstrapPath)
          settled.add('bootstrap-file')

          latestProbe = {
            page,
            audit: createAudit({
              page,
              browserContext,
              origin: navigation.origin,
              handoff: navigation.handoff.id,
              requests,
              consoleRows,
              pageErrors,
            }),
          }
          return { close }
        } catch (_privateOpenFailure) {
          const openFailure = new CrossClientWebAdapterError()
          const cleanupFailure = await retryOpenFailureCleanup(close)
          if (cleanupFailure !== undefined) {
            throw new AggregateError(
              [openFailure, cleanupFailure],
              'Cross-client Web open and cleanup failed.',
            )
          }
          throw openFailure
        }
      },
    },
  }
}
