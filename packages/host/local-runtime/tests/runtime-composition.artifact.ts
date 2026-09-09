/** Built Runtime composition smoke with the shipped Loader dependency graph. */

import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mintBrowserCookie, runtimeRpc } from './runtime-process-harness.ts'

let root: string | undefined
let dispose: (() => Promise<void>) | undefined

interface ArtifactHome {
  readonly home: string
  path(...segments: readonly string[]): string
}

interface ArtifactRuntime {
  status(): { port: number }
  dispose(): Promise<void>
}

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('built canonical Runtime composition', () => {
  it('boots the shipped base and Web composition through one injected provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-runtime-shipped-'))
    const entry = pathToFileURL(join(process.cwd(), 'packages', 'host', 'local-runtime', 'lib', 'runtime.js')).href
    const runtimeModule = await import(entry) as {
      startCanonicalRuntime(config: { harnessHome: ArtifactHome; idleTimeoutMs: number }): Promise<ArtifactRuntime>
    }
    const dataRoot = await import('@harness-desktop/dsh-host-local-runtime') as {
      createLocalRuntimePlugin(config: { env: { HARNESS_HOME: string }; homeDir: string }): ArtifactHome
    }
    const runtime = await runtimeModule.startCanonicalRuntime({
      harnessHome: dataRoot.createLocalRuntimePlugin({ env: { HARNESS_HOME: root }, homeDir: root }),
      idleTimeoutMs: 60_000,
    })
    dispose = () => runtime.dispose()

    expect(runtime.status().port).toBeGreaterThan(0)
    const endpoint = JSON.parse(await readFile(join(root, 'runtime-endpoint.json'), 'utf8')) as {
      port: number
      accessToken: string
    }
    const cookie = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const roster = await runtimeRpc<{ presets: { id: string; trust: string; broken?: string }[] }>(
      endpoint.port, cookie, 'agentPreset.list', {},
    )
    expect(roster.presets.find(preset => preset.id === 'standard')).toMatchObject({ id: 'standard', trust: 'system' })
    expect(roster.presets.every(preset => preset.broken === undefined)).toBe(true)
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    const { workspace } = await runtimeRpc<{ workspace: { workspaceId: string } }>(
      endpoint.port, cookie, 'workspace.create', { path: workspacePath },
    )
    const session = await runtimeRpc<{ sessionId: string }>(
      endpoint.port, cookie, 'session.create', { workspaceId: workspace.workspaceId },
    )
    expect(session.sessionId).toBeTruthy()
    await writeFile(join(workspacePath, 'visible.txt'), 'workbench-fixture')
    const origin = `http://127.0.0.1:${endpoint.port}`
    const response = await fetch(`${origin}/_harness/workbench`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'files', workspaceId: workspace.workspaceId, directory: '' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true, value: { entries: [{ name: 'visible.txt', kind: 'file' }] },
    })
    if (process.platform === 'win32') {
      const ref = `HARNESS_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`
      try {
        await runtimeRpc(endpoint.port, cookie, 'credentials.set', { ref, value: `synthetic-${randomUUID()}` })
        const info = await runtimeRpc<{ credentials: Record<string, { configured: boolean; source: string; writable: boolean }> }>(
          endpoint.port, cookie, 'credentials.describe', { refs: [ref] },
        )
        expect(info.credentials[ref]).toEqual({ configured: true, source: 'platform', writable: true })
      } finally { await runtimeRpc(endpoint.port, cookie, 'credentials.unset', { ref }) }
    }
  }, 30_000)
})
