/** Private native authorization and transient browser-session authentication. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdtemp, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { runtimePrivatePathPolicy, type PrivatePathPolicy } from './instance-lock.ts'

const HANDOFF_LIFETIME_MS = 60_000
const SESSION_COOKIE_NAME = 'harness_session'

/** One native-control handoff value, intentionally opaque to browser code. */
export interface BrowserHandoff {
  readonly id: string
  readonly expiresAt: number
}

/** Result of consuming an opaque browser handoff. */
export type BrowserHandoffResult =
  | { readonly kind: 'accepted'; readonly cookie: string }
  | { readonly kind: 'rejected' }

/** Inputs that define one Runtime's private and browser-facing authorities. */
export interface LocalDashboardAuthOptions {
  /** Endpoint-record token retained by native launchers only. */
  readonly accessToken: string
  /** Exact HTTP Runtime origin, restricted to a 127.0.0.1 authority. */
  readonly origin: string
  /** Injectable clock for expiry tests. */
  readonly now?: () => number
}

interface HandoffRecord {
  readonly expiresAt: number
  readonly expiryTimer: ReturnType<typeof setTimeout>
}

interface HeaderRequest {
  readonly headers: IncomingHttpHeaders | Headers
}

/**
 * Keeps native control tokens, short-lived handoffs, and browser sessions in
 * Runtime memory. Handoff values are consumed by deletion before a session is
 * issued, so a concurrent replay cannot obtain a second cookie.
 */
export class LocalDashboardAuth {
  private readonly handoffs = new Map<string, HandoffRecord>()
  private readonly sessions = new Set<string>()
  private readonly now: () => number
  private readonly origin: string
  private readonly authority: string

  constructor(private readonly options: LocalDashboardAuthOptions) {
    const origin = new URL(options.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) {
      throw new Error('host-local-runtime: browser origin must be an exact http://127.0.0.1 authority')
    }
    this.origin = origin.origin
    this.authority = origin.host
    this.now = options.now ?? Date.now
  }

  /** Mint one opaque form-body handoff that expires after the fixed 60-second interval. */
  mintBrowserHandoff(): BrowserHandoff {
    const id = randomSecret()
    const expiresAt = this.now() + HANDOFF_LIFETIME_MS
    const expiryTimer = setTimeout(() => { this.handoffs.delete(id) }, HANDOFF_LIFETIME_MS)
    expiryTimer.unref?.()
    this.handoffs.set(id, { expiresAt, expiryTimer })
    return { id, expiresAt }
  }

  /** Authorize a private native control request without accepting browser authorities. */
  authorizeNative(request: Pick<IncomingMessage, 'headers'>): boolean {
    return header(request, 'host') === this.authority
      && equalSecret(bearerToken(header(request, 'authorization')), this.options.accessToken)
  }

  /**
   * Atomically exchange a valid form-body handoff for an HttpOnly-cookie value.
   * Rejections intentionally have one indistinguishable result so callers do
   * not disclose expiry, replay, or random-token distinctions.
   */
  consumeBrowserHandoff(id: string): BrowserHandoffResult {
    const handoff = this.handoffs.get(id)
    if (handoff === undefined || handoff.expiresAt <= this.now()) {
      if (handoff !== undefined) clearTimeout(handoff.expiryTimer)
      this.handoffs.delete(id)
      return { kind: 'rejected' }
    }
    clearTimeout(handoff.expiryTimer)
    this.handoffs.delete(id)
    const session = randomSecret()
    this.sessions.add(session)
    return { kind: 'accepted', cookie: `${SESSION_COOKIE_NAME}=${session}` }
  }

  /** Accept a Dashboard carrier only with the Runtime's exact Origin and issued HttpOnly cookie. */
  authorizeDashboard(request: HeaderRequest): boolean {
    return this.dashboardOwner(request) !== undefined
  }

  /**
   * Derive the stable, non-secret control owner for one authenticated browser session.
   * @param request - Dashboard request carrying the exact Origin and HttpOnly cookie.
   * @returns a one-way owner id, or undefined when authentication fails.
   */
  dashboardOwner(request: HeaderRequest): string | undefined {
    if (header(request, 'host') !== this.authority || header(request, 'origin') !== this.origin) return undefined
    const session = cookieValue(header(request, 'cookie'), SESSION_COOKIE_NAME)
    if (session === undefined || !this.sessions.has(session)) return undefined
    return `dashboard-${createHash('sha256').update(session).digest('base64url')}`
  }

  /** Render the only permitted browser session cookie attributes. */
  sessionSetCookie(cookie: string): string {
    return `${cookie}; HttpOnly; SameSite=Strict; Path=/`
  }
}

