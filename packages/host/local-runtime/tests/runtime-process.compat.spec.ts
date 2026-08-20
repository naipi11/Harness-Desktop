/** Source and built Runtime processes share the public private-control protocol. */

import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeConnector, type RuntimeClient } from '../src/runtime-client.ts'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from './runtime-process-harness.ts'

let runtime: RuntimeProcess | undefined
let client: RuntimeClient | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

describe.each([
  { label: 'source', mode: 'src' as const },
  { label: 'built', mode: 'lib' as const },
])('$label Runtime public-control compatibility', ({ mode }) => {
  it('discovers status and releases the one named Web lease through the public client', async () => {
    runtime = await startRuntimeProcess({ mode })
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    client = await connector.connect({ start: false })

    expect((await client.status()).runtimeId).toBeDefined()
    expect(await client.acquireBackgroundLease()).toEqual({ id: 'web' })
    expect(await client.releaseBackgroundLease()).toEqual({ id: 'web', state: 'absent' })
    await client.close()
    client = undefined
    const result = await releaseRuntime(runtime)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain(endpoint.accessToken)
  }, 90_000)
})
