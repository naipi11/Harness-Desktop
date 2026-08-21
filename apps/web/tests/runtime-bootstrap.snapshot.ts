// @vitest-environment jsdom
/** Stable clean-location and cookie-authentication Dashboard startup output. */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const run = vi.fn(async (root: HTMLElement) => {
  root.replaceChildren(document.createTextNode('Protected Dashboard'))
})

vi.mock('@harness-desktop/dsh-client-web', () => ({
  AppWebEntry: class {
    constructor(private readonly root: HTMLElement) {}
    run(): Promise<void> { return run(this.root) }
  },
}))

async function importEntry(): Promise<HTMLElement> {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  await import('../src/main.ts')
  await vi.waitFor(() => {
    const root = document.getElementById('root')
    expect(root?.textContent).not.toBe('')
  })
  return document.getElementById('root')!
}

beforeEach(() => {
  run.mockClear()
  localStorage.clear()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('starts the protected Dashboard only after a clean cookie-authenticated request', async () => {
  const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  vi.stubGlobal('fetch', fetch)

  const root = await importEntry()

  expect(run).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith('/_harness/dashboard-control', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{"operation":"get-legacy-migration"}',
  })
  expect(root.textContent).toMatchInlineSnapshot('"Protected Dashboard"')
})

it('renders one reconnect instruction for a non-clean initial URL', async () => {
  history.replaceState(null, '', '/unexpected')
  vi.stubGlobal('fetch', vi.fn())

  const root = await importEntry()

  expect(run).not.toHaveBeenCalled()
  expect(root.textContent).toMatchInlineSnapshot('"Dashboard connection expired. Run harness web to reconnect."')
})

it('redacts a rejected cookie request from DOM, storage, console, and snapshot text', async () => {
  const raw = 'raw_handoff_and_session_value_that_must_not_escape'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 403 })))
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

  const root = await importEntry()
  const evidence = JSON.stringify({
    dom: document.body.textContent,
    localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    console: [...consoleError.mock.calls, ...consoleLog.mock.calls],
  })

  expect(run).not.toHaveBeenCalled()
  expect(root.textContent).toMatchInlineSnapshot('"Dashboard connection expired. Run harness web to reconnect."')
  expect(evidence).not.toContain(raw)
  expect(evidence).not.toMatch(/handoff|session_value/u)
  consoleError.mockRestore()
  consoleLog.mockRestore()
})

it.runIf(process.env.DSH_EXAMPLE_MODE === 'lib')('ships the reconnect-only failure surface in the built Web entry', async () => {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
  history.replaceState(null, '', '/')
  const raw = 'built_raw_handoff_and_session_value_that_must_not_escape'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 403 })))
  const distIndex = join(process.cwd(), 'apps/web/dist/index.html')
  const index = await readFile(distIndex, 'utf8')
  const entry = /<script type="module" crossorigin src="([^"]+)"><\/script>/u.exec(index)?.[1]
  if (entry === undefined) throw new Error('built Web index has no module entry')
  const entryPath = join(dirname(distIndex), entry.slice(1))

  await import(pathToFileURL(entryPath).href)
  await vi.waitFor(() => {
    expect(document.getElementById('root')?.textContent).toBe('Dashboard connection expired. Run harness web to reconnect.')
  })
  const evidence = JSON.stringify({
    dom: document.body.textContent,
    localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
  })
  expect(evidence).not.toContain(raw)
  expect(evidence).not.toMatch(/handoff|session_value/u)
})
