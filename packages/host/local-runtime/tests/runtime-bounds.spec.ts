/** Byte and item bounds at the Runtime's public response and terminal-page boundaries. */

import { describe, expect, it } from 'vitest'
import {
  MAX_RUNTIME_CONTROL_RESPONSE_BYTES,
  MAX_TERMINAL_EVENT_PAGE_BYTES,
  MAX_TERMINAL_EVENT_PAGE_ITEMS,
  MAX_TERMINAL_EVENT_TEXT_BYTES,
  parseTerminalEventPage,
  readBoundedRuntimeResponseJson,
  RuntimeProtocolError,
} from '../src/runtime-client.ts'

function exactJsonBytes(bytes: number): string {
  const prefix = '{"value":"'
  const suffix = '"}'
  return prefix + 'a'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix
}

describe('bounded Runtime HTTP response JSON', () => {
  it('accepts tiny and exact-byte JSON but rejects one extra byte', async () => {
    await expect(readBoundedRuntimeResponseJson(new Response('{}'))).resolves.toEqual({})
    const exact = exactJsonBytes(MAX_RUNTIME_CONTROL_RESPONSE_BYTES)
    expect(Buffer.byteLength(exact)).toBe(MAX_RUNTIME_CONTROL_RESPONSE_BYTES)
    const parsed = await readBoundedRuntimeResponseJson(new Response(exact))
    expect(typeof (parsed as { value?: unknown }).value).toBe('string')
    await expect(readBoundedRuntimeResponseJson(new Response(exact + ' '))).rejects.toBeInstanceOf(RuntimeProtocolError)
  })

  it('counts multibyte response bytes rather than JavaScript characters', async () => {
    const value = JSON.stringify({ value: '界'.repeat(Math.ceil(MAX_RUNTIME_CONTROL_RESPONSE_BYTES / 3)) })
    expect(value.length).toBeLessThan(MAX_RUNTIME_CONTROL_RESPONSE_BYTES)
    expect(Buffer.byteLength(value)).toBeGreaterThan(MAX_RUNTIME_CONTROL_RESPONSE_BYTES)
    await expect(readBoundedRuntimeResponseJson(new Response(value))).rejects.toBeInstanceOf(RuntimeProtocolError)
  })
})

describe('bounded terminal event pages', () => {
  it('accepts the exact item limit and rejects one extra item', () => {
    const event = { kind: 'output', text: '' }
    expect(() => parseTerminalEventPage({
      events: Array.from({ length: MAX_TERMINAL_EVENT_PAGE_ITEMS }, () => event),
      nextCursor: MAX_TERMINAL_EVENT_PAGE_ITEMS,
    })).not.toThrow()
    expect(() => parseTerminalEventPage({
      events: Array.from({ length: MAX_TERMINAL_EVENT_PAGE_ITEMS + 1 }, () => event),
      nextCursor: MAX_TERMINAL_EVENT_PAGE_ITEMS + 1,
    })).toThrow(RuntimeProtocolError)
  })

  it('bounds one event string by encoded bytes including multibyte text', () => {
    expect(() => parseTerminalEventPage({
      events: [{ kind: 'output', text: 'a'.repeat(MAX_TERMINAL_EVENT_TEXT_BYTES) }],
      nextCursor: 1,
    })).not.toThrow()
    expect(() => parseTerminalEventPage({
      events: [{ kind: 'output', text: 'a'.repeat(MAX_TERMINAL_EVENT_TEXT_BYTES + 1) }],
      nextCursor: 1,
    })).toThrow(RuntimeProtocolError)
    expect(() => parseTerminalEventPage({
      events: [{ kind: 'output', text: '界'.repeat(Math.floor(MAX_TERMINAL_EVENT_TEXT_BYTES / 3) + 1) }],
      nextCursor: 1,
    })).toThrow(RuntimeProtocolError)
  })

  it('rejects a page whose encoded events exceed the aggregate byte limit', () => {
    const text = 'x'.repeat(Math.floor(MAX_TERMINAL_EVENT_PAGE_BYTES / 2))
    expect(() => parseTerminalEventPage({
      events: [{ kind: 'output', text }, { kind: 'output', text }],
      nextCursor: 2,
    })).toThrow(RuntimeProtocolError)
  })
})
