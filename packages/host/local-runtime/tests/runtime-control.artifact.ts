/** Built package smoke for the private Runtime control assembly. */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
})
