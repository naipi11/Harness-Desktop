/**
 * Real-UI assembly closure, invoked by the app-shell plugin once its inject
 * set is active: the whole layout tree hangs off the built-in 'root' slot
 * (ui-layout registers AppFrame there and renders the child slots
 * internally) — the shell's render is the one ctx-level renderSlot call in
 * the program.
 */
import {
  useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode,
} from 'react'
import type { Context } from '@harness-desktop/cordis'
import { bindSnapshotSelector } from '@harness-desktop/dsh-client-web-react'
import type {
  ConversationSnapshot, SessionFace, TodoItem, ToolCallBlock, ToolResultNode,
} from '@harness-desktop/dsh-client-runtime/client'
// Type-only: app-shell reads the optional projection service after plugin settlement.
import type {} from '@harness-desktop/dsh-client-ui-deliverables/client'
import { DocumentTitle } from './DocumentTitle.tsx'
import css from './AppRoot.module.css'
// Type-only: pulls the runtime's SlotMap declaration merge (the 'root' key) into this program.
import type {} from '@harness-desktop/dsh-client-runtime/client'

/** Assembly inputs: the active app-shell plugin ctx (slots/sessions/layout services provided). */
export interface AssemblyDeps {
  /** Client context with the assembly's inject set active. */
  ctx: Context
  /** Authenticated Runtime controls; tests supply the same narrow production face. */
  foundation?: FoundationControl
}

/** Active work visible to this authenticated Dashboard attachment. */
export interface ActiveWorkStatus {
  /** Runtime work ids owned by this UI attachment. */
  readonly ownUiWork: readonly string[]
}

/** Result of cancelling only work owned by this Dashboard attachment. */
export type OwnUiWorkStopResult =
  | { readonly kind: 'stopped'; readonly work: readonly string[] }
  | { readonly kind: 'none-active' }
  | { readonly kind: 'failed'; readonly diagnostic: unknown }

/** Foundation operations the authenticated workbench is allowed to invoke. */
export interface FoundationControl {
  /** @returns active Runtime work owned by this Dashboard attachment. */
  observeActiveWork(): Promise<ActiveWorkStatus>
  /** @returns settlement after stopping only this Dashboard attachment's work. */
  stopOwnUiWork(): Promise<OwnUiWorkStopResult>
}

/** The five stable engineering views owned by the Dashboard. */
export type WorkbenchPanel = 'files' | 'diff' | 'terminal' | 'artifacts' | 'tasks'

const PANELS: readonly { readonly id: WorkbenchPanel; readonly label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'diff', label: 'Diff' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'tasks', label: 'Tasks' },
]

const EMPTY_SUBSCRIBE = (): (() => void) => () => {}
const NO_SESSION = (): undefined => undefined
const ACTIVE_WORK_REFRESH_MS = 1_000
const ACTIVE_WORK_REFRESH_LIMIT = 30

interface DashboardControlResponse<T> {
  readonly ok?: boolean
  readonly value?: T
}

/** Post one cookie-authenticated Foundation operation without reading the cookie carrier. */
async function dashboardControl<T>(operation: 'observe-active-work' | 'stop-own-ui-work'): Promise<T> {
  const response = await fetch('/_harness/dashboard-control', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation }),
  })
  if (!response.ok) throw new Error('Dashboard control unavailable')
  const result = await response.json() as DashboardControlResponse<T>
  if (result.ok !== true || result.value === undefined) throw new Error('Dashboard control unavailable')
  return result.value
}

const AUTHENTICATED_FOUNDATION: FoundationControl = {
  observeActiveWork: () => dashboardControl<ActiveWorkStatus>('observe-active-work'),
  stopOwnUiWork: () => dashboardControl<OwnUiWorkStopResult>('stop-own-ui-work'),
}

function useSessionSnapshot(session: SessionFace | undefined): ConversationSnapshot | undefined {
  return useSyncExternalStore(
    session?.subscribe.bind(session) ?? EMPTY_SUBSCRIBE,
    session?.getSnapshot.bind(session) ?? NO_SESSION,
    session?.getSnapshot.bind(session) ?? NO_SESSION,
  )
}

