/**
 * Source- and built-entry acceptance for a detached Web CLI invocation.
 *
 * This is opt-in because it starts and tears down a real web server after the
 * frontend has been built. `DSH_EXAMPLE_MODE=lib` selects the published entry;
 * the default executes the source entry through the production tsx runtime.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceBin = join(repoRoot, 'apps/cli/src/bin.ts')
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
const requireWebDaemonSmoke = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'

/** Resolve the source tsx or published plain-Node launch vector for this test run. */
function cliCommand(): { args: string[]; executable: string; label: 'built' | 'source' } {
  if (process.env.DSH_EXAMPLE_MODE === 'lib') return { executable: process.execPath, args: [builtBin], label: 'built' }
  return { executable: process.execPath, args: ['--import', 'tsx/esm', sourceBin], label: 'source' }
}

/** Run the selected CLI entry and collect its parent-process result. */
async function runCli(args: readonly string[], home: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const command = cliCommand()
  const result = await execa(command.executable, [...command.args, ...args], {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'dsh-web-daemon-smoke-key',
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
    },
    extendEnv: false,
    input: '',
    reject: false,
    stripFinalNewline: false,
    timeout: 25_000,
  })
  if (result.timedOut) throw new Error(`dsh ${command.label} bin did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return { code: result.exitCode ?? -1, stderr: result.stderr, stdout: result.stdout }
}

/** Wait until one private child log includes its settled web URL. */
async function waitForLogLine(logPath: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const log = await readFile(logPath, 'utf8')
      if (pattern.test(log)) return log
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`detached web server did not write ${String(pattern)} to ${logPath}`)
}

/** Extract the launched loopback URL from a settled child log. */
function urlFromLog(log: string): string {
  const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/u)
  if (match?.[1] === undefined) throw new Error('detached web server did not report its URL')
  return match[1]
}

/** Wait until a stopped child no longer has a process table entry. */
async function waitForStoppedProcess(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`detached web server ${String(pid)} did not stop within 10s`)
}

/** Stop the detached server and await its process-tree exit. */
async function stopDetachedProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await waitForStoppedProcess(pid)
}

/** The process and log reported by a successfully spawned detached server. */
interface DetachedWebServer {
  logPath: string
  pid: number
}

/** Record a daemon's resources before asserting the parent transcript exactly. */
function recordedDetachedWebServer(stdout: string): DetachedWebServer {
  const match = stdout.match(/dsh web: started detached process (\d+); log: ([^\r\n]+)/u)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`detached parent did not report a process id and log. stdout:\n${stdout}`)
  }
  return { pid: Number(match[1]), logPath: match[2] }
}

/** Launch one alias, verify the served UI, and always clean up its process and home. */
async function verifyDetachedWebAlias(alias: '--background' | '--daemon'): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-daemon-'))
  let server: DetachedWebServer | undefined
  let primaryError: unknown
  const cleanupErrors: unknown[] = []
  try {
    try {
      const parent = await runCli(['web', alias, '--port', '0'], home)
      server = recordedDetachedWebServer(parent.stdout)
      expect(parent).toEqual({
        code: 0,
        stderr: '',
        stdout: `dsh web: started detached process ${String(server.pid)}; log: ${server.logPath}\n`,
      })
      const log = await waitForLogLine(server.logPath, /dsh web: http:\/\/127\.0\.0\.1:\d+/u)
      await expect(fetch(urlFromLog(log))).resolves.toMatchObject({ ok: true })
    } catch (error: unknown) {
      primaryError = error
    }
  } finally {
    try {
      if (server !== undefined) await stopDetachedProcess(server.pid)
    } catch (error: unknown) {
      cleanupErrors.push(error)
    } finally {
      try {
        await rm(home, { recursive: true, force: true })
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'detached Web assertion and cleanup both failed')
    }
    throw primaryError
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'detached Web cleanup failed')
}

describe.skipIf(!requireWebDaemonSmoke)('dsh web daemon source and built launch', () => {
  it('returns after --daemon starts a detached server that serves the UI', async () => {
    const command = cliCommand()
    const entry = command.label === 'built' ? builtBin : sourceBin
    expect(existsSync(entry), `missing ${command.label} CLI ${resolve(entry)}; run pnpm run build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build`).toBe(true)
    await verifyDetachedWebAlias('--daemon')
  }, 50_000)

  it('returns after --background starts a detached server that serves the UI', async () => {
    const command = cliCommand()
    const entry = command.label === 'built' ? builtBin : sourceBin
    expect(existsSync(entry), `missing ${command.label} CLI ${resolve(entry)}; run pnpm run build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build`).toBe(true)
    await verifyDetachedWebAlias('--background')
  }, 50_000)
})
