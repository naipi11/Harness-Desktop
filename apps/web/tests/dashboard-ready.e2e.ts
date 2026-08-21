/** Real-browser readiness evidence through the shipped authenticated Dashboard graph. */

import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const RECOVERY = 'Dashboard connection expired. Run harness web to reconnect.'
let browser: Browser
let scaffold: WebScaffold

async function authenticatedPage(blockPlugins = false): Promise<{ browserContext: BrowserContext; page: Page }> {
  const handoff = scaffold.mintDashboardHandoff?.()
  if (handoff === undefined) throw new Error('authenticated Web scaffold did not expose a Dashboard handoff')
  const browserContext = await browser.newContext()
  const page = await browserContext.newPage()
  await page.addInitScript(() => {
    const observations: Array<{ value: string | null; workbench: boolean }> = []
    ;(globalThis as Record<string, unknown>).__HARNESS_READY_OBSERVATIONS__ = observations
    new MutationObserver(() => {
      const root = document.getElementById('root')
      if (root === null) return
      observations.push({
        value: root.getAttribute('data-harness-dashboard-ready'),
        workbench: root.querySelector('[aria-label="Engineering workbench"]') !== null,
      })
    }).observe(document, { subtree: true, childList: true, attributes: true })
  })
  if (blockPlugins) await page.route(/\/plugins\/.*client\.js(?:\?.*)?$/u, route => route.abort())
  await page.setContent(
    `<form id="handoff" method="post" action="${scaffold.baseUrl}/_harness/handoff">`
      + `<input type="hidden" name="handoff" value="${handoff.id}"></form>`,
  )
  await Promise.all([
    page.waitForURL(`${scaffold.baseUrl}/`),
    page.locator('#handoff').evaluate((form: HTMLFormElement) => { form.submit() }),
  ])
  return { browserContext, page }
}

beforeAll(async () => {
  scaffold = await launchWebScaffold({ authenticatedDashboard: {} })
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

describe('Dashboard authenticated ready marker', () => {
  it('appears only after the real workbench settles behind an HttpOnly cookie', async () => {
    const { browserContext, page } = await authenticatedPage()
    try {
      await page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 30_000 })
      const root = page.locator('#root')
      await expect.poll(() => root.getAttribute('data-harness-dashboard-ready')).toBe('true')
      const observations = await page.evaluate(() =>
        (globalThis as Record<string, unknown>).__HARNESS_READY_OBSERVATIONS__) as Array<{
        value: string | null
        workbench: boolean
      }>
      expect(observations).toContainEqual({ value: 'true', workbench: true })
      expect(await root.evaluate(element => [...element.attributes].map(attribute => [attribute.name, attribute.value])))
        .toEqual([['id', 'root'], ['data-harness-dashboard-ready', 'true']])
      const cookie = (await browserContext.cookies(scaffold.baseUrl)).find(value => value.name === 'harness_session')
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
      expect(await page.evaluate(() => document.cookie)).toBe('')
    } finally {
      await browserContext.close()
    }
  })

  it('leaves readiness absent for an unauthenticated request', async () => {
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    try {
      await page.goto(scaffold.baseUrl)
      await page.getByText(RECOVERY, { exact: true }).waitFor()
      expect(await page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBeNull()
    } finally {
      await browserContext.close()
    }
  })

  it('preserves the real plugin failure report without readiness', async () => {
    const { browserContext, page } = await authenticatedPage(true)
    try {
      await page.getByText('Failed to load plugins', { exact: false }).first().waitFor({ timeout: 30_000 })
      expect(await page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBeNull()
      expect(await page.getByRole('region', { name: 'Engineering workbench' }).count()).toBe(0)
    } finally {
      await browserContext.close()
    }
  })
})
