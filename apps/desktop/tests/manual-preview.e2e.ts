/** Manual packaged acceptance: on Windows, select the printed folder in the native dialog. */

import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const executable = process.env.DSH_MANUAL_DESKTOP_EXECUTABLE

test('cold boots a packaged manual-update preview, selects a workspace, and opens settings without a source Runtime', async ({}, testInfo) => {
  test.skip(executable === undefined, 'Requires an explicitly supplied installed or unpacked preview executable')
  if (executable === undefined) throw new Error('manual preview executable was not supplied')
  test.setTimeout(360_000)
  const root = await mkdtemp(join(tmpdir(), 'harness-manual-preview-'))
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  await mkdir(profile)
  await mkdir(home)
  await Promise.all(['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']
    .map(name => mkdir(join(profile, name))))
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
    expect(identity.version).toBe('1.0.3')
    await expect(readFile(join(dirname(executable), 'resources', 'update-policy.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const page = await application.firstWindow()
    await expect(page.getByRole('region', { name: 'Engineering workbench' })).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('#root')).toHaveAttribute('data-harness-dashboard-ready', 'true')
    const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true })
    await expect(notice).toBeVisible()
    await notice.click()
    const onboarding = page.getByRole('dialog', { name: 'Add an API key to get started' })
    await onboarding.getByRole('button', { name: 'Configure later', exact: true }).click()
    await expect(onboarding).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true })
    if (process.platform === 'win32') {
      const workspaceName = '选择-workspace'
      const workspace = join(root, workspaceName)
      await mkdir(workspace)
      const chooser = page.getByRole('button', { name: 'Choose workspace', exact: true })
      await chooser.click()
      const request = { workspace, executable, desktopPid: await application.evaluate(() => process.pid) }
      await writeFile(testInfo.outputPath('native-picker-request.json'), JSON.stringify(request))
      console.log(`Native picker: select ${workspace}`)
      await expect(chooser).toContainText(workspaceName, { timeout: 180_000 })
      await expect(page.getByRole('dialog', { name: 'Cannot open folder' })).toBeHidden()
      const stored = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8')) as {
        tables: { workspaces: Record<string, { path: string; sessionIds: string[] }> }
      }
      const registered = Object.values(stored.tables.workspaces).find(item =>
        resolve(item.path).toLowerCase() === resolve(workspace).toLowerCase())
      expect(registered?.sessionIds.length).toBeGreaterThan(0)
      await testInfo.attach('workspace-adoption', {
        body: JSON.stringify({ exactPathMatched: registered !== undefined, sessionCreated: registered!.sessionIds.length > 0 }),
        contentType: 'application/json',
      })
      await page.reload()
      await expect(chooser).toContainText(workspaceName, { timeout: 30_000 })
      await page.screenshot({ path: testInfo.outputPath('workspace-selected.png'), fullPage: true })
    }
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
