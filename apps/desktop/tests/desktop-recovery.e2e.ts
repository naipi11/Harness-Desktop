/** Real Electron recovery and navigation-policy acceptance. */

import { expect, test } from '@playwright/test'
import { launchDesktopFailureFixture } from './support/runtime-fixture.ts'

test('recovers only after a user retry and rejects renderer-created navigation', async () => {
  const fixture = await launchDesktopFailureFixture()
  try {
    const page = fixture.page
    await expect(page.getByRole('heading', { name: 'Runtime unavailable' })).toBeVisible({ timeout: 45_000 })
    expect(fixture.requests.filter(request => request.url.endsWith('/_harness/handoff'))).toHaveLength(0)
    const firstDiagnostic = (await page.locator('code').allTextContents()).at(-1)
    expect(firstDiagnostic).toBeTruthy()

    await page.getByRole('button', { name: 'Retry Dashboard' }).click()
    await expect.poll(async () => (await page.locator('code').allTextContents()).at(-1), { timeout: 45_000 })
      .not.toBe(firstDiagnostic)

    await fixture.application.evaluate(({ clipboard }) => {
      clipboard.writeText = (text) => {
        ;(globalThis as { __HARNESS_CLIPBOARD_TEXT__?: string }).__HARNESS_CLIPBOARD_TEXT__ = text
      }
    })
    await page.getByRole('button', { name: 'Copy diagnostic' }).click()
    await expect(page.getByRole('status')).toHaveText('Diagnostic copied')
    const copied = await fixture.application.evaluate(() =>
      (globalThis as { __HARNESS_CLIPBOARD_TEXT__?: string }).__HARNESS_CLIPBOARD_TEXT__ ?? '')
    expect(copied).toContain('Diagnostic ID:')
    expect(copied).not.toMatch(/runtime-endpoint|accessToken|HARNESS_HOME/i)

    await fixture.releaseStartLock()
    const origin = await fixture.startRuntime()
    await page.getByRole('button', { name: 'Retry Dashboard' }).click()
    await page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 })
    expect(fixture.requests.filter(request => request.url.endsWith('/_harness/handoff'))).toHaveLength(1)

    const child = await page.evaluate(() => window.open('https://github.com/deepseek-ai/deepseek-harness'))
    expect(child).toBeNull()
    expect(fixture.application.windows()).toHaveLength(1)
    await page.evaluate(() => { location.href = 'http://localhost:43123/' })
    await expect.poll(() => page.url()).toBe(`${origin}/`)

    await fixture.application.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        ;(globalThis as { __HARNESS_EXTERNAL_URL__?: string }).__HARNESS_EXTERNAL_URL__ = url
      }
    })
    await expect(page.evaluate(() => window.harnessDesktop.openExternalLink('http://github.com')))
      .rejects.toThrow('desktop:external-link-denied')
    await expect(page.evaluate(() => window.harnessDesktop.openExternalLink('https://github.com/deepseek-ai/deepseek-harness')))
      .resolves.toBeUndefined()
    expect(await fixture.application.evaluate(() =>
      (globalThis as { __HARNESS_EXTERNAL_URL__?: string }).__HARNESS_EXTERNAL_URL__))
      .toBe('https://github.com/deepseek-ai/deepseek-harness')
  } finally {
    await fixture.close()
  }
})
