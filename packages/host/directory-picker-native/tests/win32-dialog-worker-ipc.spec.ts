/** A showing notification is not the terminal worker result and must leave IPC connected. */

import { afterEach, expect, it, vi } from 'vitest'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

const { loadBindings, runDialog } = vi.hoisted(() => ({
  loadBindings: vi.fn(async () => ({})),
  runDialog: vi.fn((_bindings: unknown, _title: string, showing: (threadId: number) => void): string | null => {
    showing(7)
    return 'C:\\选择的目录'
  }),
}))
vi.mock('../src/win32-dialog-bindings.ts', () => ({ loadWin32DialogBindings: loadBindings }))
vi.mock('../src/win32-dialog-logic.ts', () => ({ runFolderDialog: runDialog }))
const originalSend = Object.getOwnPropertyDescriptor(process, 'send')
const originalDisconnect = Object.getOwnPropertyDescriptor(process, 'disconnect')
const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
const originalDisconnectListeners = new Set(process.listeners('disconnect'))

afterEach(() => {
  for (const [name, descriptor] of [
    ['send', originalSend], ['disconnect', originalDisconnect], ['connected', originalConnected],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(process, name)
    else Object.defineProperty(process, name, descriptor)
  }
  for (const listener of process.listeners('disconnect')) {
    if (!originalDisconnectListeners.has(listener)) process.removeListener('disconnect', listener)
  }
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('keeps the showing send connected and disconnects only after the terminal send flushes', async () => {
  const sends: { message: Win32DialogWorkerMessage; callback?: () => void }[] = []
  const disconnect = vi.fn()
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  Object.defineProperty(process, 'disconnect', { value: disconnect, configurable: true })
  Object.defineProperty(process, 'send', {
    value: (message: Win32DialogWorkerMessage, callback?: () => void) => {
      sends.push({ message, ...(callback === undefined ? {} : { callback }) })
      return true
    },
    configurable: true,
  })
  vi.stubEnv('DSH_DIALOG_TITLE', 'Select Workspace Directory')

  await import('../src/win32-dialog-worker.ts')
  await vi.waitFor(() => { expect(sends).toHaveLength(2) })
  expect(sends.map(send => send.message.kind)).toEqual(['showing', 'done'])
  sends[0]?.callback?.()
  expect(disconnect).not.toHaveBeenCalled()
  expect(sends[1]?.callback).toBeTypeOf('function')
  sends[1]?.callback?.()
  expect(disconnect).toHaveBeenCalledOnce()
})
