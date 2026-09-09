/** Child launch mode must follow the executable, not the Runtime's consumed environment marker. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnOptions } from 'node:child_process'
import { spawnDialogWorker } from '../src/win32-dialog-host.ts'

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => undefined),
}))
vi.mock('node:child_process', () => ({ spawn }))
const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')

afterEach(() => {
  if (electronDescriptor === undefined) Reflect.deleteProperty(process.versions, 'electron')
  else Object.defineProperty(process.versions, 'electron', electronDescriptor)
  vi.unstubAllEnvs()
  spawn.mockClear()
})

describe('spawnDialogWorker', () => {
  it.each([undefined, '0'])('launches Electron as Node after the Runtime consumes marker %s', (marker) => {
    Object.defineProperty(process.versions, 'electron', { value: '43.4.0', configurable: true })
    vi.stubEnv('ELECTRON_RUN_AS_NODE', marker)

    spawnDialogWorker({ title: 'Select Workspace Directory' })

    expect(spawn).toHaveBeenCalledOnce()
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toContain('--import')
    expect(options.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.env?.DSH_DIALOG_TITLE).toBe('Select Workspace Directory')
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc'])
    expect(options.windowsHide).toBe(true)
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(marker)
  })

  it('does not add an Electron mode flag to a plain Node child', () => {
    Reflect.deleteProperty(process.versions, 'electron')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined)

    spawnDialogWorker({ title: 'Plain Node picker' })

    expect(spawn).toHaveBeenCalledOnce()
    const [command, , options] = spawn.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(options.env?.DSH_DIALOG_TITLE).toBe('Plain Node picker')
    expect(options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