/** Dependencies for a launcher-owned exactly-once bootstrap cleanup controller. */
export interface BootstrapCleanupOptions {
  /** Injectable wall clock used to bind cleanup to the handoff expiry. */
  readonly now?: () => number
  /** Injectable scheduler; the callback owns no secret or request details. */
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  /** Injectable cancellation companion for the scheduler. */
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Test-only removal seam; production removes the owned document then its directory. */
  readonly remove?: (path: string) => Promise<void>
}

/** A local file that carries one opaque form-body handoff and no navigation secret. */
export interface BootstrapDocument {
  readonly directory: string
  readonly path: string
  readonly url: string
}

/** Inputs for creating the launcher's one-use private local bootstrap document. */
export interface BootstrapDocumentOptions {
  /** Existing parent beneath which a fresh owner-only bootstrap directory is created. */
  readonly parent: string
  /** Exact Runtime origin receiving the top-level form post. */
  readonly origin: string
  /** Opaque handoff that may appear only in the document's hidden form field. */
  readonly handoff: BrowserHandoff
  /** Injectable private path policy for platform-specific access verification. */
  readonly privatePathPolicy?: PrivatePathPolicy
}

/**
 * Bind a one-time cleanup of a launcher-owned bootstrap document to its handoff
 * expiry. Native dispatch and either exchange outcome call the same operation.
 */
export function createBootstrapCleanup(
  bootstrapDocumentPath: string,
  expiresAt: number,
  options: BootstrapCleanupOptions = {},
): { dispatchFailed(): Promise<void>; exchangeSettled(): Promise<void> } {
  const now = options.now ?? Date.now
  const remove = options.remove ?? removeOwnedBootstrapDocument
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let cleanup: Promise<void> | undefined
  const run = (): Promise<void> => {
    cleanup ??= remove(bootstrapDocumentPath)
    return cleanup
  }
  const timer = setTimer(() => { void run() }, Math.max(0, expiresAt - now()))
  return {
    async dispatchFailed() {
      clearTimer(timer)
      await run()
    },
    async exchangeSettled() {
      clearTimer(timer)
      await run()
    },
  }
}

/**
 * Create and verify a fresh owner-only bootstrap document. Its file URL is
 * clean; the caller opens it separately and never receives the handoff back.
 */
export async function createBootstrapDocument(options: BootstrapDocumentOptions): Promise<BootstrapDocument> {
  const runtime = new URL(options.origin)
  if (runtime.protocol !== 'http:' || runtime.hostname !== '127.0.0.1' || runtime.href !== `${runtime.origin}/`) {
    throw new Error('host-local-runtime: bootstrap target must be an exact http://127.0.0.1 origin')
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(options.handoff.id)) {
    throw new Error('host-local-runtime: bootstrap handoff must be opaque')
  }
  const policy = options.privatePathPolicy ?? runtimePrivatePathPolicy
  const directory = await mkdtemp(join(options.parent, 'harness-bootstrap-'))
  const path = join(directory, 'index.html')
  try {
    await policy.protectDirectory(directory)
    await writeFile(path, bootstrapHtml(runtime.origin, options.handoff.id), { flag: 'wx', mode: 0o600 })
    await policy.protectFile(path)
    const document = { directory, path, url: pathToFileURL(path).href }
    await verifyBootstrapDocument(document, policy)
    return document
  } catch (error) {
    await removeOwnedBootstrapDocument(path).catch(() => {})
    throw error
  }
}

/** Verify that a bootstrap document and its owning directory remain current-user-only. */
export async function verifyBootstrapDocument(
  bootstrap: Pick<BootstrapDocument, 'directory' | 'path'>,
  policy: PrivatePathPolicy = runtimePrivatePathPolicy,
): Promise<void> {
  if (process.platform !== 'win32') {
    const directoryMode = (await stat(bootstrap.directory)).mode & 0o777
    if (directoryMode !== 0o700) {
      throw new Error(`host-local-runtime: ${bootstrap.directory} must have mode 700`)
    }
  }
  await policy.verifyFile(bootstrap.path)
}

/** Remove only the owned bootstrap leaf, then its now-empty owner directory. */
async function removeOwnedBootstrapDocument(path: string): Promise<void> {
  const entry = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (entry !== undefined) {
    if (entry.isDirectory()) throw new Error('host-local-runtime: bootstrap document path must not be a directory')
    await unlink(path)
  }
  await rmdir(dirname(path)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function header(request: HeaderRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : undefined
}

function equalSecret(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}

function cookieValue(cookie: string | undefined, name: string): string | undefined {
  if (cookie === undefined) return undefined
  for (const item of cookie.split(';')) {
    const [key, ...value] = item.trim().split('=')
    if (key === name && value.length === 1 && value[0] !== '') return value[0]
  }
  return undefined
}

function bootstrapHtml(origin: string, handoff: string): string {
  return `<!doctype html><meta charset="utf-8"><form id="handoff" method="post" action="${origin}/_harness/handoff"><input type="hidden" name="handoff" value="${handoff}"></form><script>document.getElementById('handoff').submit()</script>`
}
