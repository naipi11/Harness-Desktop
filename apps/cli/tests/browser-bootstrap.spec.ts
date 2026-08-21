/** Security and lifecycle coverage for the CLI-owned browser bootstrap file. */

import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardNavigation } from '@harness-desktop/dsh-host-local-runtime'
import {
  browserBootstrapAccess,
  createBrowserHandoffTransport,
  type BrowserBootstrapAccess,
} from '../src/browser.ts'

const HANDOFF = 'browser_bootstrap_handoff_value_1234567890'
const harnessBuilt = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const roots: string[] = []
const permissiveAccess: BrowserBootstrapAccess = {
  async protectDirectory() {},
  async protectFile() {},
  async verifyDirectory() {},
  async verifyFile() {},
}

function navigation(expiresAt: number): DashboardNavigation {
  return {
    origin: 'http://127.0.0.1:43123' as DashboardNavigation['origin'],
    handoff: { id: HANDOFF as DashboardNavigation['handoff']['id'], expiresAt },
  }
}

type BuiltRunCli = (
  commandName: 'harness',
  argv: readonly string[],
  dependencies: unknown,
) => Promise<number>

async function loadBuiltRunCli(): Promise<BuiltRunCli> {
  const bin = await readFile(harnessBuilt, 'utf8')
  const binding = /import \{ ([A-Za-z_$][\w$]*) as runCli \} from "([^"]+)";/u.exec(bin)
  if (binding === null) throw new Error('built harness bin does not reference its CLI bundle')
  const module = await import(new URL(binding[2]!, pathToFileURL(harnessBuilt)).href) as Record<string, unknown>
  const runCli = module[binding[1]!]
  if (typeof runCli !== 'function') throw new Error('built harness CLI bundle does not export its runner binding')
  return runCli as BuiltRunCli
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('browser bootstrap document', () => {
  it('keeps the raw handoff only in one hidden form value under verified private paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-browser-bootstrap-test-'))
    roots.push(parent)
    let documentPath = ''
    const transport = createBrowserHandoffTransport({
      parent,
      now: () => 1_000,
      dispatch: async (url) => {
        expect(url).toMatch(/^file:/u)
        expect(url).not.toContain(HANDOFF)
        documentPath = fileURLToPath(url)
        const html = await readFile(documentPath, 'utf8')
        expect(html).toContain('<meta name="referrer" content="no-referrer">')
        expect(html).toContain('method="post"')
        expect(html).toContain('autocomplete="off"')
        expect(html).toContain('action="http://127.0.0.1:43123/_harness/handoff"')
        expect(html).toContain(`type="hidden" name="handoff" value="${HANDOFF}"`)
        expect(html.match(new RegExp(HANDOFF, 'gu'))).toHaveLength(1)
        await browserBootstrapAccess.verifyDirectory(dirname(documentPath))
        await browserBootstrapAccess.verifyFile(documentPath)
      },
    })

    await transport.open(navigation(61_000))
    expect(documentPath).not.toBe('')
  })

  it('rejects a broader-access bootstrap before dispatch', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-browser-bootstrap-test-'))
    roots.push(parent)
    const dispatch = vi.fn()
    const rejectingAccess: BrowserBootstrapAccess = {
      async protectDirectory() {},
      async protectFile(path) {
        if (process.platform !== 'win32') await chmod(path, 0o644)
      },
      async verifyDirectory() {},
      async verifyFile() { throw new Error('browser bootstrap path is broader than the current user') },
    }

    await expect(createBrowserHandoffTransport({
      parent,
      access: rejectingAccess,
      now: () => 1_000,
      dispatch,
    }).open(navigation(61_000))).rejects.toThrow('broader than the current user')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('uses one cleanup operation for dispatch failure and undispatched expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const parent = await mkdtemp(join(tmpdir(), 'harness-browser-bootstrap-test-'))
    roots.push(parent)
    const removed: string[] = []
    const remove = async (path: string): Promise<void> => { removed.push(path) }
    const dispatchFailure = createBrowserHandoffTransport({
      parent,
      access: permissiveAccess,
      now: Date.now,
      remove,
      dispatch: async () => { throw new Error('browser dispatch failed') },
    })
    await expect(dispatchFailure.open(navigation(2_000))).rejects.toThrow('browser dispatch failed')
    expect(removed).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(1)

    let releaseDispatch!: () => void
    let markDispatched!: () => void
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve })
    const undispatched = createBrowserHandoffTransport({
      parent,
      access: permissiveAccess,
      now: Date.now,
      remove,
      dispatch: () => {
        markDispatched()
        return new Promise<void>((resolve) => { releaseDispatch = resolve })
      },
    })
    const opening = undispatched.open(navigation(3_000))
    await dispatched
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(2)
    releaseDispatch()
    await opening
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removed).toHaveLength(2)
  })

  it('removes the document and its directory once at expiry after a successful dispatch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const parent = await mkdtemp(join(tmpdir(), 'harness-browser-bootstrap-test-'))
    roots.push(parent)
    let documentPath = ''
    let removalSettled!: () => void
    const removal = new Promise<void>((resolve) => { removalSettled = resolve })
    let removals = 0
    const transport = createBrowserHandoffTransport({
      parent,
      access: permissiveAccess,
      now: Date.now,
      dispatch: async (url) => { documentPath = fileURLToPath(url) },
      async remove(path) {
        removals += 1
        await rm(dirname(path), { recursive: true, force: true })
        removalSettled()
      },
    })

    await transport.open(navigation(2_000))
    await expect(access(documentPath)).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    await removal
    await expect(access(documentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(dirname(documentPath))).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(removals).toBe(1)
    await expect(access(dirname(documentPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.env.DSH_EXAMPLE_MODE === 'lib')('ships the private body-only bootstrap in the built CLI', async () => {
    let dispatchedUrl = ''
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return {
        ...actual,
        execFile: (...args: unknown[]) => {
          const commandArgs = args[1] as string[]
          const options = args[2] as { readonly env?: NodeJS.ProcessEnv }
          dispatchedUrl = process.platform === 'win32'
            ? options.env?.HARNESS_BROWSER_BOOTSTRAP_URL ?? ''
            : commandArgs[0] ?? ''
          const callback = args.at(-1)
          if (typeof callback !== 'function') throw new Error('built browser dispatch did not supply an execFile callback')
          ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(null, '', '')
        },
      }
    })
    let documentPath = ''
    try {
      const runCli = await loadBuiltRunCli()
      const dashboardNavigation = navigation(Date.now() + 60_000)
      const connector = {
        async connect() {
          return {
            async attachDashboard() {
              return {
                async createBrowserHandoff() { return dashboardNavigation },
                async close() {},
              }
            },
            async close() {},
          }
        },
      }
      const output = new PassThrough()
      const code = await runCli('harness', ['web'], {
        connector,
        io: {
          stdin: new PassThrough(),
          stdout: output,
          stderr: output,
          workspace: process.cwd(),
          columns: 80,
          colorDepth: 1,
        },
      })
      expect(code).toBe(0)
      expect(dispatchedUrl).toMatch(/^file:/u)
      expect(dispatchedUrl).not.toContain(dashboardNavigation.handoff.id)
      documentPath = fileURLToPath(dispatchedUrl)
      const html = await readFile(documentPath, 'utf8')
      expect(html).toContain('<meta name="referrer" content="no-referrer">')
      expect(html).toContain('autocomplete="off"')
      expect(html.match(new RegExp(dashboardNavigation.handoff.id, 'gu'))).toHaveLength(1)
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
      if (documentPath !== '') await rm(dirname(documentPath), { recursive: true, force: true })
    }
  })
})
