/** Built CLI acceptance against the public cross-client Runtime fixture. */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@harness-desktop/dsh-session/types'
import type {
  CrossClientFixture,
  CrossClientLifecycleSnapshot,
} from '@harness-desktop/dsh-cross-client-runtime'
import { createBuiltCliAdapter } from './support/cross-client-cli-adapter.ts'

const PROMPT = 'TASK5_BUILT_CLI_PROMPT'
const REPLY = 'TASK5_BUILT_CLI_REPLY'
const require = createRequire(import.meta.url)
const fixtureEntry = require.resolve('@harness-desktop/dsh-cross-client-runtime')

type FixtureApi = typeof import('@harness-desktop/dsh-cross-client-runtime')

interface JsonLine {
  readonly kind?: unknown
  readonly sessionId?: unknown
  readonly text?: unknown
}

async function builtFixtureApi(): Promise<FixtureApi> {
  return import(pathToFileURL(fixtureEntry).href) as Promise<FixtureApi>
}

function parseJsonLines(stdout: string): readonly JsonLine[] {
  return stdout.split(/\r?\n/u).filter(line => line.length > 0).map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError('record must be an object')
      }
      return parsed
    } catch (error) {
      throw new Error(`CLI stdout line ${String(index + 1)} is not a JSON object`, { cause: error })
    }
  })
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some(item => containsExactString(item, expected))
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(item => containsExactString(item, expected))
}

function expectDisposed(snapshot: CrossClientLifecycleSnapshot): void {
  expect(snapshot).toEqual({
    state: 'disposed',
    events: [{ kind: 'started' }, { kind: 'health-confirmed' }, { kind: 'stopped' }],
    observations: [],
  })
}

describe('built CLI shared Runtime acceptance', () => {
  it.each(['harness', 'dsh'] as const)(
    'persists %s JSONL work through the public fixture state API',
    async (command) => {
      const api = await builtFixtureApi()
      let fixture: CrossClientFixture | undefined
      try {
        fixture = await api.createCrossClientFixture({
          adapters: { cli: createBuiltCliAdapter(command) },
          mock: { sequence: ['success'], repeatLast: true, successText: REPLY },
        })
        const knownWorkspace = await fixture.createWorkspace()

        const result = await fixture.runCli(['run', PROMPT, '--json'])
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.stderr).toBe('')
        const events = parseJsonLines(result.stdout)
        const opened = events.filter(event => event.kind === 'session-opened')
        expect(opened).toHaveLength(1)
        if (typeof opened[0]?.sessionId !== 'string') {
          throw new Error('CLI session-opened event did not carry a SessionId')
        }
        const sessionId = opened[0].sessionId as SessionId
        const reply = events
          .filter((event): event is JsonLine & { readonly kind: 'output'; readonly text: string } =>
            event.kind === 'output' && typeof event.text === 'string')
          .map(event => event.text)
          .join('')
        expect(reply).toBe(REPLY)

        const workspace = (await fixture.readWorkspaces())
          .find(row => row.workspaceId === knownWorkspace.workspaceId)
        expect(workspace).toBeDefined()
        expect(workspace?.sessionIds).not.toContain(sessionId)
        const session = (await fixture.readSessions()).find(row => row.sessionId === sessionId)
        expect(session).toMatchObject({ sessionId, cwd: fixture.workspace })
        const history = await fixture.readHistory(sessionId)
        expect(history.some(entry => containsExactString(entry, PROMPT))).toBe(true)
        expect(history.some(entry => containsExactString(entry, REPLY))).toBe(true)

        const output = `${result.stdout}\n${result.stderr}`
        expect(output).not.toContain(fixture.home)
        expect(output).not.toContain(fixture.platformHome)
        expect(output).not.toMatch(/cross-client-runtime-fixture-key|accesstoken|bearer|cookie|handoff/iu)
      } finally {
        if (fixture !== undefined) {
          await fixture.dispose()
          expectDisposed(fixture.lifecycleSnapshot())
        }
      }
    },
  )
})
