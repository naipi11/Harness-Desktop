/** Clean-source backend acceptance over the real base/Web Runtime patches. */

import { access, mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decompressZstdFrame, scanZstdFrames } from '../../../session/session-persistence-jsonl/src/zstd.ts'
import {
  cleanupRuntimeProcess,
  listFiles,
  mintBrowserCookie,
  releaseRuntime,
  runtimeRpc,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from './runtime-process-harness.ts'

let runtime: RuntimeProcess | undefined

afterEach(async () => {
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

describe('clean source backend Runtime fixture', () => {
  it('loads no workspace artifacts and shares committed state through two authenticated carriers', async () => {
    runtime = await startRuntimeProcess({
      mode: 'src',
      entry: 'source-backend-fixture',
      denyWorkspaceLib: true,
    })
    const workspacePath = join(runtime.cwd, 'fixture-workspace')
    await mkdir(workspacePath)
    const endpoint = await waitForEndpoint(runtime)
    const first = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    const second = await mintBrowserCookie(endpoint.port, endpoint.accessToken)
    expect(second).not.toBe(first)

    const updated = await runtimeRpc<{ user?: { baseURL?: string } }>(endpoint.port, first, 'settings.update', {
      ns: 'llm-deepseek',
      patch: { baseURL: 'https://runtime-fixture.invalid' },
    })
    expect(updated.user?.baseURL).toBe('https://runtime-fixture.invalid')
    const settings = await runtimeRpc<{ namespaces: { ns: string; user?: { baseURL?: string } }[] }>(
      endpoint.port, second, 'settings.describe', {},
    )
    expect(settings.namespaces.find(namespace => namespace.ns === 'llm-deepseek')?.user?.baseURL)
      .toBe('https://runtime-fixture.invalid')

    const credentialRef = 'TASK5_WRITABLE_CREDENTIAL'
    const credentialValue = `runtime-credential-${randomUUID()}`
    await runtimeRpc(endpoint.port, first, 'credentials.set', { ref: credentialRef, value: credentialValue })
    const credential = await runtimeRpc<{
      credentials: Record<string, { configured: boolean; source?: string; writable: boolean }>
    }>(endpoint.port, second, 'credentials.describe', { refs: [credentialRef] })
    expect(credential.credentials[credentialRef])
      .toEqual({ configured: true, source: 'platform', writable: true })

    const createdWorkspace = await runtimeRpc<{ workspace: { workspaceId: string; path: string } }>(
      endpoint.port, first, 'workspace.create', { path: workspacePath },
    )
    const workspaces = await runtimeRpc<{ items: { workspaceId: string; path: string }[] }>(
      endpoint.port, second, 'workspace.list', {},
    )
    expect(workspaces.items).toContainEqual(createdWorkspace.workspace)

    const sessionId = 'task5-runtime-session'
    await runtimeRpc(endpoint.port, first, 'session.create', {
      workspaceId: createdWorkspace.workspace.workspaceId,
      sessionId,
      agentPreset: 'standard',
    })
    await runtimeRpc(endpoint.port, first, 'session.rename', { sessionId, title: 'committed before retirement' })
    const sessions = await runtimeRpc<{ items: { sessionId: string }[] }>(endpoint.port, second, 'session.list', {})
    expect(sessions.items.some(item => item.sessionId === sessionId)).toBe(true)

    const result = await releaseRuntime(runtime)
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toMatch(/^harness-runtime: ready /)

    const events = result.trace.map(event => event.event)
    expect(result.trace.filter(event => event.event === 'workspace-lib-denied')).toEqual([])
    expect(result.trace.filter(event => event.event === 'listener-open'))
      .toEqual([{ event: 'listener-open', address: '127.0.0.1', port: endpoint.port }])
    expect(events.indexOf('release-requested')).toBeLessThan(events.lastIndexOf('session-synced'))
    expect(events.lastIndexOf('session-synced')).toBeLessThan(events.indexOf('endpoint-retired'))
    expect(events.indexOf('endpoint-retired')).toBeLessThan(events.indexOf('lock-released'))
    expect(events.indexOf('lock-released')).toBeLessThan(events.indexOf('listener-close'))
    expect(events.indexOf('listener-close')).toBeLessThan(events.indexOf('process-exit'))

    const files = await listFiles(runtime.harnessHome)
    const credentialMetadata = join(runtime.harnessHome, '.credential-references.json')
    expect(files).toContain(credentialMetadata)
    const metadataText = await readFile(credentialMetadata, 'utf8')
    expect(JSON.parse(metadataText)).toEqual({ version: 1, references: [credentialRef] })
    expect(metadataText).not.toContain(credentialValue)
    expect(files.some(path => path === join(runtime!.harnessHome, 'settings.yaml'))).toBe(true)
    expect(files.some(path => relative(runtime!.harnessHome, path).split(/[\\/]/)[0] === 'storages')).toBe(true)
    const sessionLog = files.find(path => path.endsWith('.jsonl.zstd'))
    if (sessionLog === undefined) throw new Error(`Runtime wrote no Zstandard session log: ${JSON.stringify(files)}`)
    const encoded = await readFile(sessionLog)
    const decoded = await Promise.all(scanZstdFrames(encoded).frames.map(async frame =>
      (await decompressZstdFrame(encoded.subarray(frame.start, frame.end))).toString('utf8')))
    expect(decoded.join('')).toContain('committed before retirement')
    expect(files.every(path => isAbsolute(path) && !relative(runtime!.harnessHome, path).startsWith('..'))).toBe(true)
    await expect(access(runtime.legacyHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(runtime.legacyHome, '.credential-references.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const platformFiles = (await listFiles(runtime.platformHome)).map(path => relative(runtime!.platformHome, path))
    const productWriter = new RegExp(
      String.raw`(?:^|[\\/])(?:sessions|storages|settings\.yaml|\.credential-references\.json|runtime\.lock|runtime-endpoint\.json)(?:$|[\\/])`,
    )
    expect(platformFiles.filter(path => productWriter.test(path)))
      .toEqual([])
    await expect(access(join(runtime.harnessHome, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(runtime.harnessHome, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 90_000)
})
