import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { RuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import { runCli } from '../src/main.ts'
import type { TerminalIO } from '../src/terminal-client.ts'

function captureIO(): { io: TerminalIO; stderr: () => string } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let errorText = ''
  stderr.setEncoding('utf8').on('data', (chunk: string) => { errorText += chunk })
  return {
    io: {
      stdin: new PassThrough(), stdout, stderr,
      workspace: 'C:\\workspace', columns: 80, colorDepth: 1,
    },
    stderr: () => errorText,
  }
}

describe('runCli', () => {
  it('reports product argument errors as exit code 2 without connecting to a Runtime', async () => {
    const streams = captureIO()
    const connector: RuntimeConnector = {
      connect: () => { throw new Error('argument errors must not connect') },
    }

    const code = await runCli('harness', ['run', '--json'], { io: streams.io, connector })

    expect(code).toBe(2)
    expect(streams.stderr()).toContain('run needs exactly one task')
    expect(streams.stderr()).toContain('harness run <task>')
  })
})
