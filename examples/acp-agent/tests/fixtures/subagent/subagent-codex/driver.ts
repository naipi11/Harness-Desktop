#!/usr/bin/env node
/** Inspect the public Codex provider composition without invoking the product. */

import { boot, resolveConfigPath } from '@harness-desktop/dsh-app-boot'
import { SESSION_FORMAT_VERSION, SessionId } from '@harness-desktop/dsh-session'
import type {} from '@harness-desktop/dsh-subagent'
import type {} from '@harness-desktop/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('subagent-codex Loader composition driver requires a config path')
}

let starts = 0
const ctx = await boot(
  'subagent-codex-loader-composition',
  resolveConfigPath(configPath, undefined),
  undefined,
  (hostCtx) => {
    hostCtx.on('subagent/start', () => {
      starts += 1
    })
  },
)

try {
  const persistenceProbe = SessionId('subagent-codex-composition-root')
  await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: persistenceProbe,
    createdAt: 0,
  })
  await ctx.sessionPersistence.append(persistenceProbe, [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
  ])
  const provider = ctx.subagents.getProvider('codex')
  if (provider === undefined) throw new Error('Codex provider was not registered')
  const tool = ctx.tools.schemas().find(schema => schema.name === 'subagent_codex')
  if (tool === undefined) throw new Error('subagent_codex tool was not registered')
  const properties = tool.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('subagent_codex tool has invalid parameter properties')
  }

  process.stdout.write(`${JSON.stringify({
    providers: ctx.subagents.list(),
    provider: {
      name: provider.name,
      capabilities: provider.capabilities,
      inheritsParentContext: provider.inheritsParentContext,
    },
    tool: {
      name: tool.name,
      parameterNames: Object.keys(properties).sort(),
      required: tool.parameters.required,
    },
    starts,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
