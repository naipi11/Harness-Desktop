#!/usr/bin/env node
/** Plain-Node internal app-boot artifact fixture with no product CLI parser. */

import { pathToFileURL } from 'node:url'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@harness-desktop/dsh-app-boot'

const rootConfig = process.env.ARTIFACT_ROOT_CONFIG
const basePatch = process.env.ARTIFACT_BASE_PATCH
const probe = process.env.ARTIFACT_PROBE
const credentialProvider = process.env.ARTIFACT_CREDENTIAL_PROVIDER
const installAnchor = process.env.ARTIFACT_INSTALL_ANCHOR
const bareModuleBaseUrl = process.env.ARTIFACT_BARE_MODULE_BASE
if ([rootConfig, basePatch, probe, credentialProvider, installAnchor, bareModuleBaseUrl]
  .some(value => value === undefined || value === '')) {
  throw new Error('app-boot artifact fixture paths are required')
}

healProfilesModuleFallback(installAnchor, process.env.HARNESS_HOME)
let requestedExit
const exitRequested = new Promise(resolve => { requestedExit = resolve })
let exitCode = 1
const patches = [
  ...loadOverlayPatches('app-boot-artifact', basePatch).map((patch) => {
    if (!Array.isArray(patch.insert)) return patch
    return {
      ...patch,
      insert: patch.insert.map(entry => entry.id === 'credentials'
        ? { ...entry, name: pathToFileURL(credentialProvider).href }
        : entry),
    }
  }),
  { insert: [{ id: 'base-root-probe', name: pathToFileURL(probe).href }] },
]
const ctx = await boot('app-boot-artifact', rootConfig, patches, (host) => {
  host.provide('cmdlineArgs', { get: () => Object.freeze([]) })
  host.provide('appExit', (code) => {
    exitCode = code
    requestedExit?.(code)
    void host.fiber.dispose()
  })
}, bareModuleBaseUrl)
await exitRequested
await ctx.fiber.dispose()
process.exitCode = exitCode
