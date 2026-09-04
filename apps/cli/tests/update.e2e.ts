/** Product-entry update behavior without a Runtime or Web attachment. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import type { TerminalIO } from '../src/terminal-client.ts'
import { runUpdateInvocation } from '../src/update.ts'

afterEach(() => { vi.doUnmock('../src/update.ts'); vi.resetModules() })

describe('CLI update entry', () => {
  it('renders an unconfigured standalone update source as a redacted actionable failure', async () => {
    vi.doMock('../src/update.ts', () => ({
      runUpdateInvocation: async () => ({ kind: 'failed', code: 'unconfigured-update-source' }),
    }))
    const { runCli } = await import('../src/main.ts')
    let stdout = ''
    let stderr = ''
    const io = terminalIo(
      (chunk) => { stdout += chunk },
      (chunk) => { stderr += chunk },
    )

    await expect(runCli('harness', ['update'], { io })).resolves.toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('CLI update unavailable [unconfigured-update-source]. Install a current standalone release.\n')
  })

  it('does not report a cleanup-failed update as fully applied', async () => {
    vi.doMock('../src/update.ts', () => ({
      runUpdateInvocation: async () => ({
        kind: 'applied-with-cleanup-failure', code: 'retained-cleanup-failed', version: '1.1.0',
      }),
    }))
    const { runCli } = await import('../src/main.ts')
    let stdout = ''
    let stderr = ''
    const io = terminalIo(
      (chunk) => { stdout += chunk },
      (chunk) => { stderr += chunk },
    )

    await expect(runCli('harness', ['update'], { io })).resolves.toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('CLI update applied, but cleanup failed.\n')
  })

  it('reports a detached Windows transaction as scheduled rather than promising an application restart', async () => {
    vi.doMock('../src/update.ts', () => ({
      runUpdateInvocation: async () => ({ kind: 'restart-scheduled', version: '1.1.0' }),
    }))
    const { runCli } = await import('../src/main.ts')
    let stdout = ''
    let stderr = ''
    const io = terminalIo(
      (chunk) => { stdout += chunk },
      (chunk) => { stderr += chunk },
    )

    await expect(runCli('harness', ['update'], { io })).resolves.toBe(0)
    expect(stdout).toBe('CLI update scheduled; it completes after this command exits.\n')
    expect(stderr).toBe('')
  })

  it('does not construct Runtime, browser, or Desktop dependencies for an unsupported source layout', async () => {
    let stdout = ''
    let stderr = ''
    const { runCli } = await import('../src/main.ts')
    const io = terminalIo(
      (chunk) => { stdout += chunk },
      (chunk) => { stderr += chunk },
    )
    const connector: RuntimeConnector = { connect: () => { throw new Error('update must not construct a Runtime connector') } }
    const opener = { open: () => { throw new Error('update must not create a browser handoff') } }
    const activator = { activate: () => { throw new Error('update must not activate Desktop') } }

    await expect(runCli('harness', ['update'], { io, connector, opener, activator })).resolves.toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('CLI update failed.\n')
  })

  it('recognizes a resolved npm layout and emits the exact package-manager command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-cli-update-e2e-'))
    let stdout = ''
    const entryPath = join(root, 'node_modules', '@harness-desktop', 'cli', 'lib', 'update.js')
    try {
      await mkdir(dirname(entryPath), { recursive: true })
      await writeFile(entryPath, '')
      await expect(runUpdateInvocation({
        entryPath,
        version: '1.0.0',
        stdout: { write(chunk: string): boolean { stdout += chunk; return true } },
        loadCandidate: async () => { throw new Error('npm update must not load a candidate') },
      })).resolves.toEqual({ kind: 'managed-by-npm' })
      expect(stdout).toBe('npm update -g @harness-desktop/cli\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function terminalIo(onStdout: (chunk: string) => void, onStderr: (chunk: string) => void): TerminalIO {
  return {
    stdin: new PassThrough(),
    stdout: new Writable({ write(chunk, _encoding, callback) { onStdout(String(chunk)); callback() } }),
    stderr: new Writable({ write(chunk, _encoding, callback) { onStderr(String(chunk)); callback() } }),
    workspace: process.cwd(), columns: 80, colorDepth: 1,
  }
}
