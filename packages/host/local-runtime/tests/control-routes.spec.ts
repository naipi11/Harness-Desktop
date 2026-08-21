/** Local native-control and browser-handoff authorization rules. */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBootstrapCleanup,
  createBootstrapDocument,
  LocalDashboardAuth,
  verifyBootstrapDocument,
} from '../src/auth.ts'

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage
}

describe('local Runtime authorization', () => {
  it('accepts the endpoint token only for native 127.0.0.1 control requests', () => {
    const auth = new LocalDashboardAuth({
      accessToken: 'private-endpoint-token',
      origin: 'http://127.0.0.1:39817',
    })

    expect(auth.authorizeNative(request({ host: '127.0.0.1:39817' }))).toBe(false)
    expect(auth.authorizeNative(request({
      host: '127.0.0.1:39817', authorization: 'Bearer wrong-token',
    }))).toBe(false)
    expect(auth.authorizeNative(request({
      host: 'localhost:39817', authorization: 'Bearer private-endpoint-token',
    }))).toBe(false)
    expect(auth.authorizeNative(request({
      host: '127.0.0.1:39817', authorization: 'Bearer private-endpoint-token',
    }))).toBe(true)
  })

  it('issues a one-time handoff and accepts its cookie only at the exact Runtime origin', () => {
    let now = 100
    const auth = new LocalDashboardAuth({
      accessToken: 'private-endpoint-token',
      origin: 'http://127.0.0.1:39817',
      now: () => now,
    })
    const handoff = auth.mintBrowserHandoff()

    expect(handoff.expiresAt).toBe(60_100)
    expect(auth.consumeBrowserHandoff(handoff.id)).toMatchObject({ kind: 'accepted' })
    expect(auth.consumeBrowserHandoff(handoff.id)).toEqual({ kind: 'rejected' })
    const session = auth.consumeBrowserHandoff(auth.mintBrowserHandoff().id)
    expect(session.kind).toBe('accepted')
    if (session.kind !== 'accepted') throw new Error('expected an authenticated session')

    expect(auth.authorizeDashboard(request({
      host: '127.0.0.1:39817', origin: 'http://127.0.0.1:39817', cookie: session.cookie,
    }))).toBe(true)
    const owner = auth.dashboardOwner(request({
      host: '127.0.0.1:39817', origin: 'http://127.0.0.1:39817', cookie: session.cookie,
    }))
    expect(owner).toMatch(/^dashboard-[A-Za-z0-9_-]{43}$/u)
    expect(auth.dashboardOwner(request({
      host: '127.0.0.1:39817', origin: 'http://127.0.0.1:39817', cookie: session.cookie,
    }))).toBe(owner)
    expect(auth.authorizeDashboard(request({
      host: '127.0.0.1:39817', origin: 'http://localhost:39817', cookie: session.cookie,
    }))).toBe(false)
    expect(auth.dashboardOwner(request({
      host: '127.0.0.1:39817', origin: 'http://localhost:39817', cookie: session.cookie,
    }))).toBeUndefined()
    expect(auth.authorizeDashboard(request({
      host: '127.0.0.1:39817', cookie: session.cookie,
    }))).toBe(false)

    const expired = auth.mintBrowserHandoff()
    now = expired.expiresAt
    expect(auth.consumeBrowserHandoff(expired.id)).toEqual({ kind: 'rejected' })
  })

  it('cleans an owned bootstrap path exactly once for dispatch, exchange, or expiry', async () => {
    let expiry!: () => void
    const paths: string[] = []
    const cleanup = createBootstrapCleanup('C:/private/bootstrap/index.html', 1_000, {
      now: () => 100,
      setTimer(callback) {
        expiry = callback
        return {} as ReturnType<typeof setTimeout>
      },
      clearTimer() {},
      async remove(path) { paths.push(path) },
    })

    await cleanup.dispatchFailed()
    await cleanup.exchangeSettled()
    expiry()
    await Promise.resolve()
    expect(paths).toEqual(['C:/private/bootstrap/index.html'])
  })

  it('creates a private bootstrap document whose handoff is only in its form body', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'harness-bootstrap-parent-'))
    try {
      const bootstrap = await createBootstrapDocument({
        parent,
        origin: 'http://127.0.0.1:39817',
        handoff: { id: 'handoff-value-that-is-not-a-navigation-secret', expiresAt: 1_000 },
      })
      const body = await readFile(bootstrap.path, 'utf8')

      expect(bootstrap.url).not.toContain('handoff-value-that-is-not-a-navigation-secret')
      expect(body).toContain('action="http://127.0.0.1:39817/_harness/handoff"')
      expect(body).toContain('name="handoff"')
      expect(body).toContain('value="handoff-value-that-is-not-a-navigation-secret"')
      if (process.platform !== 'win32') {
        expect((await stat(bootstrap.directory)).mode & 0o777).toBe(0o700)
        expect((await stat(bootstrap.path)).mode & 0o777).toBe(0o600)
        await chmod(bootstrap.path, 0o644)
        await expect(verifyBootstrapDocument(bootstrap)).rejects.toThrow(/mode 600/)
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
