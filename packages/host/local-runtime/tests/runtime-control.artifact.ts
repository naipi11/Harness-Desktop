/** Built package smoke for the private Runtime control assembly. */

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('built private Runtime control assembly', () => {
  it('loads the shipped private control entry without exposing it from the package root', async () => {
    const privateEntry = pathToFileURL(join(
      process.cwd(), 'packages', 'host', 'local-runtime', 'lib', 'runtime-control.js',
    )).href
    const script = [
      "import { Context } from '@harness-desktop/cordis'",
      "const root = await import('@harness-desktop/dsh-host-local-runtime')",
      `const control = await import(${JSON.stringify(privateEntry)})`,
      "if ('mountPrivateRuntimeControl' in root) throw new Error('private control leaked from package root')",
      "await import('@harness-desktop/dsh-host-local-runtime/private-runtime-control').then(() => { throw new Error('private control leaked through package exports') }, error => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error })",
      'const routes = []',
      'const ctx = new Context()',
      "ctx.provide('webServer', { register(route) { routes.push(route); return () => {} } })",
      "await ctx.plugin({ inject: ['webServer'], apply(inner) { control.mountPrivateRuntimeControl(inner, { accessToken: 'test-token', origin: 'http://127.0.0.1:38123', bootstrapParent: process.cwd(), openBootstrap: async () => {}, mountAuthenticatedDashboard: () => {} }) } }).await()",
      "if (routes.map(route => route.path).join(',') !== '/_harness/control/browser-handoff,/_harness/handoff') throw new Error('private routes were not mounted')",
      "process.stdout.write('private-control-mounted')",
    ].join('; ')
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: join(process.cwd(), 'packages', 'host', 'local-runtime'),
      encoding: 'utf8',
    })

    expect(result.stdout).toBe('private-control-mounted')
    expect(result.stderr).not.toContain('test-token')
  })

  it('packs the private entry with its emitted Runtime dependency chunk', async () => {
    const packageDirectory = join(process.cwd(), 'packages', 'host', 'local-runtime')
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as { files: string[] }

    expect(manifest.files).toContain('lib/*.js')
  })

  it('typechecks the built private declaration closure from declared package dependencies', async () => {
    const packageDirectory = join(process.cwd(), 'packages', 'host', 'local-runtime')
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies).toHaveProperty('@harness-desktop/dsh-host-apiproxy')
    expect(manifest.dependencies).toHaveProperty('@harness-desktop/dsh-llm')

    const consumer = await mkdtemp(join(tmpdir(), 'harness-runtime-types-'))
    try {
      const nodeModules = join(consumer, 'node_modules')
      const packageTarget = join(nodeModules, '@harness-desktop', 'dsh-host-local-runtime')
      await mkdir(dirname(packageTarget), { recursive: true })
      await symlink(packageDirectory, packageTarget, 'junction')
      const resolveFromPackage = createRequire(join(packageDirectory, 'package.json'))
      for (const dependency of Object.keys(manifest.dependencies).filter(name => name.startsWith('@harness-desktop/'))) {
        const target = dirname(resolveFromPackage.resolve(`${dependency}/package.json`))
        const link = join(nodeModules, ...dependency.split('/'))
        await mkdir(dirname(link), { recursive: true })
        await symlink(target, link, 'junction')
      }
      const nodeTypes = dirname(dirname(createRequire(import.meta.url).resolve('@types/node/package.json')))
      await mkdir(join(nodeModules, '@types'), { recursive: true })
      await symlink(join(nodeTypes, 'node'), join(nodeModules, '@types', 'node'), 'junction')
      await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
      await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'es2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
          skipLibCheck: true, preserveSymlinks: true, noEmit: true, types: ['node'],
        },
        include: ['index.ts'],
      }))
      await writeFile(join(consumer, 'index.ts'), [
        "import type { RuntimeClient } from '@harness-desktop/dsh-host-local-runtime'",
        "import type { RuntimeControlServiceOptions } from './node_modules/@harness-desktop/dsh-host-local-runtime/lib/types/control-service.js'",
        "type Sessions = NonNullable<RuntimeControlServiceOptions['api']>['sessions']",
        'declare const client: RuntimeClient',
        'declare const sessions: Sessions',
        'void client; void sessions',
      ].join('\n'))
      await execFileAsync(process.execPath, [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p', join(consumer, 'tsconfig.json'), '--pretty', 'false',
      ], { cwd: process.cwd(), encoding: 'utf8' })
    } finally {
      await rm(consumer, { recursive: true, force: true })
    }
  })
})
