/** Installation-root launcher that repairs an interrupted standalone payload switch before loading the CLI. */

import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { access, lstat, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Phase = 'prepared' | 'retained' | 'candidate-published' | 'rollback-started' | 'committed'

interface Journal {
  readonly schemaVersion: 1
  readonly phase: Phase
  readonly candidate: string
}

const root = dirname(fileURLToPath(import.meta.url))

/** Repair a durable standalone transaction from paths that never move with the payload. */
export async function recoverStandalonePayload(archiveRoot = root): Promise<void> {
  const journalPath = join(archiveRoot, '.harness-update.json')
  const lockPath = join(archiveRoot, '.harness-update.lock')
  const lock = await readPrivateTextIfPresent(lockPath).then((text) => {
    if (text === undefined) return undefined
    let decoded: unknown
    try { decoded = JSON.parse(text) as unknown } catch { throw new Error('standalone CLI update lock is invalid') }
    if (!isLock(decoded)) throw new Error('standalone CLI update lock is invalid')
    return decoded
  })
  if (lock !== undefined && isLiveLock(lock)) throw new Error('standalone CLI update is still in progress')
  let journal: Journal
  try {
    const text = await readPrivateTextIfPresent(journalPath)
    if (text === undefined) throw Object.assign(new Error('journal absent'), { code: 'ENOENT' })
    const decoded = JSON.parse(text) as unknown
    if (!isJournal(decoded, archiveRoot)) throw new Error('standalone CLI update journal is invalid')
    journal = decoded
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const current = join(archiveRoot, 'payload', 'current')
      if (lock !== undefined) {
        const retained = join(archiveRoot, 'payload', 'retained')
        const failed = join(archiveRoot, 'payload', 'failed')
        const present = await Promise.all([current, retained, failed].map(async path => access(path).then(() => true, () => false)))
        if (present[0] !== true) {
          if (present[1] === true && present[2] === false) {
            await assertOwnedDirectory(retained, join(archiveRoot, 'payload'))
            await rename(retained, current)
          } else {
            throw new Error('standalone CLI update topology is ambiguous without its journal')
          }
        }
        await rm(lockPath, { force: true })
      }
      await assertOwnedDirectory(current, join(archiveRoot, 'payload'))
      return
    }
    throw error
  }
  if (lock !== undefined && isLiveLock(lock, retainedOwnerExecutablePath(lock.executablePath as string, archiveRoot))) {
    throw new Error('standalone CLI update is still in progress')
  }
  const current = join(archiveRoot, 'payload', 'current')
  const retained = join(archiveRoot, 'payload', 'retained')
  const failed = join(archiveRoot, 'payload', 'failed')
  const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)
  if (journal.phase === 'committed') {
    await removeOwnedDirectory(retained, join(archiveRoot, 'payload'))
  } else if (await exists(retained)) {
    if (await exists(current)) {
      await removeOwnedDirectory(failed, join(archiveRoot, 'payload'))
      await assertOwnedDirectory(current, join(archiveRoot, 'payload'))
      await rename(current, failed)
    }
    await assertOwnedDirectory(retained, join(archiveRoot, 'payload'))
    await rename(retained, current)
    await removeOwnedDirectory(failed, join(archiveRoot, 'payload'))
  } else if (!await exists(current)) {
    throw new Error('standalone CLI update recovery has no launchable payload')
  }
  await removeOwnedDirectory(journal.candidate, archiveRoot)
  await rm(journalPath, { force: true })
  await rm(lockPath, { force: true })
  await assertOwnedDirectory(current, join(archiveRoot, 'payload'))
}

