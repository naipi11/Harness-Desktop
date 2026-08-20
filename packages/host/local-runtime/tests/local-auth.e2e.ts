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

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function start(): Promise<{ port: number; auth: LocalDashboardAuth }> {
  context = new Context()
  const fiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await fiber.await()
  const port = context.webServer.port
  context.provide('apiProxy', {} as ApiProxy)
  const auth = new LocalDashboardAuth({
    accessToken: 'private-endpoint-token',
    origin: `http://127.0.0.1:${String(port)}`,
  })
  await context.plugin({
    inject: ['webServer'],
    apply(routeContext) {
      mountLocalControlRoutes(routeContext, {
        auth,
        mountAuthenticatedDashboard: (dashboardAuth) => {
          mountAuthenticatedConnection(routeContext, { authorize: request => dashboardAuth.authorizeDashboard(request) })
        },
      })
    },
  }).await()
  return { port, auth }
}

describe('local Runtime auth routes', () => {
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

    expect((await fetch(`http://127.0.0.1:${String(port)}/_harness/handoff`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handoff: handoff.id }),
    })).status).toBe(403)
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
