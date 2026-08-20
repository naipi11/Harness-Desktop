import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeUnavailableError,
  type BrowserHandoffTransport,
  type DashboardNavigation,
  type RuntimeClient,
  type RuntimeConnector,
  type RuntimeLeaseStatus,
  type RuntimeStatus,
} from '@harness-desktop/dsh-host-local-runtime'
import type { WebInvocation } from '../src/args.ts'
import {
  createBrowserHandoffTransport,
  type BrowserBootstrapAccess,
} from '../src/browser.ts'
import { runWebInvocation, type WebIO } from '../src/web-daemon.ts'

const navigation = {
  origin: 'http://127.0.0.1:43123',
  handoff: {
    id: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
    expiresAt: 4_000,
  },
} as DashboardNavigation

afterEach(() => {
  vi.useRealTimers()
})

function captureIO(): { io: WebIO; stderr: () => string; stdout: () => string } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  let errors = ''
  stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
  return { io: { stdout, stderr }, stdout: () => output, stderr: () => errors }
}

function invocation(overrides: Partial<WebInvocation> = {}): WebInvocation {
  return { mode: 'web', open: true, lease: 'none', operation: 'open', ...overrides }
}

function runtimeFixture(overrides: Partial<RuntimeClient> = {}): {
  client: RuntimeClient
  connector: RuntimeConnector
  calls: {
    acquireBackgroundLease: ReturnType<typeof vi.fn>
    attachDashboard: ReturnType<typeof vi.fn>
    closeAttachment: ReturnType<typeof vi.fn>
    closeClient: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
    createBrowserHandoff: ReturnType<typeof vi.fn>
    releaseBackgroundLease: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  }
} {
  const closeAttachment = vi.fn(async () => {})
  const createBrowserHandoff = vi.fn(async () => navigation)
  const attachDashboard = vi.fn(async () => ({ close: closeAttachment, createBrowserHandoff }))
  const acquireBackgroundLease = vi.fn(async () => ({ id: 'web' }))
  const status = vi.fn(async (): Promise<RuntimeStatus> => ({
    state: 'running',
    runtimeId: 'runtime-public-id',
    dashboardOrigin: navigation.origin,
    backgroundLease: { id: 'web', state: 'present' },
  } as RuntimeStatus))
  const releaseBackgroundLease = vi.fn(async (): Promise<RuntimeLeaseStatus> => ({ id: 'web', state: 'absent' } as RuntimeLeaseStatus))
  const closeClient = vi.fn(async () => {})
  const client = {
    acquireBackgroundLease,
    attachDashboard,
    status,
    releaseBackgroundLease,
    close: closeClient,
    ...overrides,
  } as unknown as RuntimeClient
  const connect = vi.fn(async () => client)
  return {
    client,
    connector: { connect },
    calls: {
      acquireBackgroundLease,
      attachDashboard,
      closeAttachment,
      closeClient,
      connect,
      createBrowserHandoff,
      releaseBackgroundLease,
      status,
    },
  }
}