function isJournal(value: unknown, archiveRoot: string): value is Journal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).toSorted().join(',') === 'candidate,phase,schemaVersion'
    && record.schemaVersion === 1 && typeof record.candidate === 'string'
    && new RegExp(`^${escapeRegularExpression(join(archiveRoot, '.harness-candidate-'))}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'iu').test(record.candidate)
    && ['prepared', 'retained', 'candidate-published', 'rollback-started', 'committed'].includes(String(record.phase))
}

function isLock(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).toSorted().join(',') === 'executablePath,expiresAtMs,processId,schemaVersion,startedBeforeMs,token'
    && record.schemaVersion === 1 && typeof record.token === 'string'
    && typeof record.processId === 'number' && Number.isSafeInteger(record.processId) && record.processId > 0
    && typeof record.expiresAtMs === 'number' && Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > 0
    && typeof record.executablePath === 'string' && isAbsolute(record.executablePath)
    && typeof record.startedBeforeMs === 'number' && Number.isSafeInteger(record.startedBeforeMs) && record.startedBeforeMs > 0
}

function isLiveLock(record: Record<string, unknown>, movedExecutable?: string): boolean {
  const executablePaths = [record.executablePath as string]
  if (movedExecutable !== undefined) executablePaths.push(movedExecutable)
  return processIdentityMatches(record.processId as number, executablePaths, record.startedBeforeMs as number)
}

/** Return the one retained-payload location an already-running POSIX owner can acquire during a durable swap. */
function retainedOwnerExecutablePath(executablePath: string, archiveRoot: string): string | undefined {
  const current = join(archiveRoot, 'payload', 'current')
  const suffix = relative(current, executablePath)
  if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return undefined
  return join(archiveRoot, 'payload', 'retained', suffix)
}

async function assertOwnedDirectory(path: string, expectedParent: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('standalone CLI recovery path is not a private directory')
  const [canonicalParent, canonicalPath] = await Promise.all([realpath(expectedParent), realpath(path)])
  const child = relative(canonicalParent, canonicalPath)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || dirname(canonicalPath) !== canonicalParent) {
    throw new Error('standalone CLI recovery path escapes its private parent')
  }
}

async function removeOwnedDirectory(path: string, expectedParent: string): Promise<void> {
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (details === undefined) return
  await assertOwnedDirectory(path, expectedParent)
  await rm(path, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 0, retryDelay: 25 })
}

async function readPrivateTextIfPresent(path: string): Promise<string | undefined> {
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (details === undefined) return undefined
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error('standalone CLI update record is not a private regular file')
  }
  return await readFile(path, 'utf8')
}

function processIdentityMatches(processId: number, executablePaths: readonly string[], startedBeforeMs: number): boolean {
  try { process.kill(processId, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
  if (process.platform === 'linux') {
    let actualExecutable: string
    try { actualExecutable = realpathSync(readlinkSync(`/proc/${String(processId)}/exe`)) } catch { return true }
    const expectedExecutables = executablePaths.flatMap((path) => {
      try { return [realpathSync(path)] } catch { return [] }
    })
    if (!expectedExecutables.includes(actualExecutable)) return false
    const content = readFileSync(`/proc/${String(processId)}/stat`, 'utf8')
    const closing = content.lastIndexOf(')')
    if (closing === -1) return true
    const startTicks = Number(content.slice(closing + 1).trim().split(/\s+/u)[19])
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    const hertz = Number(execFileSync('/usr/bin/getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
    const bootMs = Date.now() - uptime * 1000
    return Number.isFinite(startTicks) && Number.isFinite(hertz) && bootMs + startTicks / hertz * 1000 <= startedBeforeMs
  }
  const command = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/ps'
  const args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${String(processId)} -ErrorAction Stop; "$($p.Path)|$(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds())"`]
    : ['-p', String(processId), '-o', 'lstart=', '-o', 'comm=']
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim()
    if (process.platform === 'win32') {
      const separator = output.lastIndexOf('|')
      return separator > 0 && executablePaths.some(path => output.slice(0, separator).toLowerCase() === path.toLowerCase())
        && Number(output.slice(separator + 1)) <= startedBeforeMs
    }
    const match = output.match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u)
    const startedAt = match?.[1]
    const actualExecutable = match?.[2]
    return startedAt !== undefined && actualExecutable !== undefined
      && executablePaths.includes(actualExecutable) && Date.parse(startedAt) <= startedBeforeMs
  } catch { return true }
}

function escapeRegularExpression(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

if (process.argv[1] !== undefined && isLauncherEntry(process.argv[1])) {
  const requested = process.argv[2]
  if (requested !== 'bin.js' && requested !== 'dsh-bin.js') throw new Error('standalone CLI launcher entry is invalid')
  await recoverStandalonePayload()
  const entry = join(root, 'payload', 'current', 'cli', 'package', 'lib', requested)
  process.argv.splice(1, 2, entry)
  await import(pathToFileURL(entry).href)
}

function isLauncherEntry(path: string): boolean {
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
