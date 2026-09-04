/** Focused ownership failures for the Host-side cross-client Web adapter. */

import type { Browser } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { RuntimeClient } from '@harness-desktop/dsh-host-local-runtime'
import { createCrossClientWebAdapter } from './cross-client-web-adapter.ts'

describe('cross-client Web adapter cleanup', () => {
  it('retries a failed owner close and reports open plus cleanup without private values', async () => {
    let closeCalls = 0
    const runtime = {
      status: async () => ({ state: 'stopping' }),
      close: async () => {
        closeCalls += 1
        throw new Error('private runtime close failure')
      },
    } as unknown as RuntimeClient
    const adapter = createCrossClientWebAdapter({} as Browser, {
      requireWebDist: async () => {},
      loadRuntimeApi: async () => ({
        createRuntimeConnector: () => ({ connect: async () => runtime }),
      }),
    }).adapter
    const context = {
      home: 'PRIVATE_HOME_VALUE',
      platformHome: 'PRIVATE_PLATFORM_HOME_VALUE',
      workspace: 'PRIVATE_WORKSPACE_VALUE',
    }

    let thrown: unknown
    try {
      await adapter.open(context)
    } catch (error) {
      thrown = error
    }

    expect(closeCalls).toBe(2)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).message).toBe('Cross-client Web open and cleanup failed.')
    expect(((thrown as AggregateError).errors as Error[]).map(error => error.message)).toEqual([
      'The built Web acceptance adapter failed.',
      'Cross-client Web cleanup failed.',
    ])
    expect(JSON.stringify(thrown)).not.toMatch(/PRIVATE_|runtime close failure/u)
  })
})
