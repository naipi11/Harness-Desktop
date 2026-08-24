/** Built Runtime acceptance through the shipped authenticated Dashboard and real Chromium. */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@harness-desktop/dsh-host-apiproxy/api'
import type { SessionId } from '@harness-desktop/dsh-session/types'
import type {
  CrossClientFixture,
  CrossClientLifecycleSnapshot,
} from '@harness-desktop/dsh-cross-client-runtime'
import {
  createBuiltCliAdapter,
  parseCliJsonLines,
} from '../../cli/tests/support/cross-client-cli-adapter.ts'
import { createCrossClientWebAdapter } from './support/cross-client-web-adapter.ts'

const CLI_PROMPT = 'TASK5_WEB_CLI_PROMPT'
const WEB_APPEND_PROMPT = 'TASK5_WEB_APPEND_PROMPT'
const REPLY = 'TASK5_WEB_REPEATABLE_REPLY'
const require = createRequire(import.meta.url)
const fixtureEntry = require.resolve('@harness-desktop/dsh-cross-client-runtime')
const webDistEntry = fileURLToPath(new URL('../dist/index.html', import.meta.url))

type FixtureApi = typeof import('@harness-desktop/dsh-cross-client-runtime')

async function builtFixtureApi(): Promise<FixtureApi> {
  await Promise.all([
    access(fixtureEntry, constants.R_OK),
    access(webDistEntry, constants.R_OK),
  ])
  return import(pathToFileURL(fixtureEntry).href) as Promise<FixtureApi>
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some(item => containsExactString(item, expected))
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(item => containsExactString(item, expected))
}

function assistantReplyCount(history: readonly HistoryEntry[], expected: string): number {
  return history.filter(entry => entry.event.type === 'assistant/message' && containsExactString(entry.event, expected)).length
}

function expectDisposed(snapshot: CrossClientLifecycleSnapshot): void {
  expect(snapshot).toEqual({
    state: 'disposed',
    events: [{ kind: 'started' }, { kind: 'health-confirmed' }, { kind: 'stopped' }],
    observations: [],
  })
}

function exactSessionId(stdout: string): { readonly sessionId: SessionId; readonly reply: string } {
  const events = parseCliJsonLines(stdout)
  const opened = events.filter(event => event.kind === 'session-opened')
  expect(opened).toHaveLength(1)
  if (typeof opened[0]?.sessionId !== 'string' || opened[0].sessionId.length === 0) {
    throw new Error('CLI session-opened event did not carry a SessionId')
  }
  const reply = events
    .filter((event): event is typeof event & { readonly kind: 'output'; readonly text: string } =>
      event.kind === 'output' && typeof event.text === 'string')
    .map(event => event.text)
    .join('')
  return { sessionId: opened[0].sessionId as SessionId, reply }
}

