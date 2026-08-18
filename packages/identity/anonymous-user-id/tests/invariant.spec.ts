import { describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import InvariantRegistry from '@harness-desktop/dsh-invariants'
import * as UserIdInvariant from '@harness-desktop/dsh-anonymous-user-id/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserIdInvariant).await()).resolves.toBeDefined()
  })
})
