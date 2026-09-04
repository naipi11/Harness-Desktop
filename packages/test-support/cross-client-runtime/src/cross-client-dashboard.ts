/** Body-only Dashboard handoff and exact-origin cookie API carrier. */

import {
  AbstractApiClient,
  type IApiClient,
} from '@harness-desktop/dsh-host-apiproxy/client'
import type {
  HistoryEntry,
  RpcResponse,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@harness-desktop/dsh-host-apiproxy/api'
import type { SessionId } from '@harness-desktop/dsh-session/types'
import type {
  CrossClientDashboardApiAdapter,
  CrossClientStateClient,
} from './cross-client-fixture.ts'

/** Stable secret-free rejection from Dashboard origin, handoff, or cookie validation. */
export class CrossClientDashboardCarrierError extends Error {
  constructor() {
    super('The cross-client Dashboard carrier rejected an unsafe response.')
    this.name = 'CrossClientDashboardCarrierError'
  }
}

function exactLoopbackOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (_invalidUrl) {
    throw new CrossClientDashboardCarrierError()
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  const port = Number(parsed.port)
  if (parsed.protocol !== 'http:' || !loopback || parsed.port === ''
    || !Number.isInteger(port) || port < 1 || port > 65_535
    || parsed.username !== '' || parsed.password !== ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
    || parsed.origin !== value) {
    throw new CrossClientDashboardCarrierError()
  }
  return parsed.origin
}

function cookiePair(response: Response): string {
  if (response.status !== 303 || response.headers.get('location') !== '/') {
    throw new CrossClientDashboardCarrierError()
  }
  return validateCookiePair(response.headers.get('set-cookie')?.split(';', 1)[0])
}

function validateCookiePair(pair: string | undefined): string {
  const separator = pair?.indexOf('=') ?? -1
  if (pair === undefined || separator < 1 || separator === pair.length - 1) {
    throw new CrossClientDashboardCarrierError()
  }
  return pair
}

/** Host API client that retains one cookie and refuses every non-exact origin request. */
export class DashboardCookieApiClient extends AbstractApiClient {
  #cookie: string
  readonly #origin: string

  /**
   * @param origin - validated exact loopback HTTP origin.
   * @param cookie - private name/value cookie pair.
   * @param fetcher - injected or global Fetch implementation.
   */
  constructor(origin: string, cookie: string, private readonly fetcher: typeof fetch = globalThis.fetch) {
    super()
    this.#origin = exactLoopbackOrigin(origin)
    this.#cookie = validateCookiePair(cookie)
  }

  protected override resolveBase(): string {
    return this.#origin
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    if (input.origin !== this.#origin || this.#cookie === '') throw new CrossClientDashboardCarrierError()
    const headers = new Headers(init?.headers)
    headers.set('cookie', this.#cookie)
    headers.set('origin', this.#origin)
    return this.fetcher(input, { ...init, headers })
  }

  /** Forget the retained cookie without returning it. */
  close(): void {
    this.#cookie = ''
  }
}

function unwrap<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new CrossClientDashboardCarrierError()
  return response.result.value
}

class DashboardStateClient implements CrossClientStateClient {
  constructor(
    private readonly client: IApiClient & { close(): void },
    private readonly clearPrivateValues: () => void,
  ) {}

  async createWorkspace(path: string): Promise<WorkspaceView> {
    return unwrap(await this.client.workspace.create({ path })).workspace
  }

  async createSession(workspaceId: WorkspaceId): Promise<SessionId> {
    return unwrap(await this.client.sessions.create({ workspaceId, agentPreset: 'standard' })).sessionId
  }

  async readWorkspaces(): Promise<readonly WorkspaceView[]> {
    return unwrap(await this.client.workspace.list({})).items
  }

  async readSessions(): Promise<readonly SessionSummary[]> {
    return unwrap(await this.client.sessions.list({})).items
  }

  async readHistory(sessionId: SessionId): Promise<readonly HistoryEntry[]> {
    return unwrap(await this.client.sessions.history({ sessionId })).events
  }

  async prompt(sessionId: SessionId, text: string): Promise<void> {
    unwrap(await this.client.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }))
  }

  close(): Promise<void> {
    try {
      this.client.close()
    } finally {
      this.clearPrivateValues()
    }
    return Promise.resolve()
  }
}

/**
 * Create the default body-only handoff and private-cookie Dashboard adapter.
 * @param fetcher - Fetch implementation used for handoff exchange and API calls.
 * @returns an adapter that validates navigation before retaining any secret.
 */
export function createCrossClientDashboardApiAdapter(
  fetcher: typeof fetch = globalThis.fetch,
): CrossClientDashboardApiAdapter {
  return {
    async connect(runtime) {
      const dashboard = await runtime.attachDashboard()
      const privateValues = new Set<string>()
      try {
        const navigation = await dashboard.createBrowserHandoff()
        const origin = exactLoopbackOrigin(navigation.origin)
        privateValues.add(navigation.handoff.id)
        const exchanged = await fetcher(`${origin}/_harness/handoff`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
          body: new URLSearchParams({ handoff: navigation.handoff.id }),
        })
        const cookie = cookiePair(exchanged)
        privateValues.add(cookie)
        privateValues.add(cookie.slice(cookie.indexOf('=') + 1))
        const client = new DashboardCookieApiClient(origin, cookie, fetcher)
        const clearPrivateValues = (): void => { privateValues.clear() }
        return {
          api: new DashboardStateClient(client, clearPrivateValues),
          dashboard,
          containsPrivateValue: text => [...privateValues].some(value => text.includes(value)),
        }
      } catch (_privateFailure) {
        privateValues.clear()
        await dashboard.close().catch(() => {})
        throw new CrossClientDashboardCarrierError()
      }
    },
  }
}
