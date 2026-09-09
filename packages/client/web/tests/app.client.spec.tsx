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
import { LocaleRuntime } from '@harness-desktop/dsh-client-locale/client'

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
    listFiles: vi.fn(async () => ({
      directory: '', path: 'C:\\workspace', truncated: false,
      entries: [{ name: 'src', path: 'C:\\workspace\\src', directory: 'src', kind: 'directory' as const }],
    })),
    openTerminal: vi.fn(async () => ({ id: 'shell-1', output: 'PowerShell ready', exited: false, exitCode: null, shell: 'powershell.exe' })),
    readTerminal: vi.fn(async () => ({ id: 'shell-1', output: 'shell command output', exited: false, exitCode: null, shell: 'powershell.exe' })),
    writeTerminal: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
  }
  return {
    runtime,
    foundation,
    prompt,
    renderApp: buildRenderApp({ ctx: runtime.ctx, foundation }),
  }
}

describe('buildRenderApp', () => {
  it('updates the entire workbench when the shared language changes', async () => {
    const b = await workbench()
    const locale = new LocaleRuntime(b.runtime.ctx)
    b.runtime.provide('locale', locale)
    locale.setLocale('zh')
    const view = render(<>{b.renderApp()}</>)
    expect(view.getByRole('tab', { name: '文件' })).toBeTruthy()
    expect(view.getByText('工作区')).toBeTruthy()
    act(() => { locale.setLocale('en') })
    expect(view.getByRole('tab', { name: 'Files' })).toBeTruthy()
    expect(view.queryByRole('tab', { name: '文件' })).toBeNull()
  })

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
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    expect(await view.findByText('PowerShell ready')).toBeTruthy()
    fireEvent.change(view.getByRole('textbox', { name: 'Terminal input' }), { target: { value: 'Get-Location' } })
    fireEvent.click(view.getByRole('button', { name: 'Run command' }))
    await waitFor(() => {
      expect(b.foundation.writeTerminal).toHaveBeenCalledWith('shell-1', 'Get-Location\r')
      expect(b.prompt).not.toHaveBeenCalled()
    })

    fireEvent.click(view.getByRole('tab', { name: 'Artifacts' }))
    expect(view.getByText('C:\\workspace\\src\\app.ts')).toBeTruthy()
    fireEvent.click(view.getByRole('tab', { name: 'Tasks' }))
    expect(view.getByText('Ship workbench')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Complete Ship workbench' }))
    await waitFor(() => {
      expect(b.prompt).toHaveBeenCalledTimes(1)
      expect(b.foundation.observeActiveWork).toHaveBeenCalledTimes(2)
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

  it('collapses the utility panel without unmounting the conversation', async () => {
    const b = await workbench()
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('button', { name: 'Hide tools' }))
    expect(view.getByRole('tabpanel', { hidden: true }).hasAttribute('hidden')).toBe(true)
    expect(view.getByTestId('dashboard-chrome')).toBeTruthy()
    fireEvent.click(view.getByRole('tab', { name: 'Files' }))
    expect(view.getByRole('tabpanel').hasAttribute('hidden')).toBe(false)
  })

  it('does not bind a late shell to a different workspace', async () => {
    const b = await workbench()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.foundation.openTerminal>>>()
    b.foundation.openTerminal.mockImplementation(() => pending.promise)
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await act(async () => { await b.runtime.sessions.add({ id: 'other', summary: { cwd: 'C:\\other' } }) })
    await act(async () => {
      pending.resolve({ id: 'late', output: 'wrong workspace', exited: false, exitCode: null, shell: 'powershell.exe' })
      await pending.promise
    })
    expect(view.queryByText('wrong workspace')).toBeNull()
    expect(b.foundation.closeTerminal).toHaveBeenCalledWith('late')
  })

  it('closes the shell when the current workspace changes', async () => {
    const b = await workbench()
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await view.findByText('PowerShell ready')
    await act(async () => {
      await b.runtime.workspaces.update((draft) => {
        draft.items = [...draft.items, { ...draft.items[0]!, workspaceId: 'workspace-2' as never, path: 'C:\\other' }]
      })
      await b.runtime.sessions.add({ id: 'other', summary: { cwd: 'C:\\other' } })
      await b.runtime.sessions.setCurrent('other')
    })
    await waitFor(() => { expect(b.foundation.closeTerminal).toHaveBeenCalledWith('shell-1') })
  })

  it('keeps the new shell when an old workspace close completes late', async () => {
    const b = await workbench()
    const pending = Promise.withResolvers<undefined>()
    b.foundation.closeTerminal.mockImplementationOnce(() => pending.promise)
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await view.findByText('PowerShell ready')
    fireEvent.click(view.getByRole('button', { name: 'Close terminal' }))
    await act(async () => {
      await b.runtime.workspaces.update((draft) => {
        draft.items = [...draft.items, { ...draft.items[0]!, workspaceId: 'workspace-2' as never, path: 'C:\\other' }]
      })
      await b.runtime.sessions.add({ id: 'other', summary: { cwd: 'C:\\other' } })
    })
    b.foundation.openTerminal.mockResolvedValueOnce({ id: 'shell-2', output: 'new workspace shell', exited: false, exitCode: null, shell: 'powershell.exe' })
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await view.findByText('new workspace shell')
    expect(b.foundation.closeTerminal).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(view.getByText('new workspace shell')).toBeTruthy()
  })

  it('labels a bounded file listing instead of presenting it as complete', async () => {
    const b = await workbench()
    b.foundation.listFiles.mockResolvedValueOnce({ directory: '', path: 'C:\\workspace', truncated: true, entries: [] })
    const view = render(<>{b.renderApp()}</>)
    expect(await view.findByText('Some entries are omitted. Open a subfolder to narrow the list.')).toBeTruthy()
  })

  it('does not resurrect a shell when a second start resolves after close', async () => {
    const b = await workbench()
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await view.findByText('PowerShell ready')
    const opening = Promise.withResolvers<Awaited<ReturnType<typeof b.foundation.openTerminal>>>()
    b.foundation.openTerminal.mockImplementationOnce(() => opening.promise)
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Close terminal' }))
    await act(async () => {
      opening.resolve({ id: 'shell-1', output: 'late shell', exited: false, exitCode: null, shell: 'powershell.exe' })
      await opening.promise
    })
    expect(view.queryByText('late shell')).toBeNull()
    expect(b.foundation.closeTerminal).toHaveBeenCalledWith('shell-1')
  })

  it('prevents restarting a shell until its close operation settles', async () => {
    const b = await workbench()
    const pending = Promise.withResolvers<undefined>()
    b.foundation.closeTerminal.mockImplementationOnce(() => pending.promise)
    const view = render(<>{b.renderApp()}</>)
    fireEvent.click(view.getByRole('tab', { name: 'Terminal' }))
    fireEvent.click(view.getByRole('button', { name: 'Start terminal' }))
    await view.findByText('PowerShell ready')
    fireEvent.click(view.getByRole('button', { name: 'Close terminal' }))
    expect((view.getByRole('button', { name: 'Start terminal' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect((view.getByRole('button', { name: 'Start terminal' }) as HTMLButtonElement).disabled).toBe(false)
    expect(view.queryByText('PowerShell ready')).toBeNull()
  })
})
