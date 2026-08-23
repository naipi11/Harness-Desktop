/** Cordis registration and disposal proof for the explained empty companion. */

import { Context } from '@harness-desktop/cordis'
import InvariantRegistry from '@harness-desktop/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as CrossClientInvariant from '../src/invariant.ts'

describe('cross-client Runtime invariant companion', () => {
  it('registers the exact manifest name and releases it with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CrossClientInvariant)

    expect(() => {
      ctx.invariants.register('@harness-desktop/dsh-cross-client-runtime', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    const dispose = ctx.invariants.register('@harness-desktop/dsh-cross-client-runtime', () => {})
    dispose()
    await ctx.fiber.dispose()
  })
})
