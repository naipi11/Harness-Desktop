/** Real Electron acceptance for the Runtime-hosted authenticated Dashboard. */

import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:net'
import { launchDesktopRuntimeFixture, seedDesktopWorkspace } from './support/runtime-fixture.ts'

async function foreignLoopbackServer(): Promise<{
  readonly url: string
  readonly connections: () => number
  readonly close: () => Promise<void>
}> {
  let connections = 0
  const server: Server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('foreign WebSocket fixture has no port')
  return {
    url: `ws://127.0.0.1:${String(address.port)}/events`,
    connections: () => connections,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

test('boots the real authenticated Dashboard without exposing bootstrap authority', async () => {
  const fixture = await launchDesktopRuntimeFixture()
  const workspace = await seedDesktopWorkspace(fixture.runtime)
  try {
    const page = fixture.page
    await page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 45_000 }).catch(async (error: unknown) => {
      const boot = await page.evaluate<unknown>(() =>
        (window as unknown as Record<string, unknown>).__DSH_BOOT__)
      throw new Error(`Dashboard did not boot. body=${JSON.stringify(await page.locator('body').innerText())} boot=${JSON.stringify(boot)} renderer=${JSON.stringify(fixture.rendererErrors)} runtime=${fixture.runtime.stderr()}`, { cause: error })
    })
    await expect(page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
    await expect.poll(() => fixture.desktopOutput().split(/\r?\n/u).filter(
      line => line === '{"kind":"desktop-dashboard-ready","version":1}',
    ).length).toBe(1)
    const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
    if (await notice.count()) await notice.click()
    await expect(page.getByRole('button', { name: 'Choose workspace', exact: true })).toContainText('desktop-workspace')
    await expect(page.getByRole('region', { name: 'Engineering workbench' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Diff' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Terminal' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Artifacts' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Tasks' })).toBeVisible()

    const address = page.url()
    expect(address).toBe(`${fixture.origin}/`)
    const historyState = JSON.stringify(await page.evaluate<unknown>(() =>
      (history as unknown as { readonly state: unknown }).state))
    expect(await page.evaluate(() => ({
      require: typeof Reflect.get(window, 'require'),
      process: typeof Reflect.get(globalThis, 'process'),
      Buffer: typeof Reflect.get(globalThis, 'Buffer'),
      token: typeof Reflect.get(window.harnessDesktop, 'token'),
      bridge: Object.keys(window.harnessDesktop).sort(),
    }))).toEqual({
      require: 'undefined',
      process: 'undefined',
      Buffer: 'undefined',
      token: 'undefined',
      bridge: [
        'copyRecoveryDiagnostic',
        'openExternalLink',
        'readRecoveryDiagnostic',
        'retryDashboard',
        'selectFolder',
        'showNotification',
        'version',
      ],
    })
    const browserStorage = JSON.stringify(await page.evaluate(() => {
      const values = (storage: Storage): Record<string, string | null> => Object.fromEntries(
        Array.from({ length: storage.length }, (_, index) => storage.key(index))
          .filter((key): key is string => key !== null)
          .map(key => [key, storage.getItem(key)]),
      )
      return { local: values(localStorage), session: values(sessionStorage), cookie: document.cookie }
    }))

    const handoffs = fixture.requests.filter(request => request.url === `${fixture.origin}/_harness/handoff`)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]).toMatchObject({ method: 'POST', referrer: undefined })
    expect(handoffs[0]!.body).toMatch(/^handoff=[A-Za-z0-9_-]{32,}$/)
    const handoff = new URLSearchParams(handoffs[0]!.body ?? '').get('handoff')
    expect(handoff).toBeTruthy()
    const handoffResponse = fixture.responses.find(response => response.url === `${fixture.origin}/_harness/handoff`)
    expect(handoffResponse?.status).toBe(303)
    expect(handoffResponse?.headers).not.toHaveProperty('access-control-allow-origin')
    expect(address).not.toContain(handoff!)
    expect(historyState).not.toContain(handoff!)
    expect(browserStorage).not.toContain(handoff!)
    for (const request of fixture.requests) {
      expect(request.url).not.toContain(handoff!)
      expect(request.referrer ?? '').not.toContain(handoff!)
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === 'cookie') continue
        expect(value).not.toContain(handoff!)
      }
      if (request !== handoffs[0]) expect(request.body ?? '').not.toContain(handoff!)
    }
    expect(fixture.runtime.stderr()).not.toContain(handoff!)
    expect(JSON.stringify(fixture.rendererErrors)).not.toContain(handoff!)

    const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy') ?? '')
    expect(csp).not.toMatch(/(?:^|\s)ws:(?:\s|;|$)/u)
    expect(csp).toContain(`ws://127.0.0.1:${new URL(fixture.origin).port}`)
    const foreign = await foreignLoopbackServer()
    try {
      expect(await page.evaluate(async (url: string) => await new Promise<string>((resolve) => {
        const socket = new WebSocket(url)
        socket.addEventListener('open', () => { resolve('opened') })
        socket.addEventListener('error', () => { resolve('denied') })
      }), foreign.url)).toBe('denied')
      expect(foreign.connections()).toBe(0)
    } finally {
      await foreign.close()
    }

    await expect(page.getByRole('button', { name: /Select model/u })).toBeVisible()
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await expect(page.getByRole('tree', { name: 'Sessions' })).toBeVisible()
    await page.locator('[role="treeitem"]').nth(2).click()
    await expect(page.getByText('DONE', { exact: true })).toBeVisible()
    await expect(page.locator('body')).toContainText('Bash')
    await expect(page.locator('body')).toContainText('pnpm test')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'true')
    await settings.getByRole('button', { name: 'Models' }).click()
    await expect(settings.getByText('Enter your API keys to use models from the following providers.')).toBeVisible()
    await expect(settings.getByRole('textbox', { name: 'API key' }))
      .toHaveAttribute('placeholder', 'Provided by the launch environment (read-only)')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const directoryDialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await directoryDialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = directoryDialog.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(workspace)
    await pathInput.press('Enter')
    await directoryDialog.getByRole('button', { name: 'Open', exact: true }).click()
    await directoryDialog.waitFor({ state: 'hidden' })
    await expect(page.getByRole('button', { name: 'Choose workspace', exact: true })).toContainText('picked-workspace')
  } finally {
    await fixture.close()
  }
})
