/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@harness-desktop/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@harness-desktop/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the node-half service and capture its plugin-bundle route. */
function constructWithRoute(
  packageNames: string[],
  disabledNames: ReadonlySet<string> = new Set(),
): { service: ClientModuleRegistry; route: WebRoute } {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        const disabled = disabledNames.has(packageName)
        yield { options: { name: packageName }, fiber: disabled ? undefined : {}, disabled }
      }
    },
  })
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  const service = new ClientModuleRegistry(ctx)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return constructWithRoute(packageNames).service
}

describe('client bundle activation', () => {
  it('retains the package identity of a built file-URL Host entry', () => {
    const packageName = '@fixture/built-file-entry'
    const clientPath = writePackage(packageName)
    const hostPath = join(dirname(clientPath), 'index.js')
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    writeFileSync(hostPath, 'module.exports = {}\n')

    expect(construct([pathToFileURL(hostPath).href]).graph().entries.map(entry => entry.id))
      .toEqual([packageName])
  })

  it('keeps one package row while another built file entry for that package is disabled', () => {
    const packageName = '@fixture/built-file-aliases'
    const clientPath = writePackage(packageName)
    const firstHostPath = join(dirname(clientPath), 'index.js')
    const secondHostPath = join(dirname(clientPath), 'secondary.js')
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    writeFileSync(firstHostPath, 'module.exports = {}\n')
    writeFileSync(secondHostPath, 'module.exports = {}\n')
    const firstEntry = pathToFileURL(firstHostPath).href
    const secondEntry = pathToFileURL(secondHostPath).href

    const { service } = constructWithRoute([firstEntry, secondEntry], new Set([secondEntry]))

    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('ignores an anonymous built package without a Web client declaration', () => {
    const clientPath = writePackage('@fixture/anonymous-non-client', { name: undefined })
    const hostPath = join(dirname(clientPath), 'index.js')
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(hostPath, 'module.exports = {}\n')

    expect(construct([pathToFileURL(hostPath).href]).graph().entries).toEqual([])
  })

  it('ignores an unresolvable built file entry', () => {
    writePackage('@fixture/file-entry-anchor', { name: undefined })
    const missingEntry = pathToFileURL(join(root!, 'missing-package', 'lib', 'index.js')).href

    expect(construct([missingEntry]).graph().entries).toEqual([])
  })

  it('reports an unrelated malformed built package only on its own dirty pass', () => {
    const goodName = '@fixture/good-built-entry'
    const goodClient = writePackage(goodName)
    const goodHost = join(dirname(goodClient), 'index.js')
    mkdirSync(dirname(goodClient), { recursive: true })
    writeFileSync(goodClient, 'module.exports = {}\n')
    writeFileSync(goodHost, 'module.exports = {}\n')

    const badClient = writePackage('@fixture/malformed-built-entry')
    const badHost = join(dirname(badClient), 'index.js')
    mkdirSync(dirname(badClient), { recursive: true })
    writeFileSync(badHost, 'module.exports = {}\n')
    writeFileSync(join(dirname(badClient), '..', 'package.json'), '{')

    expect(() => construct([pathToFileURL(badHost).href, pathToFileURL(goodHost).href]))
      .toThrow('client-modules: 1 client package failed to compose:')
  })

  it('includes an explicitly client-only package while its Host entry is disabled', () => {
    const packageName = '@fixture/client-only-disabled-host'
    const clientPath = writePackage(packageName, {
      dsh: { client: { platform: 'web', includeWhenDisabled: true } },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')

    const { service } = constructWithRoute([packageName], new Set([packageName]))

    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })
})
