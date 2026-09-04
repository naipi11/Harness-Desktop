// @vitest-environment jsdom
/**
 * buildRenderApp on SlotTestRuntime: the fail-loud sessions precondition, the
 * one ctx-level renderSlot('root') call, and the document-title projection
 * arms over the real slot stack.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Context } from '@harness-desktop/cordis'
import { SlotTestRuntime } from '@harness-desktop/dsh-client-test-runtime'
import { EMPTY_CHAT_SNAPSHOT } from '@harness-desktop/dsh-client-runtime/client'
import type { SessionId } from '@harness-desktop/dsh-client-runtime/client'
import { deliverablePaths } from '@harness-desktop/dsh-client-ui-deliverables/client'
import { buildRenderApp } from '@harness-desktop/dsh-client-web/src/app.tsx'

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  document.title = ''
})

async function bench() {
  runtime = await SlotTestRuntime.create()
  await runtime.root.declare({}, () => <div data-testid="frame" />)
  return { runtime, renderApp: buildRenderApp({ ctx: runtime.ctx }) }
}

async function workbench() {
  runtime = await SlotTestRuntime.create()
  await runtime.root.declare({}, () => <div data-testid="dashboard-chrome">conversation</div>)
  const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
  const turnData = new Map<string, unknown>([
    ['deliverables', { produced: [{ seq: 4, path: 'C:\\workspace\\src\\app.ts' }] }],
    ['turn-tail', { seq: 7, closing: { finalNode: { seq: 6 } } }],
  ])
  const timeline = {
    turnOrder: [1],
    turns: new Map([[1, {
      turn: 1, start: undefined, end: undefined, status: 'closed' as const, steps: [],
      data: { get: (key: string) => turnData.get(key) },
    }]]),
  }
  runtime.provide('deliverables', { paths: deliverablePaths })
  await runtime.sessions.add({
    id: 'workbench-session',
    summary: { cwd: 'C:\\workspace', title: 'Workbench session' },
    session: { prompt },
    snapshot: {
      chat: { ...EMPTY_CHAT_SNAPSHOT, timeline } as never,
      nodes: [
        {
          kind: 'tool-result', seq: 4, time: 4, callId: 'diff-call',
          call: { name: 'edit', argsRaw: '{"file_path":"C:\\\\workspace\\\\src\\\\app.ts"}' },
          callTime: 3, content: [], isError: false, subCalls: [],
          callView: {
            card: 'diff', title: 'Edit app.ts',
            diffs: [{ path: 'C:\\workspace\\src\\app.ts', oldText: 'old', newText: 'new' }],
            locations: [{ path: 'C:\\workspace\\src\\app.ts' }],
          },
          resultView: {
            card: 'diff',
            diffs: [{ path: 'C:\\workspace\\src\\app.ts', oldText: 'old', newText: 'new' }],
          },
        },
        {
          kind: 'tool-result', seq: 8, time: 8, callId: 'terminal-call',
          call: { name: 'bash', argsRaw: '{"command":"pnpm test"}' },
          callTime: 7, content: [], isError: false, subCalls: [],
          callView: { card: 'terminal', title: 'pnpm test', cwd: 'C:\\workspace' },
          resultView: { card: 'terminal', output: '48 tests passed', exitCode: 0 },
        },
      ],
    },
  })
  runtime.sessions.behavior('workbench-session').projections.set('todos', [
    { content: 'Ship workbench', status: 'in_progress' },
  ])
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'workspace-1' as never,
      title: 'Harness', path: 'C:\\workspace', sessionIds: ['workbench-session' as never],
      createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
    }]
  })
  runtime.workspaces.stub('listDirectory', async () => ({
    path: 'C:\\workspace', home: 'C:\\workspace', crumbs: [], truncated: false,
    entries: [{ name: 'src', path: 'C:\\workspace\\src', hidden: false }],
  }))
  const foundation = {
    observeActiveWork: vi.fn(async () => ({ ownUiWork: ['workbench-operation'] })),
    stopOwnUiWork: vi.fn(async () => ({ kind: 'stopped' as const, work: ['workbench-operation'] })),
  }
  return {
    runtime,
    foundation,
    prompt,
    renderApp: buildRenderApp({ ctx: runtime.ctx, foundation }),
  }
}

describe('buildRenderApp', () => {
  it('fails loud when the sessions service is unavailable', () => {
    expect(() => buildRenderApp({ ctx: new Context() })).toThrow('sessions service unavailable')
  })

  it('renders the root slot tree through the one ctx-level renderSlot call', async () => {
    const b = await bench()
    const view = render(<>{b.renderApp()}</>)
    expect(view.getByTestId('frame')).toBeTruthy()
  })

  it('projects the current session durable title and falls back to the product title', async () => {
    document.title = 'Product'
    const b = await bench()
    render(<>{b.renderApp()}</>)
    // No current session: the product title stands.
    expect(document.title).toBe('Product')
    await b.runtime.sessions.add({ id: 's1', summary: { title: 'First' } })
    expect(document.title).toBe('First — Product')
    await b.runtime.sessions.setCurrent(undefined)
    expect(document.title).toBe('Product')
    // A session without a durable title keeps the product title.
    await b.runtime.sessions.add({ id: 's2' })
    expect(document.title).toBe('Product')
  })

  it('a current id without a list row falls back (selection/list arbitration transient)', async () => {
    document.title = 'Product'
    const b = await bench()
    await b.runtime.sessions.add({ id: 's1', summary: { title: 'First' } })
    render(<>{b.renderApp()}</>)
    expect(document.title).toBe('First — Product')
    b.runtime.sessions.list.update((draft) => { draft.current = 'ghost' as SessionId })
    await b.runtime.flush()
    expect(document.title).toBe('Product')
  })

  it('mounts five authenticated workbench panels and keeps the session attached across focus mode', async () => {
    const b = await workbench()
    const view = render(<>{b.renderApp()}</>)

    expect(await view.findByRole('region', { name: 'Engineering workbench' })).toBeTruthy()
    expect(view.getAllByRole('tab').map(tab => tab.getAttribute('data-workbench-panel'))).toEqual([
      'files', 'diff', 'terminal', 'artifacts', 'tasks',
    ])
    expect(await view.findByText('src')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Open src' }))
    await waitFor(() => {
      expect(b.runtime.workspaces.calls).toContainEqual({
        method: 'openPath', args: ['C:\\workspace\\src'],
      })
    })

    fireEvent.click(view.getByRole('tab', { name: 'Diff' }))
    expect(view.getByText('old')).toBeTruthy()
    expect(view.getByText('new')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Open C:\\workspace\\src\\app.ts' }))

    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    expect(view.getByText('48 tests passed')).toBeTruthy()
    fireEvent.change(view.getByRole('textbox', { name: 'Terminal input' }), { target: { value: 'run focused tests' } })
    fireEvent.click(view.getByRole('button', { name: 'Send terminal input' }))
    await waitFor(() => {
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'run focused tests' }], 'queue')
      expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(view.getByRole('tab', { name: 'Artifacts' }))
    expect(view.getByText('C:\\workspace\\src\\app.ts')).toBeTruthy()
    fireEvent.click(view.getByRole('tab', { name: 'Tasks' }))
    expect(view.getByText('Ship workbench')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Complete Ship workbench' }))
    await waitFor(() => {
      expect(b.prompt).toHaveBeenCalledTimes(2)
      expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(3)
    })

    expect(await view.findByText('workbench-operation')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Stop my active work' }))
    await waitFor(() => { expect(b.foundation.stopOwnUiWork).toHaveBeenCalledOnce() })

    const observationsBeforeFocus = b.foundation.observeActiveWork.mock.calls.length
    fireEvent.click(view.getByRole('button', { name: 'Enter focus mode' }))
    expect(view.queryByTestId('dashboard-chrome')).toBeNull()
    expect(view.getByText('Workbench session')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Exit focus mode' }))
    expect(view.getByTestId('dashboard-chrome')).toBeTruthy()
    expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(observationsBeforeFocus)
    expect((globalThis as { harnessDesktop?: unknown }).harnessDesktop).toBeUndefined()
    expect(localStorage).toHaveLength(0)
  })

  it('does not restart active-work polling when an in-flight refresh settles after unmount', async () => {
    vi.useFakeTimers()
    const b = await workbench()
    const refresh = Promise.withResolvers<{ ownUiWork: string[] }>()
    b.foundation.observeActiveWork
      .mockResolvedValueOnce({ ownUiWork: ['workbench-operation'] })
      .mockImplementationOnce(() => refresh.promise)
    const view = render(<>{b.renderApp()}</>)
    await act(async () => {})
    expect(b.foundation.observeActiveWork).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(2)

    view.unmount()
    await act(async () => {
      refresh.resolve({ ownUiWork: ['workbench-operation'] })
      await Promise.resolve()
    })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(2)
  })
})
