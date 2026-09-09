/** Headless browser acceptance against the real built canonical Runtime, without a model call. */
import { expect, it } from 'vitest'
import { chromium } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mintBrowserCookie, runtimeRpc } from './runtime-process-harness.ts'

it.skipIf(process.platform !== 'win32')(
  'renders Chinese files, local commands, and writable credentials in the built Windows Dashboard',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-workbench-ui-'))
    const entry = pathToFileURL(join(process.cwd(), 'packages/host/local-runtime/lib/runtime.js')).href
    const { startCanonicalRuntime } = await import(entry) as {
      startCanonicalRuntime(config: {
        harnessHome: { home: string; path(...parts: string[]): string }
        idleTimeoutMs: number
      }): Promise<{ dispose(): Promise<void> }>
    }
    const runtime = await startCanonicalRuntime({
      harnessHome: { home: root, path: (...parts) => join(root, ...parts) },
      idleTimeoutMs: 120_000,
    })
    const browser = await chromium.launch({ headless: true })
    let cleanupCredential: (() => Promise<unknown>) | undefined
    try {
      const endpoint = JSON.parse(await readFile(join(root, 'runtime-endpoint.json'), 'utf8')) as { port: number; accessToken: string }
      const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
      cleanupCredential = () => runtimeRpc(endpoint.port, cookie, 'credentials.unset', { ref: 'DEEPSEEK_API_KEY' })
      const path = join(root, 'workspace-中文')
      await mkdir(path)
      await writeFile(join(path, 'visible.txt'), 'fixture')
      const { workspace } = await runtimeRpc<{ workspace: { workspaceId: string } }>(endpoint.port, cookie, 'workspace.create', { path })
      await runtimeRpc(endpoint.port, cookie, 'session.create', { workspaceId: workspace.workspaceId })
      await runtimeRpc(endpoint.port, cookie, 'settings.update', { ns: 'locale', patch: { preference: 'zh' } })
      const origin = `http://127.0.0.1:${endpoint.port}`
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
      const separator = cookie.indexOf('=')
      await context.addCookies([{
        name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin,
        httpOnly: true, sameSite: 'Strict',
      }])
      const page = await context.newPage()
      await page.goto(origin)
      await page.locator('#root[data-harness-dashboard-ready="true"]').waitFor({ timeout: 60_000 })
      const notice = page.getByRole('dialog').getByRole('button', { name: '继续', exact: true })
      await notice.waitFor({ timeout: 15_000 })
      await notice.click()
      await notice.waitFor({ state: 'hidden' })
      const onboarding = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
      await onboarding.getByRole('button', { name: '稍后配置', exact: true }).click()
      await onboarding.waitFor({ state: 'hidden' })
      await page.getByRole('tab', { name: '文件', exact: true }).click()
      await page.getByRole('button', { name: 'visible.txt', exact: true }).waitFor({ timeout: 20_000 })
      const panelWidth = await page.getByRole('tabpanel').evaluate(node => node.getBoundingClientRect().width)
      expect(panelWidth).toBeLessThanOrEqual(320)
      const workbenchFont = await page.getByRole('region', { name: '工程工作台' })
        .evaluate(node => getComputedStyle(node).fontFamily)
      expect(workbenchFont).not.toContain('Times New Roman')
      await page.getByRole('tab', { name: '终端', exact: true }).click()
      await page.getByRole('button', { name: '启动终端', exact: true }).click()
      const input = page.getByRole('textbox', { name: '终端命令' })
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      await input.fill(
        process.platform === 'win32'
          ? "Write-Output ('BROWSER_' + 'EXECUTED')"
          : "printf '%s%s\\n' 'BROWSER_' 'EXECUTED'",
      )
      await page.getByRole('button', { name: '运行命令', exact: true }).click()
      await expect.poll(() => page.getByRole('log').textContent(), { timeout: 15_000 })
        .toContain('BROWSER_EXECUTED')
      expect(await page.getByRole('tabpanel').ariaSnapshot()).toBe([
        '- tabpanel:',
        '  - paragraph: 命令终端 · 以你的权限在本机运行，不发送给 AI。不支持全屏或交互式程序；关闭终端会停止正在运行的命令。',
        '  - button "启动终端"',
        '  - button "关闭终端"',
        '  - log: BROWSER_EXECUTED',
        '  - text: 终端命令',
        '  - textbox "终端命令"',
        '  - button "运行命令" [disabled]',
      ].join('\n'))
      const evidence = process.env.DSH_WORKBENCH_EVIDENCE
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true })
        await page.screenshot({ path: join(evidence, 'workbench-terminal-zh.png') })
        await writeFile(join(evidence, 'workbench.expected.md'), await page.getByRole('tabpanel').ariaSnapshot())
      }
      await page.getByRole('button', { name: '关闭终端', exact: true }).click()
      await page.locator('button[aria-haspopup="dialog"][aria-expanded="false"]').click()
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('button', { name: '模型', exact: true }).click()
      const password = settings.locator('input[type="password"]').first()
      await password.waitFor()
      expect(await password.isEnabled()).toBe(true)
      expect(await password.inputValue()).toBe('')
      await password.fill('synthetic-browser-test-key')
      await settings.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(async () => {
        const result = await runtimeRpc<{
          credentials: Record<string, { configured: boolean; writable: boolean }>
        }>(endpoint.port, cookie, 'credentials.describe', { refs: ['DEEPSEEK_API_KEY'] })
        return result.credentials['DEEPSEEK_API_KEY']
      }).toEqual({ configured: true, writable: true, source: 'platform' })
      await runtimeRpc(endpoint.port, cookie, 'credentials.unset', { ref: 'DEEPSEEK_API_KEY' })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '收起工具面板' }).click()
      expect(await page.getByRole('tabpanel').isVisible()).toBe(false)
      await runtimeRpc(endpoint.port, cookie, 'settings.update', { ns: 'locale', patch: { preference: 'en' } })
      await page.getByRole('tab', { name: 'Files', exact: true }).waitFor()
      await page.reload()
      await page.getByRole('tab', { name: 'Files', exact: true }).waitFor()
    } finally {
      try { await cleanupCredential?.() }
      finally { await browser.close(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
    }
  }, 120_000,
)
