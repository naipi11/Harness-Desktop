/** Scoped skill fixture that revokes its consumer during catalog discovery. */

import type { Context } from '@harness-desktop/cordis'
import type { PreStepDecision } from '@harness-desktop/dsh-agent'
import { createUserMessage } from '@harness-desktop/dsh-llm'
import { renderSkillContent, type SkillInvocationSource } from '@harness-desktop/dsh-skill'
import type { UserMessage } from '@harness-desktop/dsh-session'

export const name = 'runtime-racing-skill-consumer'
export const inject = ['skills']

/** Register one user skill and revoke its scoped consumer as the admitted message enters the inbox. */
export function apply(ctx: Context): void {
  ctx.skills.register({
    name: 'runtime-raced-skill',
    description: 'Skill whose exact consumer disappears during discovery.',
    source: 'runtime-race-fixture',
    content: 'These instructions must never be admitted.',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const message = messages.find(candidate => candidate.content.some(block =>
      block.type === 'text' && block.text.startsWith('/runtime-raced-skill')))
    if (message === undefined) return decision
    const claim = ctx.skills.claimUserInvocation(agent, message, 'runtime-raced-skill')
    if (claim.kind === 'revoked') return { kind: 'reject' }
    if (claim.kind === 'none') return decision
    const source: SkillInvocationSource = {
      kind: 'skill-invocation', name: claim.skill.name, form: 'instructions',
    }
    const injected: UserMessage = createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(claim.skill) }],
      source,
    })
    return { kind: 'enter', messages: [...decision.messages, injected] }
  })
  let detachConsumer = ctx.skills.attachUserInvocationConsumer()
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (!message.content.some(block => block.type === 'text' && block.text.startsWith('/runtime-raced-skill'))) return
    detachConsumer()
    detachConsumer = () => {}
  })
}
