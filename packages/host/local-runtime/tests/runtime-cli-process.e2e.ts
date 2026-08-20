/** Independent source clients converge on one Runtime and one durable Web lease. */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const connectorEntry = pathToFileURL(join(process.cwd(), 'packages', 'host', 'local-runtime', 'src', 'runtime-client.ts')).href
let root: string | undefined
let runtimePid: number | undefined

afterEach(async () => {
  if (runtimePid !== undefined) {
    try {
      process.kill(runtimePid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  runtimePid = undefined
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
