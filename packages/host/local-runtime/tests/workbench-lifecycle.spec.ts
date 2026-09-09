/** Close/start overlap must not return the shell being terminated. */
import { expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createWorkbenchService } from '../src/workbench.ts'

it('waits for a closing shell before opening a replacement in the same workspace', async () => {
  const closed = Promise.withResolvers<boolean>()
  let number = 0
  const spawn = vi.fn(() => {
    number += 1
    const first = number === 1
    return { pid: number, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      collected: {}, terminate() {}, waitForExit: () => first ? closed.promise : Promise.resolve(true),
      done: new Promise<never>(() => {}) }
  })
  const service = createWorkbenchService({ workspacePath: () => process.cwd(), subprocess: { spawn, resolveExecutable: async () => 'shell' } })
  try {
    const first = await service.openTerminal('owner', 'workspace')
    const closing = service.closeTerminal('owner', first.id)
    let opened = false
    const opening = service.openTerminal('owner', 'workspace').then((value) => { opened = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    expect(opened).toBe(false)
    closed.resolve(true)
    await closing
    const second = await opening
    expect(second.id).not.toBe(first.id)
    expect(spawn).toHaveBeenCalledTimes(2)
  } finally { closed.resolve(true); await service.close() }
})
