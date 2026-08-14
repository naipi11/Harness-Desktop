/**
 * Built-entry acceptance for a detached Web CLI invocation.
 *
 * This is opt-in because it starts and tears down a real web server after the
 * release artifacts have been built.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
const requireBuiltArtifacts = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'

/** Run the published CLI and collect its parent-process result. */
async function runBuiltBin(args: readonly string[], home: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const result = await execa(process.execPath, [builtBin, ...args], {
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
  if (result.timedOut) throw new Error(`dsh built bin did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
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

describe.skipIf(!requireBuiltArtifacts)('dsh built web daemon', () => {
  it('returns after starting a detached server that serves the built UI', async () => {
    expect(existsSync(builtBin), `missing built CLI ${resolve(builtBin)}; run pnpm run build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build`).toBe(true)
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-daemon-'))
    let pid: number | undefined
    try {
      const parent = await runBuiltBin(['web', '--daemon', '--port', '0'], home)
      expect(parent).toMatchObject({ code: 0, stderr: '' })
      const match = parent.stdout.match(/^dsh web: started detached process (\d+); log: (.+)\n$/u)
      expect(match).not.toBeNull()
      if (match?.[1] === undefined || match[2] === undefined) throw new Error('detached parent did not report a process id and log')
      pid = Number(match[1])
      const log = await waitForLogLine(match[2], /dsh web: http:\/\/127\.0\.0\.1:\d+/u)
      await expect(fetch(urlFromLog(log))).resolves.toMatchObject({ ok: true })
    } finally {
      if (pid !== undefined) await stopDetachedProcess(pid)
      await rm(home, { recursive: true, force: true })
    }
  }, 50_000)
})
