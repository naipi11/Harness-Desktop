import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import Loader from '@harness-desktop/cordis-plugin-loader'
import Include from '@harness-desktop/cordis-plugin-include'
import { CallId } from '@harness-desktop/dsh-llm'
import { Session, SessionId } from '@harness-desktop/dsh-session'
import AgentRegistry, { Inbox } from '@harness-desktop/dsh-agent'
import type { Agent } from '@harness-desktop/dsh-agent'
import SystemPrompt from '@harness-desktop/dsh-system-prompt'
import ToolRuntime from '@harness-desktop/dsh-tools'
import TerminalSessionService from '@harness-desktop/dsh-terminal'
import SandboxProvider from '@harness-desktop/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@harness-desktop/dsh-sandbox'
import SandboxPolicyService from '@harness-desktop/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@harness-desktop/dsh-subprocess-local'
import * as TerminalLocal from '@harness-desktop/dsh-terminal-bash'
import * as ToolPty from '@harness-desktop/dsh-tool-terminal'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@harness-desktop/dsh-agent'",
      "- name: '@harness-desktop/dsh-system-prompt'",
      "- name: '@harness-desktop/dsh-tools'",
      "- name: '@harness-desktop/dsh-terminal'",
      "- name: '@harness-desktop/dsh-test-sandbox'",
      "- name: '@harness-desktop/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@harness-desktop/dsh-subprocess-local'",
      "- name: '@harness-desktop/dsh-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@harness-desktop/dsh-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@harness-desktop/dsh-agent', AgentRegistry],
      ['@harness-desktop/dsh-system-prompt', SystemPrompt],
      ['@harness-desktop/dsh-tools', ToolRuntime],
      ['@harness-desktop/dsh-terminal', TerminalSessionService],
      ['@harness-desktop/dsh-test-sandbox', PassthroughSandbox],
      ['@harness-desktop/dsh-sandbox-policy', SandboxPolicyService],
      ['@harness-desktop/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@harness-desktop/dsh-terminal-bash', TerminalLocal],
      ['@harness-desktop/dsh-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    const signal = new AbortController().signal
    const spawn = await context.tools.execute({
      signal, callId: CallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await context.tools.execute({
      signal, callId: CallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await context.tools.execute({
      signal, callId: CallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
