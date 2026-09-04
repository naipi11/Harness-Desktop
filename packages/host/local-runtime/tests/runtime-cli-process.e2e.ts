/** Independent source clients converge on one Runtime and one durable Web lease. */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const connectorEntry = pathToFileURL(join(process.cwd(), 'packages', 'host', 'local-runtime', 'src', 'runtime-client.ts')).href
const autoStartClient = fileURLToPath(new URL('./fixtures/runtime-autostart-client.ts', import.meta.url))
const execArgvHook = pathToFileURL(fileURLToPath(new URL('./fixtures/runtime-exec-argv-hook.mjs', import.meta.url))).href
let root: string | undefined
let runtimePid: number | undefined
let runtimeHome: string | undefined

afterEach(async () => {
  if (runtimePid === undefined && runtimeHome !== undefined) {
    try {
      const endpoint = JSON.parse(await readFile(join(runtimeHome, 'runtime-endpoint.json'), 'utf8')) as {
        process?: { pid?: unknown }
      }
      if (typeof endpoint.process?.pid === 'number') runtimePid = endpoint.process.pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (runtimePid !== undefined) {
    try {
      process.kill(runtimePid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  runtimePid = undefined
  runtimeHome = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function clientScript(action: 'acquire' | 'release'): string {
  return [
    `const { createRuntimeConnector } = await import(${JSON.stringify(connectorEntry)})`,
    "const connector = createRuntimeConnector({ input: { env: process.env, homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '' } })",
    'const client = await connector.connect({ start: true })',
    action === 'acquire'
      ? 'const lease = await client.acquireBackgroundLease()'
      : 'const lease = await client.releaseBackgroundLease()',
    'const status = await client.status()',
    'await client.close()',
    'process.stdout.write(JSON.stringify({ lease, runtimeId: status.runtimeId }))',
  ].join('; ')
}

async function runClient(home: string, action: 'acquire' | 'release') {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import', 'tsx/esm', '--input-type=module', '--eval', clientScript(action),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: home, DSH_HOME: undefined },
    windowsHide: true,
    timeout: 90_000,
  })
  return { value: JSON.parse(stdout) as { lease: { id: string; state?: string }; runtimeId: string }, stderr }
}

describe('independent public Runtime clients', () => {
  it('filters eval invocation fields while preserving the inherited source hook for one Runtime child', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-eval-exec-argv-'))
    const home = join(root, 'home')
    runtimeHome = home
    const trace = join(root, 'eval-exec-argv-pids.txt')

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', execArgvHook,
      '--import', 'tsx/esm',
      '--input-type=module',
      '--eval', clientScript('acquire'),
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HARNESS_HOME: home,
        DSH_HOME: undefined,
        HARNESS_RUNTIME_EXEC_ARGV_TRACE: trace,
      },
      windowsHide: true,
      timeout: 90_000,
    })
    const endpoint = JSON.parse(await readFile(join(home, 'runtime-endpoint.json'), 'utf8')) as {
      process: { pid: number }
    }
    runtimePid = endpoint.process.pid
    const pids = (await readFile(trace, 'utf8')).trim().split(/\r?\n/u).map(Number)

    expect(typeof (JSON.parse(stdout) as { runtimeId?: unknown }).runtimeId).toBe('string')
    expect(stderr).not.toMatch(/accessToken|runtime-endpoint|Bearer /)
    expect(pids).toHaveLength(2)
    expect(new Set(pids).size).toBe(2)
    expect(pids).toContain(endpoint.process.pid)
    process.kill(endpoint.process.pid, 'SIGKILL')
    await waitForProcessExit(endpoint.process.pid)
    expect(() => process.kill(endpoint.process.pid, 0)).toThrow()
    runtimePid = undefined
  }, 120_000)

  it('preserves inherited source loader hooks when auto-starting the detached Runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-inherited-exec-argv-'))
    const home = join(root, 'home')
    const trace = join(root, 'exec-argv-pids.txt')

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', execArgvHook,
      '--import', 'tsx/esm',
      autoStartClient,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HARNESS_HOME: home,
        DSH_HOME: undefined,
        HARNESS_RUNTIME_EXEC_ARGV_TRACE: trace,
      },
      windowsHide: true,
      timeout: 90_000,
    })
    const endpoint = JSON.parse(await readFile(join(home, 'runtime-endpoint.json'), 'utf8')) as {
      process: { pid: number }
    }
    runtimePid = endpoint.process.pid
    const pids = (await readFile(trace, 'utf8')).trim().split(/\r?\n/u).map(Number)

    const output: unknown = JSON.parse(stdout)
    expect(typeof (output as { runtimeId?: unknown }).runtimeId).toBe('string')
    expect(stderr).not.toMatch(/accessToken|runtime-endpoint|Bearer /)
    expect(new Set(pids).size).toBeGreaterThanOrEqual(2)
    expect(pids).toContain(endpoint.process.pid)
  }, 120_000)

  it('racing starters attach to one owner and later release the same named Web lease', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-racing-clients-'))
    const home = join(root, 'home')

    const [first, second] = await Promise.all([runClient(home, 'acquire'), runClient(home, 'acquire')])
    expect(first.value.runtimeId).toBe(second.value.runtimeId)
    expect(first.value.lease).toEqual({ id: 'web' })
    expect(second.value.lease).toEqual({ id: 'web' })
    expect(first.stderr + second.stderr).not.toMatch(/accessToken|runtime-endpoint|Bearer /)

    const stopped = await runClient(home, 'release')
    expect(stopped.value.runtimeId).toBe(first.value.runtimeId)
    expect(stopped.value.lease).toEqual({ id: 'web', state: 'absent' })
    const endpoint = JSON.parse(await readFile(join(home, 'runtime-endpoint.json'), 'utf8')) as {
      process: { pid: number }
      accessToken: string
    }
    runtimePid = endpoint.process.pid
    expect(JSON.stringify([first.value, second.value, stopped.value])).not.toContain(endpoint.accessToken)
  }, 120_000)
})

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`Runtime process ${String(pid)} did not exit`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
