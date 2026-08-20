/** Built Runtime composition smoke with the shipped Loader dependency graph. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  }, 30_000)
})
