import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { pkgAssets, pruneDependencyTests } from './build-cli-exe.ts'

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

  it('includes shipped bundle patch files without broad YAML dependency globs', () => {
    expect(pkgAssets).toContain('node_modules/**/cordis.patch.yml')
    expect(pkgAssets).not.toContain('node_modules/**/*.yml')
    expect(pkgAssets).not.toContain('node_modules/**/*.yaml')
  })

  it('declares every required app-boot peer as a production dependency', () => {
    const cli = JSON.parse(readFileSync(resolve(import.meta.dirname, '../apps/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const appBoot = JSON.parse(readFileSync(resolve(import.meta.dirname, '../packages/boot/app-boot/package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const missing = Object.keys(appBoot.peerDependencies ?? {}).filter(peer =>
      appBoot.peerDependenciesMeta?.[peer]?.optional !== true && cli.dependencies?.[peer] === undefined,
    )
    expect(missing, 'required app-boot peers must be staged by pnpm deploy --prod').toEqual([])
  })
})
