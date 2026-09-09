/** Runtime-private workspace inspection, independent of directory-picker capability. */
import { opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { PassThrough } from 'node:stream'
import type { SubprocessRuntime, SubprocessOutcome } from '@harness-desktop/dsh-subprocess'
import type { Branded } from '@harness-desktop/dsh-brand'

function missingEntry(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return undefined
  throw error
}

/** One bounded workspace entry; directory is relative to the registered workspace root. */
export interface WorkbenchFile {
  readonly name: string
  readonly path: string
  readonly directory: string
  readonly kind: 'directory' | 'file'
}

/** Runtime-owned workspace lookup; callers cannot supply an arbitrary root path. */
export interface WorkbenchOptions {
  readonly workspacePath: (id: string) => string | undefined
  readonly subprocess?: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'>
  readonly shell?: { readonly command: string; readonly args: readonly string[] }
  readonly maxOutputBytes?: number
  readonly maxTerminals?: number
  readonly graceMs?: number
}

/** Opaque identity of one Dashboard-owned shell. */
export type WorkbenchTerminalId = Branded<'WorkbenchTerminalId'>

interface TerminalRecord {
  readonly id: WorkbenchTerminalId
  readonly owner: string
  readonly workspaceId: string
  readonly process: {
    readonly output: PassThrough
    readonly done: Promise<SubprocessOutcome>
    write(data: string): Promise<void>
    terminate(): Promise<void>
  }
  output: string
  exited: boolean
  exitCode: number | null
  closing?: Promise<void>
}

/**
 * Create workspace operations over the canonical registry.
 * @param options - registered workspace lookup.
 * @returns workspace inspection and lifecycle operations.
 */
export function createWorkbenchService(options: WorkbenchOptions) {
  const shell = options.shell ?? (process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
    : { command: '/bin/sh', args: [] })
  const maxOutputBytes = options.maxOutputBytes ?? 131_072
  const maxTerminals = options.maxTerminals ?? 4
  const graceMs = options.graceMs ?? 1000
  const terminals = new Map<WorkbenchTerminalId, TerminalRecord>()
  const pending = new Map<string, { owner: string; promise: Promise<TerminalRecord> }>()
  const closedOwners = new Set<string>()
  let closing = false
  const isClosed = (owner: string): boolean => closing || closedOwners.has(owner)
  async function listFiles(workspaceId: string, directory: string) {
    const root = options.workspacePath(workspaceId)
    if (root === undefined) throw new Error('Unknown workspace')
    const canonicalRoot = await realpath(root)
    const target = await realpath(resolve(root, directory))
    const part = relative(canonicalRoot, target)
    if (isAbsolute(directory) || part === '..' || part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(part)) {
      throw new Error('Directory is outside the workspace')
    }
    const entries: WorkbenchFile[] = []
    let bytes = 0
    let truncated = false
    const stream = await opendir(target)
    for await (const entry of stream) {
      const path = join(target, entry.name)
      let kind: WorkbenchFile['kind'] = entry.isDirectory() ? 'directory' : 'file'
      if (entry.isSymbolicLink()) {
        const linked = await realpath(path).catch(missingEntry)
        if (linked === undefined) continue
        const linkPart = relative(canonicalRoot, linked)
        if (linkPart === '..' || linkPart.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(linkPart)) continue
        const info = await stat(path).catch(missingEntry)
        if (info === undefined) continue
        kind = info.isDirectory() ? 'directory' : 'file'
      }
      const row = { name: entry.name, path, directory: relative(canonicalRoot, path), kind }
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8')
      if (entries.length === 1000 || bytes > 262_144) {
        truncated = true
        break
      }
      entries.push(row)
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
    return { entries, directory: part, path: target, truncated }
  }
  function owned(owner: string, id: WorkbenchTerminalId): TerminalRecord {
    const record = terminals.get(id)
    if (record?.owner !== owner) throw new Error('Unknown terminal')
    return record
  }
  function snapshot(record: TerminalRecord) {
    return { id: record.id, output: record.output, exited: record.exited, exitCode: record.exitCode, shell: shell.command }
  }
  async function closeTerminal(owner: string, id: WorkbenchTerminalId): Promise<void> {
    const record = owned(owner, id)
    record.closing ??= record.process.terminate().then(() => { terminals.delete(id) })
    await record.closing
  }
  async function openTerminal(owner: string, workspaceId: string) {
    if (isClosed(owner)) throw new Error('Workbench is closed')
    await Promise.all([...terminals.values()]
      .filter(record => record.owner === owner && record.exited)
      .map(record => closeTerminal(owner, record.id)))
    if (isClosed(owner)) throw new Error('Workbench is closed')
    const existing = [...terminals.values()].find(item => item.owner === owner && item.workspaceId === workspaceId && !item.exited)
    if (existing?.closing !== undefined) {
      await existing.closing
      return openTerminal(owner, workspaceId)
    }
    if (existing !== undefined) return snapshot(existing)
    const key = JSON.stringify([owner, workspaceId])
    let flight = pending.get(key)?.promise
    if (flight === undefined) {
      flight = (async () => {
        const path = options.workspacePath(workspaceId)
        if (path === undefined) throw new Error('Unknown workspace')
        if (terminals.size + pending.size >= maxTerminals) throw new Error('Terminal limit reached')
        if (options.subprocess === undefined) throw new Error('Terminal is unavailable')
        const executable = await options.subprocess.resolveExecutable(shell.command)
        const child = options.subprocess.spawn({
          argv: [executable, ...shell.args], cwd: path, graceMs,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          env: { TERM: 'dumb', NO_COLOR: '1' },
        })
        const output = new PassThrough()
        const { stdin, stdout, stderr } = child
        let streamFailed = false
        const streamError = (): void => { streamFailed = true; child.terminate() }
        for (const stream of [stdin, stdout, stderr, output]) {
          if (stream === undefined) continue
          stream.on('error', streamError)
          stream.once('close', () => { stream.off('error', streamError) })
        }
        if (stdin === undefined || stdout === undefined || stderr === undefined) {
          child.terminate()
          await child.waitForExit()
          throw new Error('Terminal requires piped streams')
        }
        stdout.pipe(output, { end: false })
        stderr.pipe(output, { end: false })
        const processHandle: TerminalRecord['process'] = {
          output, done: child.done,
          write: data => new Promise<void>((accept, reject) => {
            if (streamFailed) { reject(new Error('Terminal stream is closed')); return }
            stdin.write(data.replace(/\r\n|\r/g, '\n'), 'utf8', (error) => {
              if (error === null || error === undefined) accept()
              else reject(error)
            })
          }),
          async terminate() {
            child.terminate()
            await child.waitForExit()
            output.end()
          },
        }
        const record: TerminalRecord = {
          id: randomUUID() as WorkbenchTerminalId, owner, workspaceId,
          process: processHandle, output: '', exited: false, exitCode: null,
        }
        const decoder = new StringDecoder('utf8')
        processHandle.output.on('data', (chunk: Buffer) => {
          const text = stripVTControlCharacters(decoder.write(chunk)).replace(/\r(?!\n)/g, '\n')
          const bytes = Buffer.from(record.output + text)
          record.output = bytes.subarray(Math.max(0, bytes.length - maxOutputBytes)).toString('utf8')
        })
        void processHandle.done.then((outcome) => {
          record.exited = true
          record.exitCode = outcome.exitCode
        }, () => { record.exited = true })
        try {
          if (process.platform === 'win32') {
            await processHandle.write('[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding\n')
          }
        } catch {
          await processHandle.terminate()
          throw new Error('Terminal could not start')
        }
        if (isClosed(owner)) {
          await processHandle.terminate()
          throw new Error('Workbench is closed')
        }
        terminals.set(record.id, record)
        return record
      })()
      pending.set(key, { owner, promise: flight })
      void flight.then(() => { pending.delete(key) }, () => { pending.delete(key) })
    }
    return snapshot(await flight)
  }
  async function closeOwner(owner: string): Promise<void> {
    closedOwners.add(owner)
    await Promise.allSettled([...pending.values()].filter(item => item.owner === owner).map(item => item.promise))
    await Promise.all([...terminals.values()].filter(record => record.owner === owner).map(record => closeTerminal(owner, record.id)))
  }
  return {
    listFiles, openTerminal, closeTerminal, closeOwner,
    readTerminal: (owner: string, id: WorkbenchTerminalId) => snapshot(owned(owner, id)),
    async writeTerminal(owner: string, id: WorkbenchTerminalId, data: string): Promise<void> {
      if (data.length > 16_384) throw new Error('Terminal input is too large')
      await owned(owner, id).process.write(data)
    },
    async close(): Promise<void> {
      closing = true
      await Promise.allSettled([...pending.values()].map(item => item.promise))
      await Promise.all([...terminals.values()].map(record => closeTerminal(record.owner, record.id)))
    },
  }
}
