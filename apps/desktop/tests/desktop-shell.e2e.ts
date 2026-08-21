import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

test('launches the built Desktop shell through its sandboxed preload bridge', async () => {
  let application: ElectronApplication | undefined

  try {
    await access(mainEntry)
    application = await electron.launch({ args: [mainEntry] })
    const page = await application.firstWindow()

    await expect(page.getByRole('heading', { name: 'Harness Desktop' })).toBeVisible()
    await expect(page.getByText('Open a workspace to begin.')).toBeVisible()
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)
    await expect(page).toHaveTitle('Harness Desktop')

    expect(await page.evaluate(() => typeof Reflect.get(window, 'require'))).toBe('undefined')
    expect(await page.evaluate(() => ({
      version: window.harnessDesktop.version,
      keys: Object.keys(window.harnessDesktop).sort(),
    }))).toEqual({
      version: 1,
      keys: [
        'copyRecoveryDiagnostic',
        'openExternalLink',
        'readRecoveryDiagnostic',
        'retryDashboard',
        'selectFolder',
        'showNotification',
        'version',
      ],
    })
  } finally {
    await application?.close()
  }
})
