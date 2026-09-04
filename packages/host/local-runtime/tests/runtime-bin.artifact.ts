/** Source and built declared-bin acceptance after their explicit lib prerequisite. */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  waitForRuntimeExit,
  type RuntimeProcess,
} from './runtime-process-harness.ts'

let runtime: RuntimeProcess | undefined

afterEach(async () => {
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

describe.each([
  { label: 'source', mode: 'src' as const },
  { label: 'built', mode: 'lib' as const },
])('$label Runtime declared bin after build', ({ label, mode }) => {
  it('starts and releases its controlled lifetime without an orphaned owner', async () => {
    runtime = await startRuntimeProcess({ mode, observeWorkspaceModules: true })
    await waitForEndpoint(runtime)
    const result = await releaseRuntime(runtime)

    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toMatch(/^harness-runtime: ready /)
    const modules = result.trace.filter(event => event.event === 'workspace-module')
    const settingsPlane = `/packages/settings/settings-file/${mode === 'src' ? 'src' : 'lib'}/index.`
    expect(modules.some(event => event.url?.replaceAll('\\', '/').includes(settingsPlane))).toBe(true)
    if (mode === 'src') {
      expect(modules.some(event => event.url?.endsWith('/lib/typert.host.js'))).toBe(true)
    }
    await expect(access(join(runtime.harnessHome, 'runtime-endpoint.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(runtime.harnessHome, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prints only the stable diagnostic for a credential-bearing provider failure', async () => {
    const sentinel = `TASK5_${label.toUpperCase()}_SENTINEL`
    const token = `token-${label}-secret`
    const credential = `credential-${label}-secret`
    const raw = `raw ${label} provider rejection`
    runtime = await startRuntimeProcess({
      mode,
      failImport: '/settings-file/',
      failureMessage: `${sentinel} ${token} ${credential} ${raw} {HARNESS_HOME}`,
    })
    const result = await waitForRuntimeExit(runtime)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('harness-runtime: startup failed\n')
    for (const secret of [sentinel, token, credential, raw, runtime.harnessHome]) {
      expect(result.stdout + result.stderr).not.toContain(secret)
    }
  })

  it.each([
    { label: 'blank', value: '' },
    { label: 'whitespace', value: ' \t ' },
  ])('redacts a $label HARNESS_HOME validation failure', async ({ value }) => {
    runtime = await startRuntimeProcess({ mode, harnessHomeEnv: value })
    const result = await waitForRuntimeExit(runtime)

    expect(result.exitCode).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('harness-runtime: startup failed\n')
    expect(result.stderr).not.toContain('/packages/host/local-runtime/')
    expect(result.stderr).not.toContain('\\packages\\host\\local-runtime\\')
  })
})
