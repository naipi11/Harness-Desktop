#!/usr/bin/env node
/** Clean-source Runtime fixture over the real base/Web Host rows. */

import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Context } from '@harness-desktop/cordis'
import type { PatchOptions } from '@harness-desktop/cordis-plugin-include'
import { boot, installSourceLoaderResolution, loadOverlayPatches } from '@harness-desktop/dsh-app-boot'
import { provideCmdline } from '@harness-desktop/dsh-cmdline'
import type {} from '@harness-desktop/dsh-commands'
import { createLocalRuntimePlugin } from '../../src/data-root.ts'
import { startRuntime } from '../../src/runtime.ts'

const ARTIFACT_ONLY_PACKAGES = new Set([
  '@harness-desktop/dsh-cordis-client-runner',
  '@harness-desktop/dsh-typert-loader',
])
const WRITABLE_CREDENTIAL_PROVIDER = new URL('./runtime-writable-credentials.ts', import.meta.url).href
const REPLAY_PROVIDER = import.meta.resolve('@harness-desktop/dsh-llm-replay')

/** Apply the real patch while explicitly excluding rows whose only runtime is build-generated. */
function sourceBackendPatches(patches: readonly PatchOptions[]): PatchOptions[] {
  return structuredClone(patches).map((patch) => {
    if (typeof patch !== 'object' || patch === null || !('insert' in patch) || !Array.isArray(patch.insert)) return patch
    return {
      ...patch,
      insert: patch.insert.map((entry) => {
        if (typeof entry !== 'object' || entry === null || typeof entry.name !== 'string') return entry
        const disabled = entry.name.startsWith('@harness-desktop/dsh-client-') || ARTIFACT_ONLY_PACKAGES.has(entry.name)
        const name = entry.id === 'credentials'
          ? WRITABLE_CREDENTIAL_PROVIDER
          : entry.name.startsWith('cordis:') ? entry.name : import.meta.resolve(entry.name)
        return { ...entry, name, ...(disabled ? { disabled: true } : {}) }
      }),
    }
  })
}

async function flushSessions(ctx: Context): Promise<void> {
  const sessions = ctx.get('sessions') as {
    list(): readonly unknown[]
    flush(session: unknown): Promise<boolean>
  } | undefined
  if (sessions === undefined) throw new Error('Runtime source fixture has no session service')
  await Promise.all(sessions.list().map(session => sessions.flush(session)))
}

const harnessHome = createLocalRuntimePlugin({ env: process.env })
const runtimeConfig = fileURLToPath(new URL('../../runtime.cordis.yml', import.meta.url))
const basePatch = fileURLToPath(new URL('../../../../bundle/base/cordis.patch.yml', import.meta.url))
const webPatch = fileURLToPath(new URL('../../../../bundle/web-app/cordis.patch.yml', import.meta.url))

const runtime = await startRuntime({
  harnessHome,
  idleTimeoutMs: 60_000,
  mountPrivateControl: true,
  flush: flushSessions,
  async boot(provider) {
    const patches = sourceBackendPatches([
      ...loadOverlayPatches('runtime-source-backend', basePatch),
      ...loadOverlayPatches('runtime-source-backend', webPatch),
    ])
    const replayOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    const replayFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    if (replayOverride !== undefined && replayFile !== undefined) {
      patches.push({ id: 'session-title-llm', disabled: true })
      patches.push({
        insert: [{
          id: 'runtime-test-llm-replay',
          name: REPLAY_PROVIDER,
          config: { file: replayFile, overrideFile: replayOverride },
        }],
      })
    }
    const context = await boot('runtime-source-backend', runtimeConfig, patches, (ctx) => {
      installSourceLoaderResolution(ctx, specifier => import.meta.resolve(specifier))
      provideCmdline(ctx, { args: [], exit: () => {} })
    }, undefined, provider)
    if (process.env.DSH_RUNTIME_TEST_COMMAND === '1') {
      context.commands.register({
        name: 'runtime_no_turn',
        description: 'Deterministic Runtime command fixture',
        handler: () => ({ kind: 'success', text: 'REAL_COMMAND_OUTPUT' }),
      })
    }
    return context
  },
})
process.stderr.write(`harness-runtime: ready ${JSON.stringify(runtime.status())}\n`)

if (process.env.HARNESS_RUNTIME_TEST_MODE === 'stdin-lifetime') {
  process.stdin.resume()
  await once(process.stdin, 'end')
  await runtime.dispose()
}
