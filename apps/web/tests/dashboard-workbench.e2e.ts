/** Real Chromium coverage for the shipped authenticated Engineering Workbench graph. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@harness-desktop/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@harness-desktop/dsh-session'
import type {} from '@harness-desktop/dsh-tool-todo'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'

let browser: Browser
let scaffold: WebScaffold
const SESSION_ID = 'authenticated-workbench-session'
const TERMINAL_FOLLOWUP = 'Run the terminal follow-up.'
const COMPLETE_TASK_PROMPT = 'Mark the task "Ship workbench" completed with todo_write and preserve every other task.'

function workbenchFixture(): string {
  const session = Session.create(SessionId('authenticated-workbench-source'))
  const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Prepare the workbench evidence.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Authenticated workbench', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('todo/write', { todos: [{ content: 'Ship workbench', status: 'in_progress' }] })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = [
    {
      id: CallId('workbench-edit'), name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/app.ts', old_string: 'old', new_string: 'new' }),
      result: 'Updated src/app.ts',
    },
    {
      id: CallId('workbench-shell'), name: shellTool,
      arguments: JSON.stringify({ command: 'pnpm test', description: 'Run focused tests' }),
      result: '48 tests passed\n[exit code: 0]',
    },
    {
      id: CallId('workbench-write'), name: 'write',
      arguments: JSON.stringify({ file_path: 'artifact.txt', content: 'artifact\n' }),
      result: 'Created artifact.txt',
    },
  ]
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: calls.map(call => ({ type: 'tool-call' as const, id: call.id, name: call.name, arguments: call.arguments })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.id, content: [{ type: 'text', text: call.result }], isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Workbench artifacts are ready.' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

async function authenticatedPage(): Promise<{ browserContext: BrowserContext; page: Page }> {
  const handoff = scaffold.mintDashboardHandoff?.()
  if (handoff === undefined) throw new Error('authenticated Web scaffold did not expose a Dashboard handoff')
  const browserContext = await browser.newContext()
  const page = await browserContext.newPage()
  await page.addInitScript(() => {
    ;(globalThis as Record<string, unknown>).harnessDesktop = { projection: 'desktop-only-secret' }
    localStorage.setItem('harness-workbench', 'local-recovery-secret')
  })
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
  scaffold = await launchWebScaffold({ authenticatedDashboard: { activeWork: ['runtime-work'] } })
  await mkdir(join(scaffold.workspaceCwd, 'src'), { recursive: true })
  await writeFile(join(scaffold.workspaceCwd, 'src', 'app.ts'), 'new\n')
  await seedSession(scaffold, workbenchFixture(), SESSION_ID)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

describe('authenticated engineering workbench', () => {
  it('drives all five shipped panels, active-work control, and focus without reconnecting', async () => {
    const { browserContext, page } = await authenticatedPage()
    const tripwire = watchConsole(page)
    const muxRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/events.mux')) muxRequests.push(request.url())
    })
    try {
      const workbench = page.getByRole('region', { name: 'Engineering workbench' })
      await workbench.waitFor({ timeout: 30_000 })
      const groupRow = page.locator('[role="treeitem"]').first()
      await groupRow.waitFor({ timeout: 15_000 })
      await expect.poll(async () => {
        if (await groupRow.getAttribute('aria-expanded') === 'true') return true
        await groupRow.click({ force: true, timeout: 2_000 }).catch(() => {})
        return await groupRow.getAttribute('aria-expanded') === 'true'
      }, { timeout: 15_000 }).toBe(true)
      const sessionRow = page.locator('[role="treeitem"]').nth(1)
      await sessionRow.waitFor({ timeout: 10_000 })
      await sessionRow.click({ force: true })
      await page.getByText('Authenticated workbench', { exact: true }).first().waitFor()
      expect(await workbench.locator('[data-workbench-panel]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-workbench-panel'))))
        .toEqual(['files', 'diff', 'terminal', 'artifacts', 'tasks'])
      const openPath = vi.spyOn(scaffold.ctx.apiProxy.host, 'openPath').mockImplementation(async request => ({
        rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } },
      }))
      const prompt = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'prompt').mockImplementation(async request => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { accepted: true as const, command: { kind: 'success' as const, text: 'accepted' } },
        },
      }))
      try {
        await page.getByRole('tab', { name: 'Diff' }).click()
        const diffPanel = workbench.locator('[data-workbench-active-panel="diff"]')
        await diffPanel.getByText('artifact', { exact: true }).waitFor()
        await diffPanel.getByRole('button', { name: 'Open artifact.txt' }).click()
        await expect.poll(() => openPath.mock.calls.length).toBe(1)
        expect(openPath.mock.calls[0]![0].payload).toEqual({ path: 'artifact.txt' })

        await page.getByRole('tab', { name: 'Terminal' }).click()
        const terminalPanel = workbench.locator('[data-workbench-active-panel="terminal"]')
        await terminalPanel.getByText('48 tests passed', { exact: true }).waitFor()
        await terminalPanel.getByRole('textbox', { name: 'Terminal input' }).fill(TERMINAL_FOLLOWUP)
        await terminalPanel.getByRole('button', { name: 'Send terminal input' }).click()
        await expect.poll(() => prompt.mock.calls.length).toBe(1)
        expect(prompt.mock.calls[0]![0].payload).toMatchObject({
          sessionId: SESSION_ID,
          mode: 'queue',
          content: [{ type: 'text', text: TERMINAL_FOLLOWUP }],
        })

        await page.getByRole('tab', { name: 'Artifacts' }).click()
        const artifactsPanel = workbench.locator('[data-workbench-active-panel="artifacts"]')
        await artifactsPanel.getByText('artifact.txt', { exact: true }).waitFor()
        await artifactsPanel.getByRole('listitem').filter({ hasText: 'artifact.txt' })
          .getByRole('button', { name: 'Open' }).click()
        await expect.poll(() => openPath.mock.calls.length).toBe(2)
        expect(openPath.mock.calls[1]![0].payload).toEqual({ path: 'artifact.txt' })

        await page.getByRole('tab', { name: 'Tasks' }).click()
        const tasksPanel = workbench.locator('[data-workbench-active-panel="tasks"]')
        await tasksPanel.getByText('Ship workbench', { exact: true }).waitFor()
        await tasksPanel.getByRole('button', { name: 'Complete Ship workbench' }).click()
        await expect.poll(() => prompt.mock.calls.length).toBe(2)
        expect(prompt.mock.calls[1]![0].payload).toMatchObject({
          sessionId: SESSION_ID,
          mode: 'queue',
          content: [{ type: 'text', text: COMPLETE_TASK_PROMPT }],
        })

        await page.getByRole('tab', { name: 'Files' }).click()
        const filesPanel = workbench.locator('[data-workbench-active-panel="files"]')
        await filesPanel.getByText('src', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Open src' }).click()
        await expect.poll(() => openPath.mock.calls.length).toBe(3)
        expect(openPath.mock.calls[2]![0].payload).toEqual({ path: join(scaffold.workspaceCwd, 'src') })
      } finally {
        openPath.mockRestore()
        prompt.mockRestore()
      }

      await page.getByText('runtime-work', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Stop my active work' }).click()
      await page.getByText('Idle', { exact: true }).waitFor()

      const muxBeforeFocus = muxRequests.length
      expect(await page.locator('[data-workbench-dashboard-chrome]').count()).toBe(1)
      await page.getByRole('button', { name: 'Enter focus mode' }).click()
      expect(await page.locator('[data-workbench-dashboard-chrome]').count()).toBe(0)
      await page.getByRole('button', { name: 'Exit focus mode' }).click()
      expect(await page.locator('[data-workbench-dashboard-chrome]').count()).toBe(1)
      expect(muxRequests).toHaveLength(muxBeforeFocus)
      expect(await page.locator('#root').getAttribute('data-harness-dashboard-ready')).toBe('true')

      const text = await workbench.innerText()
      expect(text).not.toContain('desktop-only-secret')
      expect(text).not.toContain('local-recovery-secret')
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browserContext.close()
    }
  }, 60_000)
})
