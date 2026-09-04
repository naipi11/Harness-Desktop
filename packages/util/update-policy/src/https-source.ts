/** Bounded HTTPS retrieval from release-policy allowlisted origins. */

/** Global-fetch compatible function injected by production callers and tests. */
export type UpdateFetch = (input: URL | string, init?: RequestInit) => Promise<Response>

/** Stable failure reason for a remote update input. */
export type UpdateSourceErrorCode =
  | 'update-source-origin-invalid'
  | 'update-source-request-failed'
  | 'update-source-redirect-invalid'
  | 'update-source-response-invalid'
  | 'update-source-size-exceeded'
  | 'update-source-timeout'
  | 'update-source-json-invalid'

/** Fixed, non-reflective error from a bounded release-source retrieval. */
export class UpdateSourceError extends Error {
  /** @param code - stable failure code safe for a caller's redacted outcome. */
  constructor(readonly code: UpdateSourceErrorCode) {
    super(code)
    this.name = 'UpdateSourceError'
  }
}

/** Options that bound one release manifest or artifact request. */
export interface AllowedUpdateFetchOptions {
  /** HTTPS origins configured in the application release policy. */
  readonly allowedOrigins: readonly string[]
  /** Maximum received bytes including every streamed chunk. */
  readonly maximumBytes: number
  /** Maximum number of same-policy redirect responses to follow. */
  readonly maximumRedirects?: number
  /** Timeout for the complete request, including redirects and body read. */
  readonly timeoutMs: number
  /** Optional caller-owned cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation; defaults to the Node global. */
  readonly fetch?: UpdateFetch
}

/**
 * Fetch one release input without trusting redirects or unbounded response data.
 * @param location - policy-configured endpoint or manifest-authenticated artifact URL.
 * @param options - static origin allowlist and strict request bounds.
 * @returns the exact successful response bytes.
 * @throws {@link UpdateSourceError} with a stable redacted reason.
 */
export async function fetchAllowedUpdateBytes(location: string, options: AllowedUpdateFetchOptions): Promise<Uint8Array> {
  if (!isPositiveInteger(options.maximumBytes) || !isPositiveInteger(options.timeoutMs)) {
    throw sourceError('update-source-response-invalid')
  }
  const maximumRedirects = options.maximumRedirects ?? 3
  if (!Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 8) {
    throw sourceError('update-source-response-invalid')
  }
  const initial = allowedUrl(location, options.allowedOrigins)
  if (initial === undefined) throw sourceError('update-source-origin-invalid')
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw sourceError('update-source-request-failed')

  const timeout = new AbortController()
  const signal = combinedSignal(options.signal, timeout.signal)
  const timer = setTimeout(() => { timeout.abort() }, options.timeoutMs)
  try {
    let current = initial
    for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
      let response: Response
      try {
        response = await fetcher(current, { method: 'GET', redirect: 'manual', signal })
      } catch (error) {
        if (timeout.signal.aborted) throw sourceError('update-source-timeout')
        if (isAbortError(error) || options.signal?.aborted === true) throw sourceError('update-source-request-failed')
        throw sourceError('update-source-request-failed')
      }
      if (isRedirect(response.status)) {
        if (redirect === maximumRedirects) throw sourceError('update-source-redirect-invalid')
        const target = response.headers.get('location')
        if (target === null) throw sourceError('update-source-redirect-invalid')
        const next = allowedUrl(target, options.allowedOrigins, current)
        if (next === undefined) throw sourceError('update-source-redirect-invalid')
        current = next
        continue
      }
      if (response.status !== 200) throw sourceError('update-source-response-invalid')
      return await readBoundedBody(response, options.maximumBytes, timeout.signal)
    }
    throw sourceError('update-source-redirect-invalid')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and decode one exact JSON record from an allowed update endpoint.
 * @param location - policy-configured manifest endpoint.
 * @param options - static origin allowlist and strict request bounds.
 * @returns parsed JSON with no implied schema validity.
 * @throws {@link UpdateSourceError} with a stable redacted reason.
 */
export async function fetchAllowedUpdateJson(location: string, options: AllowedUpdateFetchOptions): Promise<unknown> {
  const bytes = await fetchAllowedUpdateBytes(location, options)
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw sourceError('update-source-json-invalid') }
}

function allowedUrl(value: string, allowedOrigins: readonly string[], base?: URL): URL | undefined {
  let url: URL
  try { url = new URL(value, base) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  return allowedOrigins.includes(url.origin) ? url : undefined
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isPositiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }

function combinedSignal(external: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (external === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([external, timeout])
  const combined = new AbortController()
  const abort = (): void => { combined.abort() }
  external.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  return combined.signal
}

async function readBoundedBody(response: Response, maximumBytes: number, timeout: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw sourceError('update-source-size-exceeded')
  }
  if (response.body === null) throw sourceError('update-source-response-invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() } catch {
        if (timeout.aborted) throw sourceError('update-source-timeout')
        throw sourceError('update-source-request-failed')
      }
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) throw sourceError('update-source-size-exceeded')
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch {
      // The body is already consumed or failed; cancellation cannot change the settled public outcome.
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function sourceError(code: UpdateSourceErrorCode): UpdateSourceError { return new UpdateSourceError(code) }
