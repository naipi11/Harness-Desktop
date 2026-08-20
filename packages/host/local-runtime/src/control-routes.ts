/** Runtime-private control and body-only browser-handoff HTTP routes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@harness-desktop/cordis'
import type { WebRoute } from '@harness-desktop/dsh-host-webserver'
import type { LocalDashboardAuth } from './auth.ts'

const CONTROL_HANDOFF_PATH = '/_harness/control/browser-handoff'
const HANDOFF_PATH = '/_harness/handoff'
const MAX_HANDOFF_BODY_BYTES = 4096

/** Route dependencies supplied by the Runtime composition owner. */
export interface LocalControlRouteOptions {
  /** Runtime-scoped native and Dashboard authenticator. */
  readonly auth: LocalDashboardAuth
  /** Mounts API and event transport after receiving the cookie validator. */
  readonly mountAuthenticatedDashboard?: (auth: LocalDashboardAuth) => void
}

/**
 * Register the token-only native handoff mint endpoint before the SPA fallback,
 * then the opaque-origin form exchange. Neither handler logs or reflects a
 * handoff, token, or session credential.
 */
export function mountLocalControlRoutes(ctx: Context, options: LocalControlRouteOptions): void {
  const control: WebRoute = {
    kind: 'exact',
    path: CONTROL_HANDOFF_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') return notFound(response)
      if (!options.auth.authorizeNative(request)) return unauthorized(response)
      const handoff = options.auth.mintBrowserHandoff()
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      })
      response.end(JSON.stringify(handoff))
    },
  }
  const handoff: WebRoute = {
    kind: 'exact',
    path: HANDOFF_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') return notFound(response)
      const id = await formBodyHandoff(request)
      if (id === undefined) return forbidden(response)
      const result = options.auth.consumeBrowserHandoff(id)
      if (result.kind === 'rejected') return forbidden(response)
      response.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': options.auth.sessionSetCookie(result.cookie),
      })
      response.end()
    },
  }
  ctx.effect(() => ctx.webServer.register(control), 'host-local-runtime: native handoff control')
  ctx.effect(() => ctx.webServer.register(handoff), 'host-local-runtime: browser handoff exchange')
  options.mountAuthenticatedDashboard?.(options.auth)
}

/** Extract exactly one opaque handoff from the only permitted request location. */
async function formBodyHandoff(request: IncomingMessage): Promise<string | undefined> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return undefined
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_HANDOFF_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  if ([...form.keys()].some(key => key !== 'handoff')) return undefined
  const values = form.getAll('handoff')
  return values.length === 1 && /^[A-Za-z0-9_-]{32,}$/.test(values[0] ?? '') ? values[0] : undefined
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, { 'www-authenticate': 'Bearer' })
  response.end('unauthorized')
}

function forbidden(response: ServerResponse): void {
  response.writeHead(403)
  response.end('forbidden')
}

function notFound(response: ServerResponse): void {
  response.writeHead(404)
  response.end('not found')
}
