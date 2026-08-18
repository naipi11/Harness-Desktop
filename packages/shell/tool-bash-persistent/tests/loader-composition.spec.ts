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
import TerminalSessionService from '@harness-desktop/dsh-terminal'
import * as TerminalLocal from '@harness-desktop/dsh-terminal-bash'
import SandboxProvider from '@harness-desktop/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@harness-desktop/dsh-sandbox'
import SandboxPolicyService from '@harness-desktop/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@harness-desktop/dsh-subprocess-local'
import SystemPrompt from '@harness-desktop/dsh-system-prompt'
import ToolRuntime from '@harness-desktop/dsh-tools'
import * as ToolBashPersistent from '@harness-desktop/dsh-tool-bash-persistent'

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

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId('persistent-bash-loader-agent')
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('persistent Bash through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-persistent-bash-loader-'))
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
      '    idleSilenceMs: 100',
      '    handoffGraceMs: 100',
      '    scrollbackLines: 20000',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@harness-desktop/dsh-tool-bash-persistent'",
      '  config:',
      '    timeoutMs: 5000',
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
      ['@harness-desktop/dsh-tool-bash-persistent', ToolBashPersistent],
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

    const owner = agent(context, root)
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => context!.tools.execute({
      signal,
      callId: CallId(id),
      name: 'bash',
      arguments: { command },
      agent: owner,
    })

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['bash'])
    await execute('state', 'export KEEP=loader; mkdir -p nested; cd nested')
    const observed = text(await execute('observe', 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('DSH_PERSISTENT_BASH')

    const multiline = text(await execute(
      'multiline',
      'value="line one"\nprintf "%s:%s\\n" "$value" "it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('DSH_PERSISTENT_BASH')

    const heredoc = text(await execute(
      'heredoc',
      "cat <<'EOF'\nalpha\nbeta\nEOF",
    ))
    expect(heredoc).toBe('alpha\nbeta')

    const large = text(await execute('large-output', 'seq 1 12050'))
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next bash call starts from the workspace')
    expect(text(await execute('after-exit', 'printf "%s\\n" "$PWD"'))).toBe(root)
  }, 20_000)
})