function useTodos(session: SessionFace | undefined): readonly TodoItem[] {
  const face = session?.projections.faceOf('todos')
  const value = useSyncExternalStore(
    face?.subscribe.bind(face) ?? EMPTY_SUBSCRIBE,
    face?.getSnapshot.bind(face) ?? NO_SESSION,
    face?.getSnapshot.bind(face) ?? NO_SESSION,
  )
  return Array.isArray(value) ? value.filter(isTodoItem) : []
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.content === 'string'
    && (item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed')
}

function toolBlocks(snapshot: ConversationSnapshot | undefined): readonly ToolCallBlock[] {
  if (snapshot === undefined) return []
  return [...snapshot.nodes.filter((node): node is ToolResultNode => node.kind === 'tool-result'), ...snapshot.runningCalls]
}

function lastCard(snapshot: ConversationSnapshot | undefined, card: 'diff' | 'terminal'): ToolCallBlock | undefined {
  return toolBlocks(snapshot).findLast((block) => {
    if ('kind' in block) return block.resultView?.card === card || block.callView?.card === card
    return block.callView?.card === card
  })
}

interface EngineeringWorkbenchProps {
  readonly ctx: Context
  readonly foundation: FoundationControl
  readonly chrome: ReactNode
}

/** Authenticated Dashboard engineering surface over the existing Client projections. */
export function EngineeringWorkbench({ ctx, foundation, chrome }: EngineeringWorkbenchProps): ReactNode {
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const sessionList = useSyncExternalStore(
    listener => sessions.list.subscribe(listener),
    () => sessions.list.getSnapshot(),
    () => sessions.list.getSnapshot(),
  )
  const currentId = sessionList.current
  const current = currentId === undefined ? undefined : sessions.binding(currentId)?.session
  const snapshot = useSessionSnapshot(current)
  const todos = useTodos(current)
  const [panel, setPanel] = useState<WorkbenchPanel>('files')
  const [focus, setFocus] = useState(false)
  const [directoryEntries, setDirectoryEntries] = useState<readonly { name: string; path: string }[]>([])
  const [terminalInput, setTerminalInput] = useState('')
  const [activeWork, setActiveWork] = useState<ActiveWorkStatus | undefined>(undefined)
  const cwd = currentId === undefined ? undefined : sessionList.byId[currentId]?.cwd
  const title = currentId === undefined
    ? 'No active session'
    : sessionList.byId[currentId]?.title ?? sessionList.byId[currentId]?.displayTitle ?? currentId
  const diff = lastCard(snapshot, 'diff')
  const terminal = lastCard(snapshot, 'terminal')
  const produced = useMemo(
    () => snapshot === undefined ? [] : ctx.get('deliverables')?.paths(snapshot.chat.timeline) ?? [],
    [ctx, snapshot],
  )

  useEffect(() => {
    let currentRequest = true
    setDirectoryEntries([])
    if (cwd !== undefined) {
      void workspaces.listDirectory(cwd).then((listing) => {
        if (currentRequest) setDirectoryEntries(listing.entries)
      }).catch(() => {
        if (currentRequest) setDirectoryEntries([])
      })
    }
    return () => { currentRequest = false }
  }, [cwd, workspaces])

  const refreshActiveWork = useCallback(async (): Promise<void> => {
    const status = await foundation.observeActiveWork()
    setActiveWork(status)
  }, [foundation])

  useEffect(() => {
    let currentRequest = true
    void refreshActiveWork().catch(() => {
      if (currentRequest) setActiveWork(undefined)
    })
    return () => { currentRequest = false }
  }, [refreshActiveWork])

  useEffect(() => {
    if ((activeWork?.ownUiWork.length ?? 0) === 0) return
    let remaining = ACTIVE_WORK_REFRESH_LIMIT
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      timer = setTimeout(() => {
        remaining -= 1
        void refreshActiveWork().catch(() => {}).finally(() => {
          if (remaining > 0) poll()
        })
      }, ACTIVE_WORK_REFRESH_MS)
    }
    poll()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [activeWork?.ownUiWork.length, refreshActiveWork])

  const openPath = (path: string): void => {
    void workspaces.openPath(path).catch(() => {})
  }
  const submitTerminal = (event: FormEvent): void => {
    event.preventDefault()
    const text = terminalInput.trim()
    if (current === undefined || text === '') return
    void current.prompt([{ type: 'text', text }], 'queue')
      .then(() => refreshActiveWork())
      .catch(() => {})
    setTerminalInput('')
  }
  const completeTask = (task: TodoItem): void => {
    if (current === undefined) return
    void current.prompt([{
      type: 'text',
      text: `Mark the task "${task.content}" completed with todo_write and preserve every other task.`,
    }], 'queue').then(() => refreshActiveWork()).catch(() => {})
  }
  const stopActiveWork = (): void => {
    void foundation.stopOwnUiWork().then(refreshActiveWork).catch(() => {})
  }

  return (
    <main
      className={css.workbench}
      aria-label="Engineering workbench"
      role="region"
      data-workbench-focus={focus ? 'true' : 'false'}
    >
      <header className={css.workbenchHeader}>
        <div>
          <span className={css.workbenchEyebrow}>Runtime workspace</span>
          <strong className={css.workbenchTitle}>{title}</strong>
        </div>
        <div className={css.workbenchStatus} aria-label="Active work status">
          {(activeWork?.ownUiWork ?? []).map(id => <span key={id}>{id}</span>)}
          {(activeWork?.ownUiWork.length ?? 0) > 0 ? (
            <button type="button" onClick={stopActiveWork}>Stop my active work</button>
          ) : <span>Idle</span>}
        </div>
        <button
          type="button"
          className={css.focusToggle}
          aria-label={focus ? 'Exit focus mode' : 'Enter focus mode'}
          onClick={() => { setFocus(value => !value) }}
        >
          {focus ? 'Restore Dashboard' : 'Focus'}
        </button>
      </header>

      <div className={css.workbenchBody}>
        <nav className={css.workbenchRail} role="tablist" aria-label="Workbench panels">
          {PANELS.map(item => (
            <button
              type="button"
              role="tab"
              key={item.id}
              data-workbench-panel={item.id}
              aria-selected={panel === item.id}
              onClick={() => { setPanel(item.id) }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <section className={css.workbenchPanel} data-workbench-active-panel={panel} role="tabpanel">
          {panel === 'files' && (
            <ul className={css.workbenchList}>
              {directoryEntries.map(entry => (
                <li key={entry.path}>
                  <span>{entry.name}</span>
                  <button type="button" aria-label={`Open ${entry.name}`} onClick={() => { openPath(entry.path) }}>Open</button>
                </li>
              ))}
              {directoryEntries.length === 0 && <li>No workspace entries</li>}
            </ul>
          )}
          {panel === 'diff' && <DiffPanel block={diff} openPath={openPath} />}
          {panel === 'terminal' && (
            <form className={css.terminalPanel} onSubmit={submitTerminal}>
              <pre>{terminalOutput(terminal) ?? 'No terminal transcript'}</pre>
              <label>
                <span>Terminal input</span>
                <input
                  aria-label="Terminal input"
                  value={terminalInput}
                  onChange={(event) => { setTerminalInput(event.currentTarget.value) }}
                />
              </label>
              <button type="submit">Send terminal input</button>
            </form>
          )}
          {panel === 'artifacts' && (
            <ul className={css.workbenchList}>
              {produced.map(path => (
                <li key={path}><span>{path}</span><button type="button" onClick={() => { openPath(path) }}>Open</button></li>
              ))}
              {produced.length === 0 && <li>No artifacts yet</li>}
            </ul>
          )}
          {panel === 'tasks' && (
            <ul className={css.workbenchList}>
              {todos.map(task => (
                <li key={task.content}>
                  <span data-task-status={task.status}>{task.content}</span>
                  {task.status !== 'completed' && (
                    <button type="button" aria-label={`Complete ${task.content}`} onClick={() => { completeTask(task) }}>Complete</button>
                  )}
                </li>
              ))}
              {todos.length === 0 && <li>No active tasks</li>}
            </ul>
          )}
        </section>
        {!focus && <section className={css.dashboardChrome} data-workbench-dashboard-chrome>{chrome}</section>}
      </div>
    </main>
  )
}

function DiffPanel({ block, openPath }: {
  readonly block: ToolCallBlock | undefined
  readonly openPath: (path: string) => void
}): ReactNode {
  const view = block === undefined
    ? undefined
    : ('kind' in block && block.resultView?.card === 'diff' ? block.resultView : block.callView?.card === 'diff' ? block.callView : undefined)
  if (view === undefined) return <p>No diff available</p>
  return (
    <div className={css.diffPanel}>
      {view.diffs.map(diff => (
        <article key={diff.path}>
          <header>{diff.path}<button type="button" aria-label={`Open ${diff.path}`} onClick={() => { openPath(diff.path) }}>Open</button></header>
          {diff.oldText !== null && <del>{diff.oldText}</del>}
          <ins>{diff.newText}</ins>
        </article>
      ))}
    </div>
  )
}

function terminalOutput(block: ToolCallBlock | undefined): string | undefined {
  if (block === undefined || !('kind' in block) || block.resultView?.card !== 'terminal') return undefined
  return block.resultView.output
}

/**
 * Build the renderApp factory the app-shell plugin provides to AppRoot.
 * @param deps - assembly inputs.
 * @returns factory producing the real UI tree (called once per AppRoot render after settled).
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx, foundation = AUTHENTICATED_FOUNDATION } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('shell assembly: sessions service unavailable')
  if (ctx.get('workspaces') === undefined) throw new Error('shell assembly: workspaces service unavailable')
  const useSessions = bindSnapshotSelector(sessions.list)
  const SessionDocumentTitle = (): ReactNode => {
    const title = useSessions((state) => {
      const id = state.current
      return id === undefined ? undefined : state.byId[id]?.title
    })
    return <DocumentTitle {...title === undefined ? {} : { title }} />
  }
  return () => (
    <>
      <SessionDocumentTitle />
      <EngineeringWorkbench ctx={ctx} foundation={foundation} chrome={ctx.slots.renderSlot('root', {})} />
    </>
  )
}
