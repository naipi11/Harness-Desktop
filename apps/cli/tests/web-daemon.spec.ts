import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  launchWebDaemon,
  resolveWebDaemonInvocation,
  type WebDaemonAdapters,
} from '../src/web-daemon.ts'

class TestChild extends EventEmitter {
  pid = 417
  unref = vi.fn()
}

function adaptersFor(child: TestChild): WebDaemonAdapters {
  return {
    home: () => '/dsh-home',
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/dsh-home/logs/web-abc123'),
    openSync: vi.fn(() => 9),
    closeSync: vi.fn(),
    spawn: vi.fn(() => child),
  }
}

const home = '/dsh-home'
const logs = join(home, 'logs')
const logDirectory = join(logs, 'web-abc123')

describe('web daemon invocation', () => {
  it('removes daemon aliases and lets help keep the parent process attached', () => {
    expect(resolveWebDaemonInvocation(['--port', '0', '--daemon', '--background']))
      .toEqual({ args: ['--port', '0'], detached: true })
    expect(resolveWebDaemonInvocation(['--daemon', '--help']))
      .toEqual({ args: ['--help'], detached: false })
  })
})

describe('web daemon launch', () => {
  it('creates a private log and detaches only after the child starts', async () => {
    const child = new TestChild()
    const adapters = adaptersFor(child)
    const launched = launchWebDaemon({
      entry: '/dsh/bin.js',
      patches: ['overlay.yml'],
      args: ['--port', '0'],
    }, adapters)

    child.emit('spawn')

    await expect(launched).resolves.toEqual({ pid: 417, logPath: join(logDirectory, 'server.log') })
    expect(adapters.mkdirSync).toHaveBeenCalledWith(logs, { recursive: true, mode: 0o700 })
    expect(adapters.mkdtempSync).toHaveBeenCalledWith(join(logs, 'web-'))
    expect(adapters.openSync).toHaveBeenCalledWith(join(logDirectory, 'server.log'), 'wx', 0o600)
    expect(adapters.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/dsh/bin.js', '--profile', 'web', '--patch', 'overlay.yml', '--port', '0'],
      expect.objectContaining({ detached: true, windowsHide: true, stdio: ['ignore', 9, 9] }),
    )
    expect(adapters.closeSync).toHaveBeenCalledWith(9)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('closes the parent descriptor and names startup failures', async () => {
    const child = new TestChild()
    const adapters = adaptersFor(child)
    const launched = launchWebDaemon({ entry: '/dsh/bin.js', patches: [], args: [] }, adapters)

    child.emit('error', new Error('permission denied'))

    await expect(launched).rejects.toThrow('web daemon spawn failed')
    expect(adapters.closeSync).toHaveBeenCalledWith(9)
    expect(child.unref).not.toHaveBeenCalled()
  })
})