describe('Runtime Web invocation', () => {
  it('attaches one Dashboard and gives its one-use navigation only to the browser transport', async () => {
    const runtime = runtimeFixture()
    const io = captureIO()
    const open = vi.fn(async () => {})
    const opener: BrowserHandoffTransport = { open }

    const code = await runWebInvocation(invocation(), runtime.connector, opener, io.io)

    expect(code).toBe(0)
    expect(runtime.calls.connect).toHaveBeenCalledOnce()
    expect(runtime.calls.connect).toHaveBeenCalledWith({ start: true })
    expect(runtime.calls.attachDashboard).toHaveBeenCalledOnce()
    expect(runtime.calls.createBrowserHandoff).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(navigation)
    expect(runtime.calls.closeAttachment).toHaveBeenCalledOnce()
    expect(runtime.calls.closeClient).toHaveBeenCalledOnce()
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(navigation.handoff.id)
  })

  it('skips the Dashboard attachment and browser transport for --no-open', async () => {
    const runtime = runtimeFixture()
    const io = captureIO()
    const open = vi.fn(async () => {})

    expect(await runWebInvocation(invocation({ open: false }), runtime.connector, { open }, io.io)).toBe(0)
    expect(runtime.calls.connect).toHaveBeenCalledWith({ start: true })
    expect(runtime.calls.attachDashboard).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(runtime.calls.closeClient).toHaveBeenCalledOnce()
  })

  it('acquires the stable Web lease exactly once for a background invocation', async () => {
    const runtime = runtimeFixture()
    const io = captureIO()

    expect(await runWebInvocation(
      invocation({ open: false, lease: 'background' }),
      runtime.connector,
      { open: vi.fn() },
      io.io,
    )).toBe(0)
    expect(runtime.calls.acquireBackgroundLease).toHaveBeenCalledOnce()
    expect(io.stdout()).toBe('Web lease: web present\n')
  })

  it('inspects status through no-start discovery and renders only public Runtime fields', async () => {
    const runtime = runtimeFixture()
    const io = captureIO()

    expect(await runWebInvocation(
      invocation({ open: false, operation: 'status' }),
      runtime.connector,
      { open: vi.fn() },
      io.io,
    )).toBe(0)
    expect(runtime.calls.connect).toHaveBeenCalledWith({ start: false })
    expect(runtime.calls.status).toHaveBeenCalledOnce()
    expect(runtime.calls.acquireBackgroundLease).not.toHaveBeenCalled()
    expect(runtime.calls.releaseBackgroundLease).not.toHaveBeenCalled()
    expect(runtime.calls.attachDashboard).not.toHaveBeenCalled()
    expect(io.stdout()).toBe(
      'Runtime: running (runtime-public-id)\nDashboard: http://127.0.0.1:43123\nWeb lease: web present\n',
    )
  })

  it('reports an absent Runtime for status without retrying with start enabled', async () => {
    const io = captureIO()
    const connect = vi.fn(async () => { throw new RuntimeUnavailableError() })

    expect(await runWebInvocation(
      invocation({ open: false, operation: 'status' }),
      { connect },
      { open: vi.fn() },
      io.io,
    )).toBe(3)
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith({ start: false })
    expect(io.stdout()).toBe('')
    expect(io.stderr()).toContain('The local Harness Runtime is not running.')
    expect(io.stderr()).not.toMatch(/token|handoff/i)
  })

  it('releases only the named Web lease and treats an absent lease as success', async () => {
    const runtime = runtimeFixture()
    const io = captureIO()

    expect(await runWebInvocation(
      invocation({ open: false, operation: 'stop' }),
      runtime.connector,
      { open: vi.fn() },
      io.io,
    )).toBe(0)
    expect(runtime.calls.connect).toHaveBeenCalledWith({ start: false })
    expect(runtime.calls.releaseBackgroundLease).toHaveBeenCalledOnce()
    expect(runtime.calls.status).not.toHaveBeenCalled()
    expect(runtime.calls.attachDashboard).not.toHaveBeenCalled()
    expect(runtime.calls.closeClient).toHaveBeenCalledOnce()
    expect(io.stdout()).toBe('Web lease: web absent\n')
  })

  it('normalizes local failures without reflecting a raw cause or handoff', async () => {
    const raw = new Error(`private failure ${navigation.handoff.id}`)
    const runtime = runtimeFixture({ attachDashboard: vi.fn(async () => { throw raw }) })
    const io = captureIO()

    expect(await runWebInvocation(invocation(), runtime.connector, { open: vi.fn() }, io.io)).toBe(5)
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(navigation.handoff.id)
    expect(io.stderr()).not.toContain('private failure')
    expect(io.stderr()).toContain('Diagnostic:')
    expect(runtime.calls.closeClient).toHaveBeenCalledOnce()
  })
})

