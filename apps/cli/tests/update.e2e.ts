/** Product-entry update behavior without a Runtime or Web attachment. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { RuntimeConnector } from '@harness-desktop/dsh-host-local-runtime'
import { runCli } from '../src/main.ts'
import type { TerminalIO } from '../src/terminal-client.ts'
import { runUpdateInvocation } from '../src/update.ts'

describe('CLI update entry', () => {
  it('does not construct Runtime, browser, or Desktop dependencies for an unsupported source layout', async () => {
    let stdout = ''
    let stderr = ''
    const io: TerminalIO = {
      stdin: new PassThrough(),
      stdout: new Writable({ write(chunk, _encoding, callback) { stdout += String(chunk); callback() } }),
      stderr: new Writable({ write(chunk, _encoding, callback) { stderr += String(chunk); callback() } }),
      workspace: process.cwd(), columns: 80, colorDepth: 1,
    }
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
