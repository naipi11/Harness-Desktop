#!/usr/bin/env node
/** Canonical source Runtime plus keyless replay and approval providers for Electron acceptance. */

import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { boot, installSourceLoaderResolution, loadOverlayPatches } from '@harness-desktop/dsh-app-boot'
import { provideCmdline } from '@harness-desktop/dsh-cmdline'
import { createLocalRuntimePlugin } from '@harness-desktop/dsh-host-local-runtime'

const replayProvider = new URL('../../../../packages/test-support/llm-replay/src/index.ts', import.meta.url).href
const approvalTool = new URL(
  '../../../../packages/host/local-runtime/tests/fixtures/runtime-approval-tool.ts', import.meta.url,
).href
const runtimeConfig = fileURLToPath(new URL(
  '../../../../packages/host/local-runtime/runtime.cordis.yml', import.meta.url,
))
const basePatch = fileURLToPath(new URL('../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const webPatch = fileURLToPath(new URL('../../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url))

async function flushSessions(ctx) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('Desktop live Runtime has no session service')
  await Promise.all(sessions.list().map(session => sessions.flush(session)))
}

const replayOverride = process.env.HARNESS_DESKTOP_REPLAY_OVERRIDE
if (replayOverride === undefined) throw new Error('Desktop live Runtime requires its replay override')
const harnessHome = createLocalRuntimePlugin({ env: process.env })
const runtimeModuleUrl = new URL('../../../../packages/host/local-runtime/src/runtime.ts', import.meta.url).href
const { startRuntime } = await import(runtimeModuleUrl)
const runtime = await startRuntime({
  harnessHome,
  idleTimeoutMs: 60_000,
  mountPrivateControl: true,
  flush: flushSessions,
  async boot(provider) {
    const patches = [
      ...loadOverlayPatches('desktop-live-runtime', basePatch),
      ...loadOverlayPatches('desktop-live-runtime', webPatch),
      { id: 'session-title-llm', disabled: true },
      { id: 'agent-default-model', config: { provider: 'desktop-replay', model: 'live' } },
      { insert: [
        {
          id: 'desktop-live-replay',
          name: replayProvider,
          config: {
            file: `${replayOverride}.missing`,
            overrideFile: replayOverride,
            paceMs: 100,
            providers: [{
              id: 'desktop-replay',
              name: 'Desktop Replay',
              models: [{ id: 'live', name: 'Live Acceptance' }],
            }],
          },
        },
        { id: 'desktop-live-approval-tool', name: approvalTool },
      ] },
    ]
    return boot('desktop-live-runtime', runtimeConfig, patches, (ctx) => {
      installSourceLoaderResolution(ctx, specifier => import.meta.resolve(specifier))
      provideCmdline(ctx, { args: [], exit: () => {} })
    }, undefined, provider)
  },
})
process.stderr.write(`harness-runtime: ready ${JSON.stringify(runtime.status())}\n`)
if (process.env.HARNESS_RUNTIME_TEST_MODE === 'stdin-lifetime') {
  process.stdin.resume()
  await once(process.stdin, 'end')
  await runtime.dispose()
}
