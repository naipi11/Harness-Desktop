import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { pruneDependencyTests } from './build-cli-exe.ts'

const roots: string[] = []

function write(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CLI pkg staging', () => {
  it('removes dependency test directories while retaining production assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cli-staging-'))
    roots.push(root)
    write(join(root, 'production.js'))
    write(join(root, 'package.json'), '{}')
    write(join(root, 'test', 'index.js'))
    write(join(root, 'nested', '__tests__', 'index.js'))
    write(join(root, 'nested', 'tests', 'fixture.json'))

    await pruneDependencyTests(root)

    expect(existsSync(join(root, 'production.js'))).toBe(true)
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(existsSync(join(root, 'test'))).toBe(false)
    expect(existsSync(join(root, 'nested', '__tests__'))).toBe(false)
    expect(existsSync(join(root, 'nested', 'tests'))).toBe(false)
  })
})
