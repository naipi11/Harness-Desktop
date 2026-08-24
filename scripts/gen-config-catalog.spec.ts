/** Config-catalog schema/type presence checks. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog } from './gen-config-catalog.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('config catalog type presence', () => {
  it('accepts a schema key declared as an interface method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-config-catalog-'))
    roots.push(root)
    const pkg = join(root, 'packages', 'fixture', 'method-config')
    await mkdir(join(pkg, 'src'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/method-config' }))
    await writeFile(join(pkg, 'src', 'index.ts'), [
      "import z from '@harness-desktop/schemastery'",
      '',
      'interface Home {',
      '  /** Absolute root. */',
      '  readonly home: string',
      '  /** Join child segments. */',
      '  path(...segments: readonly string[]): string',
      '}',
      '',
      'interface Config {',
      '  /** Resolved storage root. */',
      '  harnessHome: Home',
      '}',
      '',
      'export default class MethodConfig {',
      '  static Config = z.object({ harnessHome: z.object({ home: z.string(), path: z.any() }) })',
      '  constructor(_ctx: unknown, _config: Config) {}',
      '}',
      '',
    ].join('\n'))

    expect(() => collectConfigCatalog(root)).not.toThrow()
  })
})
