import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserHandoffTransport,
  RuntimeClient,
  RuntimeConnector,
} from '@harness-desktop/dsh-host-local-runtime'
import { runCli } from '../src/main.ts'
import type { TerminalIO } from '../src/terminal-client.ts'

function captureIO(): { io: TerminalIO; stdout: () => string } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  return {
    io: { stdin, stdout, stderr, workspace: 'C:\\workspace', columns: 80, colorDepth: 1 },
    stdout: () => output,
  }
}

function fixture(): {
  connector: RuntimeConnector
  opener: BrowserHandoffTransport
  acquire: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
} {
  const acquire = vi.fn(async () => ({ id: 'web' }))
  const close = vi.fn(async () => {})
  const client = { acquireBackgroundLease: acquire, close } as unknown as RuntimeClient
  const connect = vi.fn(async () => client)
  const open = vi.fn(async () => {})
  return { connector: { connect }, opener: { open }, acquire, connect, open }
}

describe('harness and dsh Web compatibility', () => {
  it.each(['harness', 'dsh'] as const)('%s routes --daemon through the same Runtime lease operation', async (commandName) => {
    const runtime = fixture()
    const streams = captureIO()

    const code = await runCli(commandName, ['web', '--daemon', '--no-open'], {
      io: streams.io,
      connector: runtime.connector,
      opener: runtime.opener,
    })

    expect(code).toBe(0)
    expect(runtime.connect).toHaveBeenCalledOnce()
    expect(runtime.connect).toHaveBeenCalledWith({ start: true })
    expect(runtime.acquire).toHaveBeenCalledOnce()
    expect(runtime.open).not.toHaveBeenCalled()
    expect(streams.stdout()).toBe('Web lease: web present\n')
  })

  it('maps --background to the same named lease as --daemon', async () => {
    const runtime = fixture()
    const first = captureIO()
    const second = captureIO()

    await runCli('harness', ['web', '--daemon', '--no-open'], {
      io: first.io, connector: runtime.connector, opener: runtime.opener,
    })
    await runCli('dsh', ['web', '--background', '--no-open'], {
      io: second.io, connector: runtime.connector, opener: runtime.opener,
    })

    expect(runtime.acquire).toHaveBeenCalledTimes(2)
    expect(first.stdout()).toBe(second.stdout())
    expect(first.stdout()).toBe('Web lease: web present\n')
  })
})
