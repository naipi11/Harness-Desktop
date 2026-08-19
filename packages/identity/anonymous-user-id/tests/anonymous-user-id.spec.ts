import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessHome } from '@harness-desktop/dsh-host-local-runtime'
import {
  ANONYMOUS_USER_ID_FILE_NAME,
  getOrCreateAnonymousUserId,
} from '../src/index.ts'

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-userid-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('getOrCreateAnonymousUserId', () => {
  it('creates, persists, and returns a bare UUID line on first use', () => {
    const home = tempHome()
    const id = getOrCreateAnonymousUserId(home as HarnessHome)
    expect(id).toMatch(UUID)
    expect(readFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), 'utf8')).toBe(`${id}\n`)
  })

  it('creates the home directory when missing', () => {
    const home = join(tempHome(), 'nested', 'home')
    const id = getOrCreateAnonymousUserId(home as HarnessHome)
    expect(readFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), 'utf8')).toBe(`${id}\n`)
  })

  it('returns the persisted id on subsequent calls, tolerating surrounding whitespace', () => {
    const home = tempHome()
    const existing = '01234567-89ab-4cde-8f01-23456789abcd'
    writeFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), `  ${existing}\n\n`, 'utf8')
    expect(getOrCreateAnonymousUserId(home as HarnessHome)).toBe(existing)
  })

  it('overwrites a corrupt file with a fresh id', () => {
    const home = tempHome()
    writeFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), 'not-a-uuid\n', 'utf8')
    const id = getOrCreateAnonymousUserId(home as HarnessHome)
    expect(id).toMatch(UUID)
    expect(readFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), 'utf8')).toBe(`${id}\n`)
  })

  it('adopts a concurrent winner: exclusive create loses to an id written after the initial read', () => {
    const home = tempHome()
    const winner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const file = join(home, ANONYMOUS_USER_ID_FILE_NAME)
    // The generator hook runs between the initial read (absent) and the wx
    // write, so planting the winner here simulates the concurrent first launch.
    const id = getOrCreateAnonymousUserId(home as HarnessHome, {
      randomUUID: () => {
        writeFileSync(file, `${winner}\n`, 'utf8')
        return 'ffffffff-0000-4000-8000-000000000000'
      },
    })
    expect(id).toBe(winner)
  })

  it('returns a usable id when the home cannot contain files, without persisting', () => {
    const home = tempHome()
    const blocked = join(home, 'blocked')
    writeFileSync(blocked, 'occupied\n')
    const id = getOrCreateAnonymousUserId(blocked as HarnessHome)
    expect(id).toMatch(UUID)
    expect(existsSync(join(blocked, ANONYMOUS_USER_ID_FILE_NAME))).toBe(false)
  })

  it('memoizes per resolved home for the process lifetime: one read, deletion-proof', () => {
    const home = tempHome()
    const first = getOrCreateAnonymousUserId(home as HarnessHome)
    rmSync(join(home, ANONYMOUS_USER_ID_FILE_NAME))
    expect(getOrCreateAnonymousUserId(home as HarnessHome)).toBe(first)
  })

  it('keeps distinct homes on distinct ids', () => {
    const a = getOrCreateAnonymousUserId(tempHome() as HarnessHome)
    const b = getOrCreateAnonymousUserId(tempHome() as HarnessHome)
    expect(a).not.toBe(b)
  })

  it('does not read process.env when the caller injects a root', () => {
    const home = tempHome()
    const previous = process.env.HARNESS_HOME
    process.env.HARNESS_HOME = join(tempHome(), 'unrelated')
    try {
      const id = getOrCreateAnonymousUserId(home as HarnessHome)
      expect(readFileSync(join(home, ANONYMOUS_USER_ID_FILE_NAME), 'utf8')).toBe(`${id}\n`)
    } finally {
      if (previous === undefined) delete process.env.HARNESS_HOME
      else process.env.HARNESS_HOME = previous
    }
  })
})