describe('browser handoff transport', () => {
  it('dispatches one owner-only file whose only handoff is in the exact Runtime form body', async () => {
    let documentPath = ''
    const transport = createBrowserHandoffTransport({
      parent: tmpdir(),
      now: () => 0,
      dispatch: async (url) => {
        expect(url).not.toContain(navigation.handoff.id)
        documentPath = fileURLToPath(url)
        const html = await readFile(documentPath, 'utf8')
        expect(html).toContain('method="post"')
        expect(html).toContain('action="http://127.0.0.1:43123/_harness/handoff"')
        expect(html).toContain(`type="hidden" name="handoff" value="${navigation.handoff.id}"`)
        expect(html.match(new RegExp(navigation.handoff.id, 'gu'))).toHaveLength(1)
        if (process.platform !== 'win32') {
          expect((await stat(fileURLToPath(new URL('.', url)))).mode & 0o777).toBe(0o700)
          expect((await stat(documentPath)).mode & 0o777).toBe(0o600)
        }
      },
    })

    await transport.open(navigation)

    await expect(stat(documentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(documentPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a broader-access bootstrap and removes the unpublished document once', async () => {
    const remove = vi.fn(async (path: string) => { await rm(dirname(path), { recursive: true, force: true }) })
    const access: BrowserBootstrapAccess = {
      protectDirectory: vi.fn(async () => {}),
      protectFile: vi.fn(async () => {}),
      verifyDirectory: vi.fn(async () => { throw new Error('broader directory access') }),
      verifyFile: vi.fn(async () => {}),
    }
    const transport = createBrowserHandoffTransport({
      parent: tmpdir(),
      now: () => 0,
      access,
      remove,
      dispatch: vi.fn(async () => {}),
    })

    await expect(transport.open(navigation)).rejects.toThrow('broader directory access')
    expect(remove).toHaveBeenCalledOnce()
  })

  it('uses one cleanup after successful dispatch or dispatch failure', async () => {
    const successRemove = vi.fn(async (path: string) => { await rm(dirname(path), { recursive: true, force: true }) })
    const failedRemove = vi.fn(async (path: string) => { await rm(dirname(path), { recursive: true, force: true }) })
    const success = createBrowserHandoffTransport({
      parent: tmpdir(), now: () => 0, remove: successRemove, dispatch: vi.fn(async () => {}),
    })
    const failed = createBrowserHandoffTransport({
      parent: tmpdir(), now: () => 0, remove: failedRemove,
      dispatch: vi.fn(async () => { throw new Error('browser dispatch failed') }),
    })

    await success.open(navigation)
    await expect(failed.open(navigation)).rejects.toThrow('browser dispatch failed')

    expect(successRemove).toHaveBeenCalledOnce()
    expect(failedRemove).toHaveBeenCalledOnce()
  })

  it('expires and cleans a document whose dispatch never settles', async () => {
    vi.useFakeTimers()
    const remove = vi.fn(async (path: string) => { await rm(dirname(path), { recursive: true, force: true }) })
    let markDispatched: (() => void) | undefined
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve })
    const transport = createBrowserHandoffTransport({
      parent: tmpdir(),
      now: () => 1_000,
      remove,
      dispatch: async () => {
        markDispatched?.()
        await new Promise<never>(() => {})
      },
    })

    void transport.open({
      ...navigation,
      handoff: { ...navigation.handoff, expiresAt: 1_100 },
    })
    await dispatched
    await vi.advanceTimersByTimeAsync(100)

    expect(remove).toHaveBeenCalledOnce()
  })

  it('rejects non-loopback targets and non-opaque handoffs before dispatch', async () => {
    const dispatch = vi.fn(async () => {})
    const transport = createBrowserHandoffTransport({ parent: tmpdir(), now: () => 0, dispatch })

    await expect(transport.open({
      ...navigation, origin: 'http://localhost:43123' as DashboardNavigation['origin'],
    })).rejects.toThrow('exact http://127.0.0.1 origin')
    await expect(transport.open({
      ...navigation, handoff: { ...navigation.handoff, id: 'short' as DashboardNavigation['handoff']['id'] },
    })).rejects.toThrow('opaque')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
