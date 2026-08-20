/** Scoped skill fixture that revokes its consumer during catalog discovery. */

import type { Context } from '@harness-desktop/cordis'

export const name = 'runtime-racing-skill-consumer'
export const inject = ['skills']

/** Register one user skill and revoke its scoped consumer while the catalog awaits. */
export function apply(ctx: Context): void {
  let detachConsumer = ctx.skills.attachUserInvocationConsumer()
  ctx.skills.register({
    name: 'runtime-raced-skill',
    description: 'Skill whose exact consumer disappears during discovery.',
    source: 'runtime-race-fixture',
    content: 'These instructions must never be admitted.',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  ctx.skills.registerProvider(() => ({
    name: 'runtime-racing-consumer-provider',
    async list() {
      await Promise.resolve()
      detachConsumer()
      detachConsumer = () => {}
      return []
    },
    get: () => Promise.resolve(undefined),
  }))
}
