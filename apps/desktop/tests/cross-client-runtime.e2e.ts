/** Built CLI and real Desktop state sharing through one canonical Runtime. */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
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
import { createCrossClientDesktopAdapter } from './support/cross-client-desktop-adapter.ts'

const CLI_PROMPT = 'TASK5_DESKTOP_CLI_PROMPT'
const DESKTOP_APPEND_PROMPT = 'TASK5_DESKTOP_APPEND_PROMPT'
const REPLY = 'TASK5_DESKTOP_REPEATABLE_REPLY'
const require = createRequire(import.meta.url)
const fixtureEntry = require.resolve('@harness-desktop/dsh-cross-client-runtime')
const desktopEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

type FixtureApi = typeof import('@harness-desktop/dsh-cross-client-runtime')

async function builtFixtureApi(): Promise<FixtureApi> {
  await Promise.all([
    access(fixtureEntry, constants.R_OK),
    access(desktopEntry, constants.R_OK),
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

async function selectUngroupedSession(page: Page, sessionLabel: string): Promise<void> {
  await page.locator('#root[data-harness-dashboard-ready="true"]').waitFor({ timeout: 30_000 })
  await page.getByRole('region', { name: 'Engineering workbench' }).waitFor({ timeout: 30_000 })
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await testingNotice.isVisible()) {
    await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
    await testingNotice.waitFor({ state: 'hidden' })
  }
  const sessionsTree = page.getByRole('tree', { name: 'Sessions' })
  if (!await sessionsTree.isVisible()) {
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  }
  await sessionsTree.waitFor({ timeout: 30_000 })
  const ungrouped = sessionsTree.getByRole('treeitem', { name: /^Ungrouped/u })
  const ungroupedLabel = ungrouped.getByText('Ungrouped', { exact: true })
  await expect.poll(async () => {
    if (await ungrouped.getAttribute('aria-expanded') === 'true') return true
    await ungroupedLabel.click({ timeout: 2_000 }).catch(() => {})
    return await ungrouped.getAttribute('aria-expanded') === 'true'
  }, { timeout: 15_000 }).toBe(true)
  const sessionRow = sessionsTree.getByRole('treeitem').filter({ hasText: sessionLabel })
  await sessionRow.getByText(sessionLabel, { exact: true }).click({ force: true })
  await expect.poll(() => sessionRow.getAttribute('aria-selected')).toBe('true')
}

test('retains CLI state after Desktop crash and relaunch through the same Runtime', async () => {
  test.setTimeout(180_000)
  const api = await builtFixtureApi()
  let fixture: CrossClientFixture | undefined
  try {
    const desktop = createCrossClientDesktopAdapter()
    fixture = await api.createCrossClientFixture({
      adapters: {
        cli: createBuiltCliAdapter('harness'),
        desktop: desktop.adapter,
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
    const projectedTitle = session?.projections?.values.title
    const sessionLabel = typeof projectedTitle === 'string' ? projectedTitle : REPLY
    const cliHistory = await fixture.readHistory(opened.sessionId)
    expect(cliHistory.some(entry => containsExactString(entry, CLI_PROMPT))).toBe(true)
    expect(cliHistory.some(entry => containsExactString(entry, REPLY))).toBe(true)

    const firstDesktop = await fixture.openDesktop()
    const firstProbe = desktop.latest()
    await selectUngroupedSession(firstProbe.page, sessionLabel)
    await firstProbe.page.getByText(CLI_PROMPT, { exact: true }).last().waitFor({ timeout: 30_000 })
    await firstProbe.page.getByText(REPLY, { exact: true }).last().waitFor({ timeout: 30_000 })
    const composer = firstProbe.page.locator('textarea:enabled').last()
    await composer.fill(DESKTOP_APPEND_PROMPT)
    await firstProbe.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await firstProbe.page.getByText(DESKTOP_APPEND_PROMPT, { exact: true }).last().waitFor({ timeout: 30_000 })
    await expect.poll(async () => {
      const history = await fixture!.readHistory(opened.sessionId)
      return {
        prompt: history.some(entry => containsExactString(entry, DESKTOP_APPEND_PROMPT)),
        reply: assistantReplyCount(history, REPLY) >= 2,
      }
    }, { timeout: 30_000 }).toEqual({ prompt: true, reply: true })

    await firstProbe.terminateUnexpectedly()
    await firstDesktop.close()
    expect(fixture.lifecycleSnapshot()).toEqual({
      state: 'ready',
      events: [{ kind: 'started' }, { kind: 'health-confirmed' }],
      observations: [],
    })
    const afterCrash = await fixture.readHistory(opened.sessionId)
    expect(afterCrash.some(entry => containsExactString(entry, DESKTOP_APPEND_PROMPT))).toBe(true)
    expect(assistantReplyCount(afterCrash, REPLY)).toBe(2)

    await fixture.openDesktop()
    const relaunched = desktop.latest().page
    await selectUngroupedSession(relaunched, sessionLabel)
    await relaunched.getByText(CLI_PROMPT, { exact: true }).last().waitFor({ timeout: 30_000 })
    await relaunched.getByText(DESKTOP_APPEND_PROMPT, { exact: true }).last().waitFor({ timeout: 30_000 })
    await relaunched.getByText(REPLY, { exact: true }).last().waitFor({ timeout: 30_000 })
  } finally {
    const cleanupFailures: unknown[] = []
    if (fixture !== undefined) {
      let disposed = false
      await fixture.dispose().then(
        () => { disposed = true },
        (error: unknown) => { cleanupFailures.push(error) },
      )
      if (disposed) {
        try {
          expectDisposed(fixture.lifecycleSnapshot())
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0]
    if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'Desktop cross-client cleanup failed')
  }
})
