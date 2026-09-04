/** Bounded installed-artifact cleanup command behavior. */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  exactWindowsTestProcessIds,
  runBoundedTestCommand,
  type WindowsTestProcessCleanupDependencies,
} from './support/bounded-test-command.ts'

describe('runBoundedTestCommand', () => {
  it('terminates a provider that does not return before the cleanup timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-bounded-cleanup-'))
    const processIdPath = join(root, 'process-id.txt')
    let processId: number | undefined
    try {
      await mkdir(root, { recursive: true })
      const startedAt = Date.now()
      await expect(runBoundedTestCommand(process.execPath, [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 2000)",
        processIdPath,
      ], {
        failure: 'native update e2e: process inspection',
        timeoutMs: 100,
      })).rejects.toThrow('native update e2e: process inspection timed out')
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      processId = Number.parseInt(await readFile(processIdPath, 'utf8'), 10)
      await expectProcessAbsent(processId)
    } finally {
      if (processId !== undefined) {
        try { process.kill(processId, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 5_000)

  it('does not continue exact cleanup after process inspection times out', async () => {
    const run = vi.fn(async () => { throw new Error('native update e2e: process inspection timed out') })
    const dependencies: WindowsTestProcessCleanupDependencies = {
      run,
      systemTool: vi.fn(() => 'powershell.exe'),
    }

    await expect(exactWindowsTestProcessIds('C:\\isolated\\Harness Desktop.exe', {}, dependencies))
      .rejects.toThrow('native update e2e: process inspection timed out')
    expect(run).toHaveBeenCalledOnce()
  })
})

async function expectProcessAbsent(processId: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try { process.kill(processId, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 25) })
  }
  throw new Error('timed-out cleanup provider remained alive')
}
