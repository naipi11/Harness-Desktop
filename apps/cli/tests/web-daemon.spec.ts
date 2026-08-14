import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  launchWebDaemon,
  resolveWebDaemonInvocation,
  type LaunchWebDaemonInput,
  type WebDaemonAdapters,
} from '../src/web-daemon.ts'

class TestChild extends EventEmitter {
  pid: number | undefined
  readonly kill = vi.fn(() => true)
  readonly unref = vi.fn()

  constructor(pid = 417) {
    super()
    this.pid = pid
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal)
  }
}

interface AdapterFixture {
  adapters: WebDaemonAdapters
  closeLog: ReturnType<typeof vi.fn>
  createLogDirectory: ReturnType<typeof vi.fn>
  createLogRoot: ReturnType<typeof vi.fn>
  home: ReturnType<typeof vi.fn>
  openLog: ReturnType<typeof vi.fn>
  spawnChild: ReturnType<typeof vi.fn>
}

function adaptersFor(child: TestChild): AdapterFixture {
  const home = vi.fn(() => '/dsh-home')
  const createLogRoot = vi.fn()
  const createLogDirectory = vi.fn(() => '/dsh-home/logs/web-abc123')
  const openLog = vi.fn(() => 9)
  const closeLog = vi.fn()
  const spawnChild = vi.fn(() => child)
  return {
    adapters: {
      home,
      mkdirSync: createLogRoot,
      mkdtempSync: createLogDirectory,
      openSync: openLog,
      closeSync: closeLog,
      spawn: spawnChild,
    },
    closeLog,
    createLogDirectory,
    createLogRoot,
    home,
    openLog,
    spawnChild,
  }
}

function captureFailure(run: () => unknown): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected operation to fail')
}

function expectFailure(error: unknown, message: string, cause?: unknown): void {
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error('expected an Error')
  expect(error.message).toContain(message)
  if (cause !== undefined) expect(error.cause).toBe(cause)
}

