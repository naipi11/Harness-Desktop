/** Body-only handoff, private cookie, and exact-origin Dashboard carrier security. */

import { describe, expect, it } from 'vitest'
import type { DashboardNavigation } from '@harness-desktop/dsh-host-local-runtime'
import type { CrossClientRuntimeClient } from '../src/index.ts'
import {
  CrossClientDashboardCarrierError,
  DashboardCookieApiClient,
  createCrossClientDashboardApiAdapter,
} from '../src/cross-client-dashboard.ts'

const origin = 'http://127.0.0.1:43123'
const handoff = 'handoff-private-sentinel'
const cookie = 'harness_session=cookie-private-sentinel'

function navigation(value = origin): DashboardNavigation {
  return {
    origin: value as DashboardNavigation['origin'],
    handoff: { id: handoff as DashboardNavigation['handoff']['id'], expiresAt: Date.now() + 60_000 },
  }
}

function runtime(value = navigation(), onClose: () => void = () => {}): CrossClientRuntimeClient {
  return {
    status: async () => { throw new Error('not used') },
    openTerminal: async () => { throw new Error('not used') },
    attachDashboard: async () => ({
      createBrowserHandoff: async () => value,
      close: async () => { onClose() },
    }),
    close: async () => {},
  }
}

function apiResponse(init: RequestInit | undefined): Response {
  const request = JSON.parse(bodyText(init?.body)) as { readonly rpcId: string; readonly method: string }
  const workspace = {
    workspaceId: 'workspace-1',
    path: 'C:\\fixture',
    title: 'fixture',
    sessionIds: ['session-1'],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }
  const values: Record<string, unknown> = {
    'workspace.list': { items: [workspace], archivedSessionIds: [] },
    'workspace.create': { workspace, created: true },
    'session.create': { sessionId: 'session-1', agentPreset: 'standard' },
    'session.list': { items: [{ sessionId: 'session-1', updatedAt: 0, running: false, blank: false }] },
    'session.history': { events: [], hasMore: false },
    'session.prompt': { accepted: true },
  }
  const value = values[request.method]
  return Response.json({
    type: 'server-response',
    rpcId: request.rpcId,
    result: { ok: true, value },
  })
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  throw new Error('expected a string or URLSearchParams request body')
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('cross-client Dashboard carrier', () => {
  it('exchanges the handoff only in the form body and pins cookie requests to the exact origin', async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = inputUrl(input)
      requests.push({ url, ...init === undefined ? {} : { init } })
      if (url.endsWith('/_harness/handoff')) {
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': `${cookie}; HttpOnly; SameSite=Strict` },
        })
      }
      return apiResponse(init)
    }
    const handle = await createCrossClientDashboardApiAdapter(fetcher).connect(runtime())

    expect(handle.containsPrivateValue(handoff)).toBe(true)
    expect(handle.containsPrivateValue(cookie)).toBe(true)
    expect(handle.containsPrivateValue('cookie-private-sentinel')).toBe(true)
    expect(handle.containsPrivateValue('public')).toBe(false)
    const workspaces = await handle.api.readWorkspaces()
    const workspace = await handle.api.createWorkspace('C:\\fixture')
    const sessionId = await handle.api.createSession(workspace.workspaceId)
    expect(await handle.api.readSessions()).toHaveLength(1)
    expect(await handle.api.readHistory(sessionId)).toEqual([])
    await handle.api.prompt(sessionId, 'public prompt')
    expect(workspaces).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${origin}/_harness/handoff`)
    expect(requests[0]?.url).not.toContain(handoff)
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBeNull()
    expect(new Headers(requests[0]?.init?.headers).get('origin')).toBe('null')
    expect(new Headers(requests[0]?.init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(bodyText(requests[0]?.init?.body)).toBe(`handoff=${handoff}`)
    expect(new Headers(requests[1]?.init?.headers).get('cookie')).toBe(cookie)
    expect(new Headers(requests[1]?.init?.headers).get('origin')).toBe(origin)
    await handle.api.close()
    expect(handle.containsPrivateValue(handoff)).toBe(false)
    expect(handle.containsPrivateValue(cookie)).toBe(false)
    await handle.dashboard.close()
  })

  it.each([
    'https://127.0.0.1:43123',
    'not a URL',
    'http://localhost:43123',
    'http://127.0.0.1',
    'http://127.0.0.1:43123/path',
    'http://127.0.0.1:43123/?x=1',
    'http://127.0.0.1:43123/#x',
    'http://user:pass@127.0.0.1:43123',
  ])('rejects unsafe Dashboard origin %s without reflecting it', async (unsafeOrigin) => {
    let dashboardClosed = 0
    const error = await createCrossClientDashboardApiAdapter(async () => {
      throw new Error('fetch must not run')
    }).connect(runtime(navigation(unsafeOrigin), () => { dashboardClosed += 1 })).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(CrossClientDashboardCarrierError)
    expect(String(error)).not.toContain(unsafeOrigin)
    expect(String(error)).not.toContain(handoff)
    expect(dashboardClosed).toBe(1)
  })

  it.each([
    { status: 302, location: '/', setCookie: cookie },
    { status: 303, location: '/leaked', setCookie: cookie },
    { status: 303, location: '/', setCookie: undefined },
    { status: 303, location: '/', setCookie: 'invalid-cookie' },
    { status: 303, location: '/', setCookie: '=value' },
    { status: 303, location: '/', setCookie: 'name=' },
  ])('rejects an invalid handoff response %# without exposing secrets', async ({ status, location, setCookie }) => {
    let dashboardClosed = 0
    const fetcher: typeof fetch = async () => new Response(null, {
      status,
      headers: {
        location,
        ...(setCookie === undefined ? {} : { 'set-cookie': setCookie }),
      },
    })
    const error = await createCrossClientDashboardApiAdapter(fetcher)
      .connect(runtime(navigation(), () => { dashboardClosed += 1 }))
      .catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(CrossClientDashboardCarrierError)
    expect(String(error)).not.toContain(handoff)
    expect(String(error)).not.toContain(cookie)
    expect(dashboardClosed).toBe(1)
  })

  it('rejects a cookie-bearing request that crosses the exact Dashboard origin', async () => {
    class Probe extends DashboardCookieApiClient {
      request(url: string): Promise<Response> {
        return this.doFetch(new URL(url))
      }
    }
    const client = new Probe(origin, cookie, async () => { throw new Error('fetch must not run') })

    let error: unknown
    try {
      await client.request('http://127.0.0.1:43124/api/workspace.list')
    } catch (failure) {
      error = failure
    }
    expect(error).toBeInstanceOf(CrossClientDashboardCarrierError)
    expect(String(error)).not.toContain(cookie)
    client.close()
    expect(() => client.request(`${origin}/api/workspace.list`)).toThrow(CrossClientDashboardCarrierError)
  })

  it('redacts API failures and contains Dashboard close failures during rejected handoff', async () => {
    let calls = 0
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1
      if (calls === 1) {
        return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } })
      }
      const request = JSON.parse(bodyText(init?.body)) as { readonly rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'cookie-private-sentinel', details: {} } },
      })
    }
    const handle = await createCrossClientDashboardApiAdapter(fetcher).connect(runtime())
    const error = await handle.api.readWorkspaces().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CrossClientDashboardCarrierError)
    expect(String(error)).not.toContain(cookie)

    const rejected = await createCrossClientDashboardApiAdapter(async () => { throw new Error('private fetch') })
      .connect({
        ...runtime(navigation('https://127.0.0.1:43123')),
        attachDashboard: async () => ({
          createBrowserHandoff: async () => navigation('https://127.0.0.1:43123'),
          close: async () => { throw new Error('private close') },
        }),
      })
      .catch((failure: unknown) => failure)
    expect(rejected).toBeInstanceOf(CrossClientDashboardCarrierError)
    expect(String(rejected)).not.toContain('private')
  })
})
