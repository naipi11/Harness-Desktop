/** Built public-entry acceptance for the canonical Runtime and public mock provider. */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeBusyError, type SessionId, type TerminalConnection } from '@harness-desktop/dsh-host-local-runtime'
import type { CrossClientFixture } from '../src/index.ts'

const builtEntry = pathToFileURL(join(
  process.cwd(),
  'packages',
  'test-support',
  'cross-client-runtime',
  'lib',
  'index.js',
)).href
let fixture: CrossClientFixture | undefined
let parent: string | undefined

afterEach(async () => {
  await fixture?.dispose().catch(() => {})
  fixture = undefined
  if (parent !== undefined) await rm(parent, { recursive: true, force: true })
  parent = undefined
})

async function builtModule(): Promise<typeof import('../src/index.ts')> {
  return import(builtEntry) as Promise<typeof import('../src/index.ts')>
}

async function waitFor(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('built cross-client Runtime fixture', () => {
  it('uses plain built Node despite a hostile parent loader and persists public API success', async () => {
    parent = await mkdtemp(join(tmpdir(), 'cross-client-artifact-success-'))
    const marker = join(parent, 'hostile-loader-ran')
    const hook = join(parent, 'hostile-parent-hook.mjs')
    await writeFile(hook, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, 'loaded')`,
    ].join('\n'))
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `--import ${pathToFileURL(hook).href}`
    try {
      const api = await builtModule()
      fixture = await api.createCrossClientFixture({
        temporaryParent: parent,
        mock: { sequence: ['success'], repeatLast: true, successText: 'TASK5_CANONICAL_SUCCESS' },
      })
      expect(fixture.lifecycleSnapshot().events).toEqual([{ kind: 'started' }, { kind: 'health-confirmed' }])
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })

      const workspace = await fixture.createWorkspace()
      const observation = await fixture.createSession(workspace.workspaceId)
      await fixture.prompt(observation.sessionId, 'TASK5_CANONICAL_PROMPT')
      await waitFor(async () => {
        const history = await fixture!.readHistory(observation.sessionId)
        const serialized = JSON.stringify(history)
        return serialized.includes('TASK5_CANONICAL_PROMPT') && serialized.includes('TASK5_CANONICAL_SUCCESS')
      }, 'persisted success history')

      expect((await fixture.readWorkspaces()).some(row => row.workspaceId === observation.workspaceId)).toBe(true)
      expect((await fixture.readSessions()).some(row => row.sessionId === observation.sessionId)).toBe(true)
      expect(JSON.stringify(await fixture.readHistory(observation.sessionId))).toContain('TASK5_CANONICAL_SUCCESS')
      await fixture.stopRuntime()
      expect(fixture.lifecycleSnapshot().events).toEqual([
        { kind: 'started' },
        { kind: 'health-confirmed' },
        { kind: 'stopped' },
      ])
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
  })

  it('keeps stalled public terminal work single-writer and returns the owner SessionId', async () => {
    parent = await mkdtemp(join(tmpdir(), 'cross-client-artifact-stall-'))
    const api = await builtModule()
    fixture = await api.createCrossClientFixture({
      temporaryParent: parent,
      mock: { sequence: ['stall'], repeatLast: true },
    })
    const workspace = await fixture.createWorkspace()
    const observation = await fixture.createSession(workspace.workspaceId)
    const terminal: TerminalConnection = await fixture.openTerminal({
      sessionId: observation.sessionId,
      initialTask: 'TASK5_CANONICAL_STALL',
    })
    const events = terminal.events()[Symbol.asyncIterator]()
    const opened = await Promise.race([
      events.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => {
        reject(new Error('timed out waiting for terminal session-opened'))
      }, 20_000)),
    ])
    const openedSessionId: SessionId | undefined = opened.done !== true && opened.value.kind === 'session-opened'
      ? opened.value.sessionId
      : undefined
    expect(openedSessionId).toBe(observation.sessionId)
    await waitFor(async () =>
      (await fixture!.readSessions()).some(row => row.sessionId === observation.sessionId && row.running),
    'stalled active work')

    const busy = await fixture.expectSameSessionBusy(observation.sessionId)
    expect(busy).toBeInstanceOf(RuntimeBusyError)
    expect(busy.sessionId).toBe(observation.sessionId)
    expect(await terminal.cancel()).toEqual({ kind: 'cancelled' })
    await waitFor(async () =>
      (await fixture!.readSessions()).some(row => row.sessionId === observation.sessionId && !row.running),
    'cancelled terminal quiescence')
    await terminal.close()
  })
})
