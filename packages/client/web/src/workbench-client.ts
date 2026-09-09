/** Cookie-only browser face for the Runtime-owned workbench. */
export interface WorkspaceFile {
  name: string
  path: string
  directory: string
  kind: 'file' | 'directory'
}

/** One directory read from a registered workspace. */
export interface WorkspaceFiles {
  entries: WorkspaceFile[]
  directory: string
  path: string
  truncated: boolean
}

/** Snapshot of one user-operated shell; no model request is made. */
export interface ShellSnapshot {
  id: string
  output: string
  exited: boolean
  exitCode: number | null
  shell: string
}

/** Authenticated operations used by the workbench controls. */
export interface WorkbenchClient {
  /** @param workspaceId - registered workspace. @param directory - relative subdirectory. @returns bounded listing. */
  listFiles(workspaceId: string, directory: string): Promise<WorkspaceFiles>
  /** @param workspaceId - registered workspace supplying the cwd. @returns owned shell snapshot. */
  openTerminal(workspaceId: string): Promise<ShellSnapshot>
  /** @param id - shell issued to this Dashboard. @returns retained output and exit state. */
  readTerminal(id: string): Promise<ShellSnapshot>
  /** @param id - owned shell. @param data - user input sent to its stdin. */
  writeTerminal(id: string, data: string): Promise<void>
  /** @param id - owned shell whose process tree is terminated. */
  closeTerminal(id: string): Promise<void>
}

async function request<T>(payload: object): Promise<T> {
  const response = await fetch('/_harness/workbench', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('Workbench operation failed')
  const result = await response.json() as { ok: boolean; value: T }
  if (!result.ok) throw new Error('Workbench operation failed')
  return result.value
}

/** Browser transport contains no native token or secret-value API. */
export const authenticatedWorkbench: WorkbenchClient = {
  listFiles: (workspaceId, directory) => request({ operation: 'files', workspaceId, directory }),
  openTerminal: workspaceId => request({ operation: 'terminal-open', workspaceId }),
  readTerminal: id => request({ operation: 'terminal-read', id }),
  writeTerminal: (id, data) => request({ operation: 'terminal-write', id, data }),
  closeTerminal: id => request({ operation: 'terminal-close', id }),
}
