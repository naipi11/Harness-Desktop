/** Byte and item bounds at the Runtime's public response and terminal-page boundaries. */

import { describe, expect, it } from 'vitest'
import * as runtimeClient from '../src/runtime-client.ts'
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

function privateValueGuard(): (value: unknown, token: string, home: string, platform: string) => void {
  const guard = (runtimeClient as unknown as {
    assertNoPrivateRuntimeValues?: (value: unknown, token: string, home: string, platform: string) => void
  }).assertNoPrivateRuntimeValues
  expect(guard).toBeTypeOf('function')
  return guard!
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

describe('selected Runtime private-value redaction', () => {
  it('normalizes Windows case and separators while respecting path-component boundaries', () => {
    const guard = privateValueGuard()
    const home = 'C:\\Users\\Alice\\Harness'
    for (const rejected of [
      'c:/users/ALICE/harness',
      'C:/USERS/Alice/Harness/sessions/one.jsonl',
      'failure under C:\\users\\alice/HARNESS\\projects',
    ]) {
      expect(() => { guard({ text: rejected }, 'private-token-value', home, 'win32') }).toThrow(RuntimeProtocolError)
      try {
        guard({ text: rejected }, 'private-token-value', home, 'win32')
      } catch (error) {
        expect(String(error)).not.toContain(home)
        expect(String(error)).not.toContain('private-token-value')
      }
    }
    expect(() => { guard({ text: 'C:\\Users\\Alice\\Harness-sibling\\file.txt' }, 'private-token-value', home, 'win32') })
      .not.toThrow()
    expect(() => { guard({ text: 'prefixC:\\Users\\Alice\\Harness\\ordinary' }, 'private-token-value', home, 'win32') })
      .not.toThrow()
  })

  it('preserves POSIX case and rejects only exact or descendant component matches', () => {
    const guard = privateValueGuard()
    const home = '/Users/Alice/Harness'
    expect(() => { guard({ text: home }, 'private-token-value', home, 'linux') }).toThrow(RuntimeProtocolError)
    expect(() => { guard({ text: `${home}/sessions/one.jsonl` }, 'private-token-value', home, 'linux') })
      .toThrow(RuntimeProtocolError)
    expect(() => { guard({ text: '/users/alice/harness/sessions/one.jsonl' }, 'private-token-value', home, 'linux') })
      .not.toThrow()
    expect(() => { guard({ text: '/Users/Alice/Harness-sibling/file.txt' }, 'private-token-value', home, 'linux') })
      .not.toThrow()
    expect(() => { guard({ text: 'prefix/Users/Alice/Harness/ordinary' }, 'private-token-value', home, 'linux') })
      .not.toThrow()
    expect(() => { guard({ text: 'prefix private-token-value suffix' }, 'private-token-value', home, 'linux') })
      .toThrow(RuntimeProtocolError)
  })
})
