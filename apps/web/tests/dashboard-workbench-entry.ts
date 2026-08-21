/** Browser-only authenticated workbench fixture loaded by dashboard-workbench.e2e.ts. */

import React from 'react'
import { createRoot } from 'react-dom/client'
import { Context } from '@harness-desktop/cordis'
import { EngineeringWorkbench } from '@harness-desktop/dsh-client-web/src/app.tsx'

function createSnapshotStore<T>(value: T) {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

const EMPTY_CHAT_SNAPSHOT = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { getTurn: () => [], getStep: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
}
const EMPTY_CONVERSATION_VIEWS = { get: () => undefined }
const turnData = new Map<string, unknown>([
  ['deliverables', { produced: [{ seq: 4, path: 'C:/workspace/src/app.ts' }] }],
  ['turn-tail', { seq: 7, closing: { finalNode: { seq: 6 } } }],
])
const timeline = {
  turnOrder: [1],
  turns: new Map([[1, {
    turn: 1, start: undefined, end: undefined, status: 'closed' as const, steps: [],
    data: { get: (key: string) => turnData.get(key) },
  }]]),
}

const actions: { method: string; args: unknown[] }[] = []
;(globalThis as Record<string, unknown>).__WORKBENCH_ACTIONS__ = actions
const sessionId = 'authenticated-workbench-session' as never
const list = createSnapshotStore({
  ids: [sessionId],
  current: sessionId,
  phase: 'ready' as const,
  currentAddress: undefined,
  subagentsByParent: {},
  jobsBySession: {},
  byId: {
    [sessionId]: {
      id: sessionId,
      title: 'Authenticated workbench',
      displayTitle: 'Authenticated workbench',
      cwd: 'C:/workspace',
      running: false,
      blank: false,
      updatedAt: 1,
    },
  },
})
const snapshot = createSnapshotStore({
  sessionId,
  views: EMPTY_CONVERSATION_VIEWS,
  chat: { ...EMPTY_CHAT_SNAPSHOT, timeline },
  nodes: [
    {
      kind: 'tool-result' as const,
      seq: 4,
      time: 4,
      callId: 'diff-call',
      call: { name: 'edit', argsRaw: '{}' },
      callTime: 3,
      content: [],
      isError: false,
      subCalls: [],
      callView: {
        card: 'diff' as const,
        title: 'Edit app.ts',
        locations: [{ path: 'C:/workspace/src/app.ts' }],
        diffs: [{ path: 'C:/workspace/src/app.ts', oldText: 'old', newText: 'new' }],
      },
      resultView: {
        card: 'diff' as const,
        diffs: [{ path: 'C:/workspace/src/app.ts', oldText: 'old', newText: 'new' }],
      },
    },
    {
      kind: 'tool-result' as const,
      seq: 8,
      time: 8,
      callId: 'terminal-call',
      call: { name: 'bash', argsRaw: '{}' },
      callTime: 7,
      content: [],
      isError: false,
      subCalls: [],
      callView: { card: 'terminal' as const, title: 'pnpm test', cwd: 'C:/workspace' },
      resultView: { card: 'terminal' as const, output: '48 tests passed', exitCode: 0 },
    },
  ],
  turnTimings: new Map(),
  turnEnds: new Map(),
  partial: null,
  runningCalls: [],
  pending: [],
  queue: [],
  running: false,
  subagent: null,
  composerPhase: 'active' as const,
  removed: false,
  openState: 'open' as const,
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
})
const todos = createSnapshotStore([{ content: 'Ship workbench', status: 'in_progress' as const }])
const absent = createSnapshotStore<unknown>(undefined)
const session = {
  sessionId,
  subscribe: (listener: () => void) => snapshot.subscribe(listener),
  getSnapshot: () => snapshot.getSnapshot(),
  projections: { faceOf: (key: string) => key === 'todos' ? todos : absent },
  prompt: async (content: unknown, mode: unknown) => {
    actions.push({ method: 'prompt', args: [content, mode] })
    return { ok: true as const, value: { accepted: true as const } }
  },
}
const workspaces = {
  list: createSnapshotStore({
    phase: 'ready' as const, items: [], archivedSessionIds: [], recentWorkspaceId: undefined, error: undefined,
  }),
  async listDirectory() {
    return {
      path: 'C:/workspace', home: 'C:/workspace', crumbs: [], truncated: false,
      entries: [{ name: 'src', path: 'C:/workspace/src', hidden: false }],
    }
  },
  async openPath(path: string) { actions.push({ method: 'openPath', args: [path] }) },
}
const sessions = {
  list,
  binding: (id: string) => id === sessionId ? { sessionId, session, ctx: new Context() } : undefined,
}

async function foundationCall(operation: 'observe-active-work' | 'stop-own-ui-work'): Promise<unknown> {
  const response = await fetch('/_harness/dashboard-control', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation }),
  })
  const body = await response.json() as { ok?: boolean; value?: unknown }
  if (!response.ok || body.ok !== true) throw new Error('Foundation control unavailable')
  return body.value
}

/** Minimal AppWebEntry seam for the authenticated browser fixture. */
export class AppWebEntry {
  constructor(private readonly root: HTMLElement) {}

  async run(): Promise<boolean> {
    const ctx = new Context()
    ctx.provide('sessions', sessions as never)
    ctx.provide('workspaces', workspaces as never)
    ctx.provide('deliverables', { paths: () => ['C:/workspace/src/app.ts'] } as never)
    createRoot(this.root).render(React.createElement(EngineeringWorkbench, {
      ctx,
      foundation: {
        observeActiveWork: () => foundationCall('observe-active-work') as never,
        stopOwnUiWork: () => foundationCall('stop-own-ui-work') as never,
      },
      chrome: React.createElement('div', { 'data-dashboard-fixture': true }, 'Dashboard chrome'),
    }))
    return true
  }
}
