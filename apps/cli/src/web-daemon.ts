/**
 * Detached web-server startup with one private log per invocation.
 * @module @deepseek-ai/dsh/web-daemon
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** A child process observed only through its startup events. */
export interface WebDaemonChild {
  /** The operating-system process id, assigned after spawn. */
  pid?: number | undefined
  /** Subscribe once to a child startup event. */
  once(event: 'spawn', listener: () => void): unknown
  /** Subscribe once to a child startup failure. */
  once(event: 'error', listener: (error: Error) => void): unknown
  /** Release the parent's event-loop reference after startup succeeds. */
  unref(): void
}

/** Filesystem and process operations required to start a detached web server. */
export interface WebDaemonAdapters {
  /** Resolve the current user's DSH home directory. */
  home(): string
  /** Create the log root with private permissions. */
  mkdirSync(path: string, options: { recursive: true; mode: number }): string | undefined
  /** Create a unique private log directory. */
  mkdtempSync(prefix: string): string
  /** Open the log without replacing an existing file. */
  openSync(path: string, flags: string, mode: number): number
  /** Release the parent copy of the child's log descriptor. */
  closeSync(fd: number): void
  /** Start the detached child. */
  spawn(command: string, args: string[], options: SpawnOptions): WebDaemonChild
}

/** Production adapters; tests provide a small in-memory substitute. */
export const productionWebDaemonAdapters: WebDaemonAdapters = {
  home: resolveDshHome,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  spawn(command, args, options): WebDaemonChild {
    return spawn(command, args, options)
  },
}

/**
 * Remove daemon-only flags before passing the remaining arguments to the web app.
 * Help runs in the parent so it never launches a detached server.
 * @param args - inner web-profile arguments.
 * @returns cleaned arguments and whether startup should detach.
 */
export function resolveWebDaemonInvocation(args: readonly string[]): { args: string[]; detached: boolean } {
  const requested = args.some(arg => arg === '--daemon' || arg === '--background')
  const cleaned = args.filter(arg => arg !== '--daemon' && arg !== '--background')
  return { args: cleaned, detached: requested && !cleaned.some(arg => arg === '-h' || arg === '--help') }
}

/**
 * Inputs used to launch a fresh web-profile child.
 */
export interface LaunchWebDaemonInput {
  /** Node runtime arguments that must precede the entrypoint. */
  runtimeArgs: readonly string[]
  /** Source or built dsh entrypoint passed to Node. */
  entry: string
  /** Overlay files retained in caller-supplied order. */
  patches: readonly string[]
  /** Web-app arguments after daemon flags have been removed. */
  args: readonly string[]
}

/**
 * Start a detached web-profile child with stdout and stderr written to one log.
 * @param input - entrypoint, patch files, and cleaned web arguments.
 * @param adapters - filesystem and child-process operations; production is the default.
 * @returns the child pid and its private log path after the operating system reports spawn.
 * @throws when the log cannot be prepared or the child cannot start.
 */
export function launchWebDaemon(
  input: LaunchWebDaemonInput,
  adapters: WebDaemonAdapters = productionWebDaemonAdapters,
): Promise<{ pid: number; logPath: string }> {
  const logsPath = join(adapters.home(), 'logs')
  let logPath = logsPath
  let logFd: number
  try {
    adapters.mkdirSync(logsPath, { recursive: true, mode: 0o700 })
    const logDirectory = adapters.mkdtempSync(join(logsPath, 'web-'))
    logPath = join(logDirectory, 'server.log')
    logFd = adapters.openSync(logPath, 'wx', 0o600)
  } catch (error: unknown) {
    throw new Error(`web daemon log operation failed for ${logPath}`, { cause: error })
  }

  const argv = [
    ...input.runtimeArgs,
    input.entry,
    '--profile',
    'web',
    ...input.patches.flatMap(path => ['--patch', path]),
    ...input.args,
  ]
  let child: WebDaemonChild
  try {
    child = adapters.spawn(process.execPath, argv, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    })
  } catch (error: unknown) {
    adapters.closeSync(logFd)
    throw new Error(`web daemon spawn failed for ${input.entry}`, { cause: error })
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const closeLog = (): boolean => {
      try {
        adapters.closeSync(logFd)
        return true
      } catch (error: unknown) {
        reject(new Error(`web daemon log operation failed for ${logPath}`, { cause: error }))
        return false
      }
    }
    child.once('spawn', () => {
      if (settled) return
      settled = true
      if (!closeLog()) return
      if (child.pid === undefined) {
        reject(new Error(`web daemon spawn failed for ${input.entry}: missing process id`))
        return
      }
      child.unref()
      resolve({ pid: child.pid, logPath })
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      if (!closeLog()) return
      reject(new Error(`web daemon spawn failed for ${input.entry}`, { cause: error }))
    })
  })
}
