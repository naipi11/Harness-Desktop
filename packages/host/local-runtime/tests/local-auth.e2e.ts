/** Real loopback WebServer coverage for the private control and handoff routes. */

import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { connect } from 'node:net'
import { Context } from '@harness-desktop/cordis'
import { mountAuthenticatedConnection } from '@harness-desktop/dsh-client-connection'
import type { ApiProxy } from '@harness-desktop/dsh-host-apiproxy/api'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { LocalDashboardAuth } from '../src/auth.ts'
import { mountLocalControlRoutes } from '../src/control-routes.ts'
import type { RuntimeControlService } from '../src/control-service.ts'
import type { DashboardControlRequest, RuntimeClientId } from '../src/runtime-client.ts'

const HANDOFF_RECOVERY = 'Dashboard connection expired. Run harness web to reconnect.'
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function start(
  now?: () => number,
  controlService?: RuntimeControlService,
): Promise<{ port: number; auth: LocalDashboardAuth }> {
  context = new Context()
  const fiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await fiber.await()
  const port = context.webServer.port
  context.provide('apiProxy', {} as ApiProxy)
  const auth = new LocalDashboardAuth({
    accessToken: 'private-endpoint-token',
    origin: `http://127.0.0.1:${String(port)}`,
    ...(now === undefined ? {} : { now }),
  })
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext) {
      mountLocalControlRoutes(routeContext, {
        auth,
        ...controlService === undefined ? {} : { controlService },
        mountAuthenticatedDashboard: (dashboardAuth) => {
          mountAuthenticatedConnection(routeContext, { authorize: request => dashboardAuth.authorizeDashboard(request) })
        },
      })
    },
  }).await()
  return { port, auth }
}

describe('local Runtime auth routes', () => {
  it('routes Foundation active-work controls through the authenticated Dashboard owner', async () => {
    const handled: { owner: RuntimeClientId; request: DashboardControlRequest }[] = []
    const controlService = {
      sessions: undefined,
      async handleDashboard(owner: RuntimeClientId, request: DashboardControlRequest) {
        handled.push({ owner, request })
        return request.operation === 'observe-active-work'
          ? { ownUiWork: ['dashboard-work'] }
          : { kind: 'stopped', work: ['dashboard-work'] }
      },
    } as unknown as RuntimeControlService
    const { port, auth } = await start(undefined, controlService)
    const origin = `http://127.0.0.1:${String(port)}`
    const exchange = auth.consumeBrowserHandoff(auth.mintBrowserHandoff().id)
    if (exchange.kind !== 'accepted') throw new Error('expected an authenticated session')
    const post = async (operation: string): Promise<Response> => await fetch(`${origin}/_harness/dashboard-control`, {
      method: 'POST',
      headers: { cookie: exchange.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ operation }),
    })

    expect(await (await post('observe-active-work')).json()).toEqual({
      ok: true, value: { ownUiWork: ['dashboard-work'] },
    })
    expect(await (await post('stop-own-ui-work')).json()).toEqual({
      ok: true, value: { kind: 'stopped', work: ['dashboard-work'] },
    })
    expect(new Set(handled.map(call => call.owner))).toEqual(new Set([handled[0]?.owner]))
    expect(handled.map(call => call.request.operation)).toEqual(['observe-active-work', 'stop-own-ui-work'])
    expect((await fetch(`${origin}/_harness/dashboard-control`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: '{"operation":"observe-active-work"}',
    })).status).toBe(403)
    expect((await post('status')).status).toBe(400)
  })

  it('requires bearer authorization to mint a body-only handoff and exchanges it once without CORS', async () => {
    const { port } = await start()
    const control = `http://127.0.0.1:${String(port)}/_harness/control/browser-handoff`
    expect((await fetch(control, { method: 'POST' })).status).toBe(401)

    const minted = await fetch(control, {
      method: 'POST', headers: { authorization: 'Bearer private-endpoint-token' },
    })
    expect(minted.status).toBe(200)
    const handoff = await minted.json() as { id: string; expiresAt: number }
    expect(JSON.stringify(handoff)).not.toContain('private-endpoint-token')

    const response = await fetch(`http://127.0.0.1:${String(port)}/_harness/handoff`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({ handoff: handoff.id }),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toMatch(/Expires=|Max-Age=/i)
    expect(cookie).not.toContain(handoff.id)

    const replay = await fetch(`http://127.0.0.1:${String(port)}/_harness/handoff`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: handoff.id }),
    })
    expect(replay.status).toBe(403)
    expect(await replay.text()).toBe(HANDOFF_RECOVERY)
    expect(replay.headers.get('cache-control')).toBe('no-store')
    expect(replay.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(replay.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('uses the stable recovery document only for malformed, wrong, expired, or replayed handoffs', async () => {
    let now = 100
    const { port, auth } = await start(() => now)
    const origin = `http://127.0.0.1:${String(port)}`
    const request = async (handoff: string): Promise<Response> => await fetch(`${origin}/_harness/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams({ handoff }),
    })

    const malformed = await request('short')
    const wrong = await request('wrong_browser_handoff_value_12345678901234567890')
    const expiredHandoff = auth.mintBrowserHandoff()
    now = expiredHandoff.expiresAt
    const expired = await request(expiredHandoff.id)
    now += 1
    const replayedHandoff = auth.mintBrowserHandoff()
    expect((await request(replayedHandoff.id)).status).toBe(303)
    const replayed = await request(replayedHandoff.id)

    for (const response of [malformed, wrong, expired, replayed]) {
      expect(response.status).toBe(403)
      expect(await response.text()).toBe(HANDOFF_RECOVERY)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
    const dashboardForbidden = await fetch(`${origin}/api/session.list`, { method: 'POST' })
    expect(dashboardForbidden.status).toBe(403)
    expect(await dashboardForbidden.text()).toBe('forbidden')
  })

  it('refuses Dashboard API requests without the issued cookie and exact Runtime origin', async () => {
    const { port, auth } = await start()
    const origin = `http://127.0.0.1:${String(port)}`
    const exchange = auth.consumeBrowserHandoff(auth.mintBrowserHandoff().id)
    if (exchange.kind !== 'accepted') throw new Error('expected an authenticated session')

    expect((await fetch(`${origin}/api/session.list`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${origin}/api/session.list`, {
      method: 'POST', headers: { cookie: exchange.cookie, origin: 'http://localhost:1' },
    })).status).toBe(403)
    expect((await fetch(`${origin}/api/session.list`, {
      method: 'POST', headers: { cookie: exchange.cookie, origin },
    })).status).not.toBe(403)
  })

  it('rejects an unauthenticated Dashboard WebSocket before protocol negotiation', async () => {
    const { port } = await start()
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const response = once(socket, 'data')
    socket.write([
      'GET /api/events.mux HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Origin: http://127.0.0.1:' + String(port),
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      '',
    ].join('\r\n'))
    const [data] = await response as [Buffer]
    expect(String(data)).toContain('HTTP/1.1 403 Forbidden')
    socket.destroy()
  })
})
