/** Loader-mounted user-only skill for the real Runtime slash-path snapshot. */

import type { Context } from '@harness-desktop/cordis'

export const name = 'runtime-user-skill-fixture'
export const inject = ['skills']

/** Register one deterministic user-only skill in the assembled Runtime. */
export function apply(ctx: Context): void {
  ctx.skills.register({
    name: 'runtime-user-skill',
    description: 'Deterministic user-only Runtime skill',
    source: 'runtime',
    content: 'Follow the deterministic Runtime skill instructions.',
    invocation: { modelInvocable: false, userInvocable: true },
  })
}
