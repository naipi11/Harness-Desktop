/** Bounded release source retrieval behavior. */

import { describe, expect, it, vi } from 'vitest'
import {
  fetchAllowedUpdateBytes,
  fetchAllowedUpdateJson,
  type UpdateFetch,
} from '@harness-desktop/dsh-update-policy'

const origin = 'https://updates.example.invalid'
const endpoint = `${origin}/stable.json`

function options(fetch: UpdateFetch, overrides: Partial<Parameters<typeof fetchAllowedUpdateBytes>[1]> = {}) {
  return { allowedOrigins: [origin], maximumBytes: 128, timeoutMs: 1_000, fetch, ...overrides }
}

describe('allowed update source', () => {
  it('returns bounded bytes and decoded JSON from an exact allowlisted origin', async () => {
    const fetch = vi.fn<UpdateFetch>()
      .mockResolvedValueOnce(new Response('{"version":"1.1.0"}', { status: 200, headers: { 'content-length': '19' } }))
      .mockResolvedValueOnce(new Response('{"version":"1.1.0"}', { status: 200, headers: { 'content-length': '19' } }))

    await expect(fetchAllowedUpdateBytes(endpoint, options(fetch))).resolves.toEqual(new TextEncoder().encode('{"version":"1.1.0"}'))
    await expect(fetchAllowedUpdateJson(endpoint, options(fetch))).resolves.toEqual({ version: '1.1.0' })
    expect(fetch).toHaveBeenCalledWith(new URL(endpoint), expect.objectContaining({ method: 'GET', redirect: 'manual' }))
  })

  it('follows a bounded same-origin redirect and rejects a cross-origin redirect', async () => {
    const sameOrigin = vi.fn<UpdateFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next.json' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await expect(fetchAllowedUpdateBytes(endpoint, options(sameOrigin))).resolves.toEqual(new TextEncoder().encode('ok'))
    expect(sameOrigin).toHaveBeenCalledTimes(2)

    const crossOrigin = vi.fn<UpdateFetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://other.example.invalid/next.json' },
    }))
    await expect(fetchAllowedUpdateBytes(endpoint, options(crossOrigin))).rejects.toMatchObject({ code: 'update-source-redirect-invalid' })
  })

  it.each([
    ['non-HTTPS endpoint', 'http://updates.example.invalid/stable.json', 'update-source-origin-invalid'],
    ['credential endpoint', 'https://token@updates.example.invalid/stable.json', 'update-source-origin-invalid'],
    ['query endpoint', `${endpoint}?unsafe=true`, 'update-source-origin-invalid'],
  ])('rejects a %s before I/O', async (_label, value, code) => {
    const fetch = vi.fn<UpdateFetch>()
    await expect(fetchAllowedUpdateBytes(value, options(fetch))).rejects.toMatchObject({ code })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed, failed, oversized, and invalid JSON responses without raw response detail', async () => {
    const status = vi.fn<UpdateFetch>().mockResolvedValue(new Response('bad', { status: 500 }))
    await expect(fetchAllowedUpdateBytes(endpoint, options(status))).rejects.toMatchObject({ code: 'update-source-response-invalid' })

    const failed = vi.fn<UpdateFetch>().mockRejectedValue(new Error('network details'))
    await expect(fetchAllowedUpdateBytes(endpoint, options(failed))).rejects.toMatchObject({ code: 'update-source-request-failed' })

    const oversized = vi.fn<UpdateFetch>().mockResolvedValue(new Response('x'.repeat(129), { status: 200 }))
    await expect(fetchAllowedUpdateBytes(endpoint, options(oversized))).rejects.toMatchObject({ code: 'update-source-size-exceeded' })

    const invalidJson = vi.fn<UpdateFetch>().mockResolvedValue(new Response('{', { status: 200 }))
    await expect(fetchAllowedUpdateJson(endpoint, options(invalidJson))).rejects.toMatchObject({ code: 'update-source-json-invalid' })
  })

  it('reports a timeout when the loader aborts a request that never settles', async () => {
    const fetch = vi.fn<UpdateFetch>().mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>{  reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    }))

    await expect(fetchAllowedUpdateBytes(endpoint, options(fetch, { timeoutMs: 1 }))).rejects.toMatchObject({ code: 'update-source-timeout' })
  })
})
