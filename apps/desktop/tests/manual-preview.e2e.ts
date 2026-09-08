/** Cold-start acceptance for an explicitly supplied policy-less Windows preview executable. */

import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const executable = process.env.DSH_MANUAL_DESKTOP_EXECUTABLE

test('cold boots a packaged manual-update preview and opens settings without a source Runtime', async ({}, testInfo) => {
  test.skip(executable === undefined, 'Requires an explicitly supplied installed or unpacked preview executable')
  if (executable === undefined) throw new Error('manual preview executable was not supplied')
  test.setTimeout(240_000)
  const root = await mkdtemp(join(tmpdir(), 'harness-manual-preview-'))
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  await mkdir(profile)
  await mkdir(home)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^HARNESS_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$/iu.test(name)))
  const application = await electron.launch({
    executablePath: executable,
    args: ['--lang=en-US', `--user-data-dir=${join(profile, 'electron')}`],
    cwd: root,
    timeout: 120_000,
    env: {
      ...environment,
      HARNESS_HOME: home,
      HOME: profile,
      USERPROFILE: profile,
      APPDATA: join(profile, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(profile, 'AppData', 'Local'),
      DSH_TELEMETRY_DISABLED: '1',
    },
  })
  try {
    const identity = await application.evaluate(({ app }) => ({
      executable: process.execPath, version: app.getVersion(), packaged: app.isPackaged,
    }))
    expect(resolve(identity.executable).toLowerCase()).toBe(resolve(executable).toLowerCase())
    expect(identity.packaged).toBe(true)
    expect(identity.version).toBe('1.0.1')
    await expect(readFile(join(dirname(executable), 'resources', 'update-policy.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const page = await application.firstWindow()
    await expect(page.getByRole('region', { name: 'Engineering workbench' })).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
    const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true })
    await expect(notice).toBeVisible()
    await notice.click()
    await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true })
    await page.locator('button[aria-haspopup="dialog"][aria-expanded="false"]').click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'true')
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await expect(settings.getByText('Enter your API keys to use models from the following providers.')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await testInfo.attach('packaged-identity', { body: JSON.stringify(identity), contentType: 'application/json' })
  } finally {
    await application.close()
    await expect.poll(async () => {
      try {
        await readFile(join(home, 'runtime-endpoint.json'))
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
        throw error
      }
    }, { timeout: 90_000 }).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