const input: LaunchWebDaemonInput = {
  entry: '/dsh/bin.js',
  runtimeArgs: [],
  patches: [],
  args: [],
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
    const fixture = adaptersFor(child)
    const launched = launchWebDaemon({
      entry: '/dsh/bin.js',
      runtimeArgs: ['--import', 'tsx/esm'],
      patches: ['overlay.yml'],
      args: ['--port', '0'],
    }, fixture.adapters)

    expect(child.unref).not.toHaveBeenCalled()
    child.emit('spawn')

    await expect(launched).resolves.toEqual({ pid: 417, logPath: join(logDirectory, 'server.log') })
    expect(fixture.createLogRoot).toHaveBeenCalledWith(logs, { recursive: true, mode: 0o700 })
    expect(fixture.createLogDirectory).toHaveBeenCalledWith(join(logs, 'web-'))
    expect(fixture.openLog).toHaveBeenCalledWith(join(logDirectory, 'server.log'), 'wx', 0o600)
    expect(fixture.spawnChild).toHaveBeenCalledWith(
      process.execPath,
      ['--import', 'tsx/esm', '/dsh/bin.js', '--profile', 'web', '--patch', 'overlay.yml', '--port', '0'],
      expect.objectContaining({ detached: true, windowsHide: true, stdio: ['ignore', 9, 9] }),
    )
    expect(fixture.closeLog).toHaveBeenCalledWith(9)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('reports a log-root failure before opening or spawning', () => {
    const child = new TestChild()
    const fixture = adaptersFor(child)
    const failure = new Error('mkdir denied')
    fixture.createLogRoot.mockImplementation(() => { throw failure })

    expectFailure(captureFailure(() => launchWebDaemon(input, fixture.adapters)), 'web daemon log operation failed', failure)
    expect(fixture.openLog).not.toHaveBeenCalled()
    expect(fixture.spawnChild).not.toHaveBeenCalled()
  })

  it('reports a log-open failure before spawning', () => {
    const child = new TestChild()
    const fixture = adaptersFor(child)
    const failure = new Error('open denied')
    fixture.openLog.mockImplementation(() => { throw failure })

    expectFailure(captureFailure(() => launchWebDaemon(input, fixture.adapters)), 'web daemon log operation failed', failure)
    expect(fixture.spawnChild).not.toHaveBeenCalled()
  })

  it('preserves a synchronous spawn exception when descriptor cleanup also fails', () => {
    const child = new TestChild()
    const fixture = adaptersFor(child)
    const spawnFailure = new Error('spawn threw')
    fixture.spawnChild.mockImplementation(() => { throw spawnFailure })
    fixture.closeLog.mockImplementation(() => { throw new Error('close failed') })

    expectFailure(captureFailure(() => launchWebDaemon(input, fixture.adapters)), 'web daemon spawn failed', spawnFailure)
    expect(fixture.closeLog).toHaveBeenCalledWith(9)
  })

  it('preserves an asynchronous spawn error when descriptor cleanup also fails', async () => {
    const child = new TestChild()
    const fixture = adaptersFor(child)
    const spawnFailure = new Error('permission denied')
    fixture.closeLog.mockImplementation(() => { throw new Error('close failed') })
    const launched = launchWebDaemon(input, fixture.adapters)

    child.emit('error', spawnFailure)

    const failure = await launched.catch((error: unknown): unknown => error)
    expectFailure(failure, 'web daemon spawn failed', spawnFailure)
    expect(fixture.closeLog).toHaveBeenCalledWith(9)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('publishes and detaches a valid spawned child when the parent descriptor cannot close', async () => {
    const child = new TestChild()
    const fixture = adaptersFor(child)
    fixture.closeLog.mockImplementation(() => { throw new Error('close failed') })
    const launched = launchWebDaemon(input, fixture.adapters)

    child.emit('spawn')

    await expect(launched).resolves.toEqual({ pid: 417, logPath: join(logDirectory, 'server.log') })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('terminates and awaits a spawned child whose process id is missing before rejecting', async () => {
    const child = new TestChild()
    child.pid = undefined
    const fixture = adaptersFor(child)
    let completed = false
    const observed = launchWebDaemon(input, fixture.adapters).then(
      (value): { value: { pid: number; logPath: string } } | { error: unknown } => ({ value }),
      (error: unknown): { value: { pid: number; logPath: string } } | { error: unknown } => ({ error }),
    ).finally(() => { completed = true })

    child.emit('spawn')
    await Promise.resolve()

    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.unref).not.toHaveBeenCalled()
    expect(completed).toBe(false)

    child.emitExit(null, 'SIGTERM')
    const result = await observed
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('expected launch failure')
    expectFailure(result.error, 'missing process id')
  })

  it('keeps a missing-pid child parent-owned until exit when termination throws', async () => {
    const child = new TestChild()
    child.pid = undefined
    child.kill.mockImplementation(() => { throw new Error('kill failed') })
    const fixture = adaptersFor(child)
    let completed = false
    const observed = launchWebDaemon(input, fixture.adapters).catch((error: unknown): unknown => error)
      .finally(() => { completed = true })

    child.emit('spawn')
    await Promise.resolve()

    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.unref).not.toHaveBeenCalled()
    expect(completed).toBe(false)

    child.emitExit(1, null)
    expectFailure(await observed, 'missing process id')
  })

  it('lets the first terminal startup event own settlement', async () => {
    const failedChild = new TestChild()
    const failedFixture = adaptersFor(failedChild)
    const spawnFailure = new Error('permission denied')
    const failed = launchWebDaemon(input, failedFixture.adapters)
    failedChild.emit('error', spawnFailure)
    failedChild.emit('spawn')

    await expect(failed).rejects.toMatchObject({ cause: spawnFailure })
    expect(failedFixture.closeLog).toHaveBeenCalledOnce()
    expect(failedChild.unref).not.toHaveBeenCalled()

    const startedChild = new TestChild()
    const startedFixture = adaptersFor(startedChild)
    const started = launchWebDaemon(input, startedFixture.adapters)
    startedChild.emit('spawn')
    startedChild.emit('error', new Error('late error'))

    await expect(started).resolves.toMatchObject({ pid: 417 })
    expect(startedFixture.closeLog).toHaveBeenCalledOnce()
    expect(startedChild.unref).toHaveBeenCalledOnce()
  })
})
