/** Runtime-private control and body-only browser-handoff HTTP routes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Context } from '@harness-desktop/cordis'
import type { WebRoute } from '@harness-desktop/dsh-host-webserver'
import type { LocalDashboardAuth } from './auth.ts'
import type { RuntimeControlService } from './control-service.ts'
import type {
  DashboardControlRequest,
  RuntimeClientId,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeDiagnosticId,
  TerminalControlCommand,
  TerminalInput,
  TerminalOpenRequest,
} from './runtime-client.ts'

const CONTROL_HANDOFF_PATH = '/_harness/control/browser-handoff'
const CONTROL_PATH = '/_harness/control'
const INTERNAL_CONTROL_PATH = '/_harness/control/internal'
const DASHBOARD_CONTROL_PATH = '/_harness/dashboard-control'
const HANDOFF_PATH = '/_harness/handoff'
const MAX_HANDOFF_BODY_BYTES = 4096
const MAX_CONTROL_BODY_BYTES = 65_536

/** Route dependencies supplied by the Runtime composition owner. */
export interface LocalControlRouteOptions {
  /** Runtime-scoped native and Dashboard authenticator. */
  readonly auth: LocalDashboardAuth
  /** Mounts API and event transport after receiving the cookie validator. */
  readonly mountAuthenticatedDashboard?: (auth: LocalDashboardAuth) => void
  /** Settles the native launcher's owned bootstrap after this handoff exchanges or rejects. */
  readonly onHandoffSettled?: (id: string) => Promise<void>
  /** Runtime-owned redacted control operations. */
  readonly controlService?: RuntimeControlService
}

/**
 * Register the token-only native handoff mint endpoint before the SPA fallback,
 * then the opaque-origin form exchange. Neither handler logs or reflects a
 * handoff, token, or session credential.
 */
export function mountLocalControlRoutes(ctx: Context, options: LocalControlRouteOptions): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) throw new Error('host-local-runtime: control routes require WebServer')
  const control: WebRoute = {
    kind: 'exact',
    path: CONTROL_HANDOFF_PATH,
    handler: (request, response) => {
      if (request.method !== 'POST') {
        notFound(response)
        return
      }
      if (!options.auth.authorizeNative(request)) {
        unauthorized(response)
        return
      }
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
      if (request.method !== 'POST') {
        notFound(response)
        return
      }
      const id = await formBodyHandoff(request)
      if (id === undefined) {
        forbidden(response)
        return
      }
      const result = options.auth.consumeBrowserHandoff(id)
      await options.onHandoffSettled?.(id)
      if (result.kind === 'rejected') {
        forbidden(response)
        return
      }
      response.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': options.auth.sessionSetCookie(result.cookie),
      })
      response.end()
    },
  }
  ctx.effect(() => webServer.register(control), 'host-local-runtime: native handoff control')
  const controlService = options.controlService
  if (controlService !== undefined) {
    const nativeControl: WebRoute = {
      kind: 'exact',
      path: CONTROL_PATH,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          notFound(response)
          return
        }
        if (!options.auth.authorizeNative(request)) {
          unauthorized(response)
          return
        }
        const clientId = clientHeader(request)
        const body = await jsonBody(request)
        if (clientId === undefined || !isRuntimeControlRequest(body)) {
          invalidRequest(response)
          return
        }
        await replyControl(response, () => controlService.handleNative(clientId, body))
      },
    }
    const internalControl: WebRoute = {
      kind: 'exact',
      path: INTERNAL_CONTROL_PATH,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          notFound(response)
          return
        }
        if (!options.auth.authorizeNative(request)) {
          unauthorized(response)
          return
        }
        const clientId = clientHeader(request)
        const body = await jsonBody(request)
        if (clientId === undefined || !isInternalControlRequest(body)) {
          invalidRequest(response)
          return
        }
        await replyControl(response, async () => {
          switch (body.operation) {
            case 'attach-client':
              await controlService.attachClient(body.attachmentId)
              return undefined
            case 'release-client':
              await controlService.releaseClient(body.attachmentId)
              return undefined
            case 'open-terminal':
              return controlService.openTerminal(clientId, body.terminalId, body.request)
            case 'submit-terminal':
              return controlService.submitTerminal(body.terminalId, body.input)
            case 'cancel-terminal':
              return controlService.cancelTerminal(body.terminalId)
            case 'run-terminal-control':
              return { kind: 'accepted' }
          }
        })
      },
    }
    const dashboardControl: WebRoute = {
      kind: 'exact',
      path: DASHBOARD_CONTROL_PATH,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          notFound(response)
          return
        }
        if (!options.auth.authorizeDashboard(request)) {
          forbidden(response)
          return
        }
        const body = await jsonBody(request)
        if (!isDashboardControlRequest(body)) {
          invalidRequest(response)
          return
        }
        await replyControl(response, () => controlService.handleDashboard(body))
      },
    }
    ctx.effect(() => webServer.register(nativeControl), 'host-local-runtime: native control operations')
    ctx.effect(() => webServer.register(internalControl), 'host-local-runtime: native attachment operations')
    ctx.effect(() => webServer.register(dashboardControl), 'host-local-runtime: Dashboard control operations')
  }
  ctx.effect(() => webServer.register(handoff), 'host-local-runtime: browser handoff exchange')
  options.mountAuthenticatedDashboard?.(options.auth)
}

