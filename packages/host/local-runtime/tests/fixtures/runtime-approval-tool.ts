/** Deterministic real approval consumer for Runtime terminal PTY evidence. */

import type { Context } from '@harness-desktop/cordis'
import { defineTool } from '@harness-desktop/dsh-tools'

export const name = 'runtime-approval-tool'
export const inject = ['approval', 'commands', 'tools']

/** Register one tool whose only effect is a real approval request. */
export function apply(ctx: Context): void {
  for (const command of ['plan', 'compact', 'diff', 'terminal', 'doctor']) {
    ctx.commands.register({
      name: command,
      description: `Exercise the terminal /${command} control.`,
      handler: () => ({ kind: 'success', text: `RUNTIME_CONTROL_${command.toUpperCase()}` }),
    })
  }
  ctx.tools.register(defineTool({
    name: 'runtime_approval',
    description: 'Exercise one deterministic approval round trip.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { outcome: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.outcome }],
    },
    async execute(_args, execution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('runtime approval fixture requires an Agent')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'runtime_approval',
        reason: 'exercise the terminal approval round trip',
        signal: execution.signal,
      })
      return { outcome }
    },
  }))
}
