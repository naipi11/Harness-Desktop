/** Workbench operations require the exact Dashboard origin and issued cookie. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import WebServer from '@harness-desktop/dsh-host-webserver'
import { LocalDashboardAuth } from '../src/auth.ts'
import { createWorkbenchService } from '../src/workbench.ts'
import { mountWorkbenchRoutes } from '../src/workbench-routes.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose() })

it('rejects missing authentication and malformed operations before workspace access', async () => {
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const auth = new LocalDashboardAuth({ accessToken: 'test-only', origin })
  const service = createWorkbenchService({ workspacePath: () => undefined })
  mountWorkbenchRoutes(ctx, auth, service)
  const post = (body: unknown, cookie?: string) => fetch(`${origin}/_harness/workbench`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  })
  expect((await post({ operation: 'files', workspaceId: 'w', directory: '' })).status).toBe(403)
  const session = auth.consumeBrowserHandoff(auth.mintBrowserHandoff('test-owner').id)
  if (session.kind !== 'accepted') throw new Error('fixture did not issue a cookie')
  expect((await post({ operation: 'arbitrary-exec', command: 'bad' }, session.cookie)).status).toBe(400)
  const missing = await post({ operation: 'files', workspaceId: 'w', directory: '' }, session.cookie)
  expect(missing.status).toBe(409)
  expect(await missing.json()).toEqual({ ok: false, error: 'Workbench operation failed' })
})
