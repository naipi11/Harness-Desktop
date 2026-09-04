/** Keyless source and built Runtime-bin module-load probe. */

import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupRuntimeProcess,
  startRuntimeProcess,
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
])('$label Runtime declared bin module probe', ({ mode }) => {
  it('loads the declared entry and returns without starting a server', async () => {
    runtime = await startRuntimeProcess({ mode, runtimeProbeMode: 'module-load' })
    const result = await waitForRuntimeExit(runtime)

    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('harness-runtime: ready probe\n')
  }, 30_000)
})