describe('built Web shared Runtime acceptance', () => {
  it('renders CLI state and appends through the authenticated Dashboard without leaking handoff state', async () => {
    const api = await builtFixtureApi()
    let fixture: CrossClientFixture | undefined
    let browser: Browser | undefined
    let webHandle: { close(): Promise<void> } | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const web = createCrossClientWebAdapter(browser)
      fixture = await api.createCrossClientFixture({
        adapters: {
          cli: createBuiltCliAdapter('harness'),
          web: web.adapter,
        },
        mock: { sequence: ['success'], repeatLast: true, successText: REPLY },
      })
      const knownWorkspace = await fixture.createWorkspace()
      expect(knownWorkspace.title).toBe(basename(fixture.workspace))

      const cli = await fixture.runCli(['run', CLI_PROMPT, '--json'])
      expect(cli.exitCode, cli.stderr).toBe(0)
      expect(cli.stderr).toBe('')
      const opened = exactSessionId(cli.stdout)
      expect(opened.reply).toBe(REPLY)

      const workspace = (await fixture.readWorkspaces())
        .find(row => row.workspaceId === knownWorkspace.workspaceId)
      expect(workspace?.sessionIds).not.toContain(opened.sessionId)
      const session = (await fixture.readSessions()).find(row => row.sessionId === opened.sessionId)
      expect(session).toMatchObject({ sessionId: opened.sessionId, cwd: fixture.workspace })
      const cliHistory = await fixture.readHistory(opened.sessionId)
      expect(cliHistory.some(entry => containsExactString(entry, CLI_PROMPT))).toBe(true)
      expect(cliHistory.some(entry => containsExactString(entry, REPLY))).toBe(true)

      webHandle = await fixture.openWeb()
      const probe = web.latest()
      const { page } = probe
      await page.locator('#root[data-harness-dashboard-ready="true"]').waitFor({ timeout: 30_000 })
      const workbench = page.getByRole('region', { name: 'Engineering workbench' })
      await workbench.waitFor({ timeout: 30_000 })
      const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
      if (await testingNotice.isVisible()) {
        await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
      }
      const sessionsTree = page.getByRole('tree', { name: 'Sessions' })
      const ungrouped = sessionsTree.getByRole('treeitem', { name: /^Ungrouped/u })
      const ungroupedLabel = ungrouped.getByText('Ungrouped', { exact: true })
      await expect.poll(async () => {
        if (await ungrouped.getAttribute('aria-expanded') === 'true') return true
        await ungroupedLabel.click({ timeout: 2_000 }).catch(() => {})
        return await ungrouped.getAttribute('aria-expanded') === 'true'
      }, { timeout: 15_000 }).toBe(true)

      const projectedTitle = session?.projections?.values.title
      const sessionLabel = typeof projectedTitle === 'string' ? projectedTitle : REPLY
      const sessionRow = sessionsTree.getByRole('treeitem').filter({ hasText: sessionLabel })
      await sessionRow.getByText(sessionLabel, { exact: true }).click({ force: true })
      await page.getByText(knownWorkspace.title, { exact: true }).first().waitFor()
      await expect.poll(() => sessionRow.getAttribute('aria-selected')).toBe('true')
      await page.getByText(CLI_PROMPT, { exact: true }).last().waitFor()
      await page.getByText(REPLY, { exact: true }).last().waitFor()

      const composer = page.locator('textarea:enabled').last()
      await composer.fill(WEB_APPEND_PROMPT)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.getByText(WEB_APPEND_PROMPT, { exact: true }).last().waitFor({ timeout: 30_000 })
      await expect.poll(async () => {
        const history = await fixture!.readHistory(opened.sessionId)
        return {
          prompt: history.some(entry => containsExactString(entry, WEB_APPEND_PROMPT)),
          reply: assistantReplyCount(history, REPLY) >= 2,
        }
      }, { timeout: 30_000 }).toEqual({ prompt: true, reply: true })
      await page.getByText(REPLY, { exact: true }).last().waitFor({ timeout: 30_000 })

      expect(await probe.audit()).toEqual({
        handoffPostCount: 1,
        requestUrlsClean: true,
        requestHeadersClean: true,
        referrerClean: true,
        handoffOnlyInPostBody: true,
        finalUrlClean: true,
        finalDomClean: true,
        historyClean: true,
        localStorageClean: true,
        sessionStorageClean: true,
        consoleClean: true,
        sessionCookieProtected: true,
        consoleErrorCount: 0,
        pageErrorCount: 0,
      })
    } finally {
      const cleanupFailures: unknown[] = []
      if (webHandle !== undefined) await webHandle.close().catch((error: unknown) => { cleanupFailures.push(error) })
      if (browser !== undefined) await browser.close().catch((error: unknown) => { cleanupFailures.push(error) })
      if (fixture !== undefined) {
        let disposed = false
        try {
          await fixture.dispose()
          disposed = true
        } catch (error) {
          cleanupFailures.push(error)
        }
        if (disposed) {
          try {
            expectDisposed(fixture.lifecycleSnapshot())
          } catch (error) {
            cleanupFailures.push(error)
          }
        }
      }
      if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Web cross-client cleanup failed')
    }
  })
})