type InternalControlRequest =
  | { readonly operation: 'attach-client' | 'release-client'; readonly attachmentId: RuntimeClientId }
  | { readonly operation: 'open-terminal'; readonly terminalId: RuntimeClientId; readonly request: TerminalOpenRequest }
  | { readonly operation: 'submit-terminal'; readonly terminalId: RuntimeClientId; readonly input: TerminalInput }
  | { readonly operation: 'run-terminal-control'; readonly terminalId: RuntimeClientId; readonly command: TerminalControlCommand }
  | { readonly operation: 'cancel-terminal'; readonly terminalId: RuntimeClientId }

/** Parse one bounded JSON object without reflecting parser details. */
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return undefined
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_CONTROL_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    // Malformed request JSON has one stable rejection and no reflected parser text.
    return undefined
  }
}

function isRuntimeControlRequest(value: unknown): value is RuntimeControlRequest {
  if (!plainRecord(value) || typeof value.operation !== 'string') return false
  const keys = Object.keys(value)
  if (value.operation === 'acquire-background-lease' || value.operation === 'release-background-lease') {
    return keys.length === 2 && value.lease === 'web'
  }
  return keys.length === 1 && [
    'status',
    'get-legacy-migration',
    'accept-legacy-migration',
    'decline-legacy-migration',
    'retry-legacy-migration',
    'observe-active-work',
    'stop-own-ui-work',
  ].includes(value.operation)
}

function isDashboardControlRequest(value: unknown): value is DashboardControlRequest {
  return plainRecord(value) && Object.keys(value).length === 1 && [
    'get-legacy-migration',
    'accept-legacy-migration',
    'decline-legacy-migration',
    'retry-legacy-migration',
  ].includes(String(value.operation))
}

function isInternalControlRequest(value: unknown): value is InternalControlRequest {
  if (!plainRecord(value) || typeof value.operation !== 'string') return false
  switch (value.operation) {
    case 'attach-client':
    case 'release-client':
      return typeof value.attachmentId === 'string' && value.attachmentId.length > 0
    case 'open-terminal':
      return typeof value.terminalId === 'string' && value.terminalId.length > 0 && isTerminalOpenRequest(value.request)
    case 'submit-terminal':
      return typeof value.terminalId === 'string' && value.terminalId.length > 0 && isTerminalInput(value.input)
    case 'run-terminal-control':
      return typeof value.terminalId === 'string' && value.terminalId.length > 0 && isTerminalControlCommand(value.command)
    case 'cancel-terminal':
      return typeof value.terminalId === 'string' && value.terminalId.length > 0
    default:
      return false
  }
}

function isTerminalOpenRequest(value: unknown): value is TerminalOpenRequest {
  return plainRecord(value)
    && typeof value.workspace === 'string'
    && (value.initialTask === undefined || typeof value.initialTask === 'string')
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
}

function isTerminalInput(value: unknown): value is TerminalInput {
  if (!plainRecord(value)) return false
  if (value.kind === 'task') return typeof value.text === 'string'
  return value.kind === 'approval'
    && typeof value.approvalId === 'string'
    && (value.decision === 'approve' || value.decision === 'reject')
}

function isTerminalControlCommand(value: unknown): value is TerminalControlCommand {
  if (!plainRecord(value) || typeof value.command !== 'string') return false
  if (value.command === 'model') return value.model === undefined || typeof value.model === 'string'
  if (value.command === 'permissions') return value.permission === undefined || typeof value.permission === 'string'
  if (value.command === 'resume') return value.sessionId === undefined || typeof value.sessionId === 'string'
  return ['plan', 'compact', 'diff', 'terminal', 'doctor', 'exit'].includes(value.command)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clientHeader(request: IncomingMessage): RuntimeClientId | undefined {
  const value = request.headers['x-harness-runtime-client']
  return typeof value === 'string' && value.length > 0 ? value as RuntimeClientId : undefined
}

async function replyControl(response: ServerResponse, operation: () => Promise<unknown>): Promise<void> {
  try {
    const value = await operation()
    if (plainRecord(value) && value.kind === 'session-busy') {
      json(response, { ok: false, result: value })
      return
    }
    json(response, value === undefined ? { ok: true } : { ok: true, value })
  } catch {
    const result: RuntimeControlResult = {
      kind: 'unavailable',
      diagnostic: {
        code: 'runtime-unavailable',
        subject: 'Runtime',
        message: 'The local Harness Runtime operation failed.',
        correction: 'Retry the operation, then use the diagnostic identifier if the failure continues.',
        diagnosticId: randomUUID() as RuntimeDiagnosticId,
      },
    }
    json(response, { ok: false, result })
  }
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function invalidRequest(response: ServerResponse): void {
  response.writeHead(400)
  response.end('invalid request')
}

/** Extract exactly one opaque handoff from the only permitted request location. */
async function formBodyHandoff(request: IncomingMessage): Promise<string | undefined> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return undefined
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk)
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
