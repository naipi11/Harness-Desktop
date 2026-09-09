/** Cookie-authenticated workspace inspection and user-operated local shell routes. */
import type { Context } from '@harness-desktop/cordis'
import type { IncomingMessage } from 'node:http'
import type { LocalDashboardAuth } from './auth.ts'
import type { createWorkbenchService, WorkbenchTerminalId } from './workbench.ts'

/** Runtime-owned workbench implementation; never crosses into the browser. */
export type WorkbenchService = ReturnType<typeof createWorkbenchService>

type Request =
  | { operation: 'files'; workspaceId: string; directory: string }
  | { operation: 'terminal-open'; workspaceId: string }
  | { operation: 'terminal-read' | 'terminal-close'; id: WorkbenchTerminalId }
  | { operation: 'terminal-write'; id: WorkbenchTerminalId; data: string }

function parse(value: unknown): Request | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort().join(',')
  const text = (key: string, limit: number): boolean => typeof row[key] === 'string' && row[key].length <= limit
  if (row.operation === 'files' && keys === 'directory,operation,workspaceId' && text('workspaceId', 128) && text('directory', 4096)) return row as Request
  if (row.operation === 'terminal-open' && keys === 'operation,workspaceId' && text('workspaceId', 128)) return row as Request
  if ((row.operation === 'terminal-read' || row.operation === 'terminal-close') && keys === 'id,operation' && text('id', 128)) return row as Request
  if (row.operation === 'terminal-write' && keys === 'data,id,operation' && text('id', 128) && text('data', 16_384)) return row as Request
  return undefined
}

async function body(request: IncomingMessage): Promise<Request | undefined> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const data of request as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(data)
    size += chunk.length
    if (size > 65_536) return undefined
    chunks.push(chunk)
  }
  try { return parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  catch { return undefined /* Only malformed JSON reaches this one-statement parser. */ }
}

/**
 * Mount the workbench only behind existing exact-origin Dashboard authentication.
 * @param ctx - Runtime scope with WebServer.
 * @param auth - existing private cookie authority.
 * @param service - workspace and shell owner.
 */
export function mountWorkbenchRoutes(ctx: Context, auth: LocalDashboardAuth, service: WorkbenchService): void {
  const web = ctx.get('webServer')
  if (web === undefined) throw new Error('Workbench requires WebServer')
  ctx.effect(() => web.register({
    kind: 'exact', path: '/_harness/workbench',
    async handler(request, response) {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      const reply = (status: number, value: unknown): void => {
        response.writeHead(status)
        response.end(JSON.stringify(value))
      }
      if (request.method !== 'POST') { reply(405, { ok: false }); return }
      const owner = auth.dashboardOwner(request)
      if (owner === undefined) { reply(403, { ok: false }); return }
      const input = await body(request)
      if (input === undefined) { reply(400, { ok: false }); return }
      try {
        let value: unknown
        switch (input.operation) {
          case 'files': value = await service.listFiles(input.workspaceId, input.directory); break
          case 'terminal-open': value = await service.openTerminal(owner, input.workspaceId); break
          case 'terminal-read': value = service.readTerminal(owner, input.id); break
          case 'terminal-write': await service.writeTerminal(owner, input.id, input.data); value = null; break
          case 'terminal-close': await service.closeTerminal(owner, input.id); value = null; break
        }
        reply(200, { ok: true, value })
      } catch {
        reply(409, { ok: false, error: 'Workbench operation failed' })
      }
    },
  }), 'host-local-runtime: authenticated workbench')
}
