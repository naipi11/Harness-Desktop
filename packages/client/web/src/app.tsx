/**
 * Real-UI assembly closure, invoked by the app-shell plugin once its inject
 * set is active: the whole layout tree hangs off the built-in 'root' slot
 * (ui-layout registers AppFrame there and renders the child slots
 * internally) — the shell's render is the one ctx-level renderSlot call in
 * the program.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode,
} from 'react'
import type { Context } from '@harness-desktop/cordis'
import { bindSnapshotSelector } from '@harness-desktop/dsh-client-web-react'
import type {
  ConversationSnapshot, SessionFace, TodoItem, ToolCallBlock, ToolResultNode,
} from '@harness-desktop/dsh-client-runtime/client'
// Type-only: app-shell reads the optional projection service after plugin settlement.
import type {} from '@harness-desktop/dsh-client-ui-deliverables/client'
import { DocumentTitle } from './DocumentTitle.tsx'
import { workbenchCopy, type WorkbenchCopy } from './workbench-copy.ts'
import { authenticatedWorkbench, type WorkbenchClient, type WorkspaceFile, type ShellSnapshot } from './workbench-client.ts'
import type {} from '@harness-desktop/dsh-client-locale/client'
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
export interface FoundationControl extends WorkbenchClient {
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
  ...authenticatedWorkbench,
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
  const locale = ctx.get('locale')
  const language = useSyncExternalStore(
    callback => locale?.subscribe(callback) ?? EMPTY_SUBSCRIBE(),
    () => locale?.getLocale().active ?? 'en',
  )
  const t = workbenchCopy[language]
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
  const [collapsed, setCollapsed] = useState(false)
  const [directoryEntries, setDirectoryEntries] = useState<readonly WorkspaceFile[]>([])
  const [filesTruncated, setFilesTruncated] = useState(false)
  const [directory, setDirectory] = useState('')
  const [fileState, setFileState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [refresh, setRefresh] = useState(0)
  const [terminalInput, setTerminalInput] = useState('')
  const [shell, setShell] = useState<ShellSnapshot>()
  const shellRef = useRef<ShellSnapshot>()
  shellRef.current = shell
  const [shellError, setShellError] = useState(false)
  const [shellBusy, setShellBusy] = useState(false)
  const [shellClosing, setShellClosing] = useState<string>()
  const isShellClosing = shellClosing !== undefined && shellClosing === shell?.id
  const [activeWork, setActiveWork] = useState<ActiveWorkStatus | undefined>(undefined)
  const cwd = currentId === undefined ? undefined : sessionList.byId[currentId]?.cwd
  const workspaceList = useSyncExternalStore(
    callback => workspaces.list.subscribe(callback),
    () => workspaces.list.getSnapshot(),
  )
  const workspaceId = workspaceList.items.find(item => item.path === cwd)?.workspaceId
  const shellOwner = useRef({ workspaceId, active: true, generation: 0 })
  shellOwner.current.workspaceId = workspaceId
  const shellCloseFlights = useRef(new Map<string, Promise<void>>())
  const closedShellIds = useRef(new Set<string>())
  const closeShellOnce = useCallback((id: string): Promise<void> => {
    if (closedShellIds.current.has(id)) return Promise.resolve()
    const existing = shellCloseFlights.current.get(id)
    if (existing !== undefined) return existing
    const flight = Promise.resolve()
      .then(() => foundation.closeTerminal(id))
      .then(() => { closedShellIds.current.add(id) })
      .finally(() => { shellCloseFlights.current.delete(id) })
    shellCloseFlights.current.set(id, flight)
    return flight
  }, [foundation])
  useEffect(() => {
    shellOwner.current.active = true
    return () => { shellOwner.current.active = false; shellOwner.current.generation += 1 }
  }, [])
  const title = currentId === undefined
    ? t.noSession
    : sessionList.byId[currentId]?.title ?? sessionList.byId[currentId]?.displayTitle ?? currentId
  const diff = lastCard(snapshot, 'diff')

  const produced = useMemo(
    () => snapshot === undefined ? [] : ctx.get('deliverables')?.paths(snapshot.chat.timeline) ?? [],
    [ctx, snapshot],
  )

  useEffect(() => {
    let currentRequest = true
    setDirectoryEntries([])
    setFilesTruncated(false)
    setFileState(workspaceId === undefined ? 'idle' : 'loading')
    if (workspaceId !== undefined) {
      void foundation.listFiles(workspaceId, directory).then((listing) => {
        if (currentRequest) { setDirectoryEntries(listing.entries); setFilesTruncated(listing.truncated); setFileState('idle') }
      }).catch(() => {
        if (currentRequest) setFileState('error')
      })
    }
    return () => { currentRequest = false }
  }, [workspaceId, directory, refresh, foundation])

  useEffect(() => {
    shellOwner.current.generation += 1
    setDirectory(''); setShell(undefined); setShellError(false); setShellBusy(false)
    return () => {
      const id = shellRef.current?.id
      shellRef.current = undefined
      shellOwner.current.generation += 1
      if (id !== undefined) void closeShellOnce(id).catch(() => {})
    }
  }, [workspaceId, closeShellOnce])

  useEffect(() => {
    if (shell === undefined || shell.exited || panel !== 'terminal') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = (): void => {
      timer = setTimeout(() => {
        void foundation.readTerminal(shell.id).then((next) => {
          if (active) { setShell(next); if (!next.exited) poll() }
        }).catch(() => { if (active) setShellError(true) })
      }, 500)
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [shell?.id, shell?.exited, panel, foundation])

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
    let disposed = false
    const poll = (): void => {
      timer = setTimeout(() => {
        if (disposed) return
        remaining -= 1
        void refreshActiveWork().catch(() => {}).finally(() => {
          if (!disposed && remaining > 0) poll()
        })
      }, ACTIVE_WORK_REFRESH_MS)
    }
    poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [activeWork?.ownUiWork.length, refreshActiveWork])

  const openPath = (path: string): void => {
    void workspaces.openPath(path).catch(() => {})
  }
  const submitTerminal = (event: FormEvent): void => {
    event.preventDefault()
    const text = terminalInput.trim()
    if (shell === undefined || shell.exited || isShellClosing || text === '') return
    const generation = shellOwner.current.generation
    const stillOwned = (): boolean => shellOwner.current.active && shellOwner.current.generation === generation
    setShellBusy(true)
    void foundation.writeTerminal(shell.id, `${text}\r`).then(() => {
      if (stillOwned()) { setTerminalInput(''); setShellError(false) }
    }).catch(() => { if (stillOwned()) setShellError(true) }).finally(() => { if (stillOwned()) setShellBusy(false) })
  }
  const startTerminal = (): void => {
    if (workspaceId === undefined || isShellClosing || shellBusy) return
    const generation = ++shellOwner.current.generation
    const stillOwned = (): boolean => shellOwner.current.active
      && shellOwner.current.workspaceId === workspaceId && shellOwner.current.generation === generation
    setShellBusy(true)
    void foundation.openTerminal(workspaceId).then((value) => {
      if (!stillOwned()) {
        void closeShellOnce(value.id).catch(() => {})
        return
      }
      setShell(value); setShellError(false)
    }).catch(() => { if (stillOwned()) setShellError(true) }).finally(() => { if (stillOwned()) setShellBusy(false) })
  }
  const closeTerminal = (): void => {
    if (shell === undefined || isShellClosing) return
    const id = shell.id
    shellOwner.current.generation += 1
    const generation = shellOwner.current.generation
    setShellClosing(id)
    void closeShellOnce(id).then(() => {
      if (shellOwner.current.active) {
        setShell(current => current?.id === id ? undefined : current)
      }
    }).catch(() => {
      if (shellOwner.current.active && shellOwner.current.generation === generation) setShellError(true)
    }).finally(() => {
      if (shellOwner.current.active) setShellClosing(current => current === id ? undefined : current)
    })
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
      aria-label={t.workbench}
      role="region"
      data-workbench-focus={focus ? 'true' : 'false'}
      data-workbench-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className={css.workbenchHeader}>
        <div>
          <span className={css.workbenchEyebrow}>{t.workspace}</span>
          <strong className={css.workbenchTitle}>{title}</strong>
        </div>
        <div className={css.workbenchStatus} aria-label={t.status}>
          {(activeWork?.ownUiWork ?? []).map(id => <span key={id}>{id}</span>)}
          {(activeWork?.ownUiWork.length ?? 0) > 0 ? (
            <button type="button" onClick={stopActiveWork}>{t.stop}</button>
          ) : <span>{t.idle}</span>}
        </div>
        <button
          type="button"
          className={css.focusToggle}
          aria-label={focus ? t.exitFocus : t.enterFocus}
          onClick={() => { setFocus(value => !value) }}
        >
          {focus ? t.restore : t.focus}
        </button>
      </header>

      <div className={css.workbenchBody}>
        <nav className={css.workbenchRail} role="tablist" aria-label={t.panels}>
          {PANELS.map(item => (
            <button
              type="button"
              role="tab"
              key={item.id}
              data-workbench-panel={item.id}
              aria-selected={panel === item.id}
              onClick={() => { setPanel(item.id); setCollapsed(false) }}
            >
              {t[item.id]}
            </button>
          ))}
          <button type="button" aria-label={collapsed ? t.show : t.collapse} onClick={() => { setCollapsed(value => !value) }}>
            {collapsed ? '›' : '‹'}
          </button>
        </nav>
        <section className={css.workbenchPanel} data-workbench-active-panel={panel} role="tabpanel" hidden={collapsed}>
          {panel === 'files' && (
            <>
              <div className={css.panelActions}>
                <button type="button" onClick={() => { setDirectory('') }}>{t.root}</button>
                <button type="button" onClick={() => { setRefresh(value => value + 1) }}>{t.retry}</button>
                {directory !== '' && <button type="button" onClick={() => { setDirectory(directory.replace(/[\\/][^\\/]+$|^[^\\/]+$/u, '')) }}>{t.up}</button>}
              </div>
              {workspaceId === undefined ? <p>{t.noWorkspace}</p> : fileState === 'loading' ? <p>{t.loading}</p> : fileState === 'error' ? <p role="alert">{t.fileError}</p> : (
                <ul className={css.workbenchList}>
                  {directoryEntries.map(entry => (
                    <li key={entry.path}>
                      <button className={css.fileName} type="button" onClick={() => {
                        if (entry.kind === 'directory') setDirectory(entry.directory)
                        else openPath(entry.path)
                      }}>{entry.name}</button>
                      <button type="button" aria-label={`${t.open} ${entry.name}`} onClick={() => { openPath(entry.path) }}>{t.open}</button>
                    </li>
                  ))}
                  {directoryEntries.length === 0 && !filesTruncated && <li>{t.noFiles}</li>}
                  {filesTruncated && <li role="status">{t.truncated}</li>}
                </ul>
              )}
            </>
          )}
          {panel === 'diff' && <DiffPanel block={diff} openPath={openPath} t={t} />}
          {panel === 'terminal' && (
            <form className={css.terminalPanel} onSubmit={submitTerminal}>
              <p>{t.terminalHint}</p>
              <div className={css.panelActions}>
                <button type="button" disabled={workspaceId === undefined || shellBusy || isShellClosing} onClick={startTerminal}>{t.start}</button>
                {shell !== undefined && <>
                  <button type="button" disabled={isShellClosing} onClick={closeTerminal}>{t.close}</button>
                </>}
              </div>
              {shellError && <p role="alert">{t.terminalError}</p>}
              <pre role="log" aria-live="polite">{shell?.output || t.noTerminal}</pre>
              {shell?.exited === true && <p>{t.terminalExited} ({shell.exitCode ?? '—'})</p>}
              <label>
                <span>{t.terminalInput}</span>
                <input
                  aria-label={t.terminalInput}
                  value={terminalInput}
                  disabled={shell === undefined || shell.exited || shellBusy || isShellClosing}
                  onChange={(event) => { setTerminalInput(event.currentTarget.value) }}
                />
              </label>
              <button type="submit" disabled={shell === undefined || shell.exited || shellBusy || isShellClosing || terminalInput.trim() === ''}>{t.send}</button>
            </form>
          )}
          {panel === 'artifacts' && (
            <ul className={css.workbenchList}>
              {produced.map(path => (
                <li key={path}><span>{path}</span><button type="button" onClick={() => { openPath(path) }}>{t.open}</button></li>
              ))}
              {produced.length === 0 && <li>{t.noArtifacts}</li>}
            </ul>
          )}
          {panel === 'tasks' && (
            <ul className={css.workbenchList}>
              {todos.map(task => (
                <li key={task.content}>
                  <span data-task-status={task.status}>{task.content}</span>
                  {task.status !== 'completed' && (
                    <button type="button" aria-label={`${t.complete} ${task.content}`} onClick={() => { completeTask(task) }}>{t.complete}</button>
                  )}
                </li>
              ))}
              {todos.length === 0 && <li>{t.noTasks}</li>}
            </ul>
          )}
        </section>
        {!focus && <section className={css.dashboardChrome} data-workbench-dashboard-chrome>{chrome}</section>}
      </div>
    </main>
  )
}

function DiffPanel({ block, openPath, t }: {
  readonly block: ToolCallBlock | undefined
  readonly openPath: (path: string) => void
  readonly t: WorkbenchCopy
}): ReactNode {
  const view = block === undefined
    ? undefined
    : ('kind' in block && block.resultView?.card === 'diff' ? block.resultView : block.callView?.card === 'diff' ? block.callView : undefined)
  if (view === undefined) return <p>{t.noDiff}</p>
  return (
    <div className={css.diffPanel}>
      {view.diffs.map(diff => (
        <article key={diff.path}>
          <header>{diff.path}<button type="button" aria-label={`${t.open} ${diff.path}`} onClick={() => { openPath(diff.path) }}>{t.open}</button></header>
          {diff.oldText !== null && <del>{diff.oldText}</del>}
          <ins>{diff.newText}</ins>
        </article>
      ))}
    </div>
  )
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
