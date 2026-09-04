import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

/**
 * Source-path Loader smoke through the package's own bin, covering the
 * automation server's initialize and fresh-session path across the
 * `unwrapExports` shape implicated by postmortem 0001. Session creation reaches
 * the factory but not the model, so a dummy key is sufficient.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')
// Repo root is four levels up from packages/examples/acp-demo/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const shippedConfig = fileURLToPath(new URL('../../../../examples/acp-agent/cordis.yml', import.meta.url))

// A minimal opt-in leaf that loads this app + the two backends and the optional
// session-query consumer/policies, inlined so the package test owns its fixture.
const CORDIS_YML = `
- id: llm-deepseek
  name: '@harness-desktop/dsh-llm-deepseek'
- id: subprocess
  name: '@harness-desktop/dsh-subprocess-local'
- id: bash
  name: '@harness-desktop/dsh-bash-local'
- id: acp-agent
  name: '@harness-desktop/dsh-acp-demo'
  config:
    harnessHome: !!js harnessHome
    provider: deepseek-official
    model: deepseek-v4-flash
    persona: 'You are a test agent.'
    persistenceRoot: !!js harnessHomePath('sessions')
    workspaceContext: false
- id: tool-session-query
  name: '@harness-desktop/dsh-tool-session-query'
- id: timeout-policy
  name: '@harness-desktop/dsh-tool-call-timeout-policy'
- id: spill-local
  name: '@harness-desktop/dsh-spill-local'
- id: spill-policy
  name: '@harness-desktop/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
`

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  stderr: string[]
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined) {
    const child = spawned.child
    spawned = undefined
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      child.kill('SIGKILL')
      await exited
    }
  }
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  workdir = undefined
})

interface BootOptions {
  readonly configPath?: string
  readonly platformDefaultHome?: boolean
  readonly observeShippedHome?: boolean
}

function platformDefaultEnvironment(cwd: string): { env: NodeJS.ProcessEnv; harnessHome: string } {
  const userHome = join(cwd, 'user-home')
  const localAppData = join(cwd, 'local-app-data')
  const xdgDataHome = join(cwd, 'xdg-data')
  return {
    env: {
      HOME: userHome,
      USERPROFILE: userHome,
      LOCALAPPDATA: localAppData,
      XDG_DATA_HOME: xdgDataHome,
    },
    harnessHome: process.platform === 'win32'
      ? join(localAppData, 'Harness Desktop')
      : process.platform === 'darwin'
        ? join(userHome, 'Library', 'Application Support', 'Harness Desktop')
        : join(xdgDataHome, 'harness-desktop'),
  }
}

async function boot(options: BootOptions = {}): Promise<Spawned & { cwd: string; harnessHome: string; witnessFile: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-agent-pkg-'))
  const cwd = workdir
  const localConfig = join(cwd, 'cordis.yml')
  let configPath = options.configPath ?? localConfig
  const witnessFile = join(cwd, 'harness-home-witness')
  if (options.observeShippedHome) {
    const witnessModule = join(cwd, 'home-witness.mjs')
    await writeFile(witnessModule, [
      "import { writeFileSync } from 'node:fs'",
      "export const name = 'acp-home-witness'",
      "export const inject = ['shellEnv']",
      'export function apply(ctx) { writeFileSync(process.env.ACP_HOME_WITNESS, ctx.shellEnv.collect({}).HARNESS_HOME) }',
      '',
    ].join('\n'))
    await writeFile(localConfig, [
      '- id: shipped',
      "  name: '@harness-desktop/cordis-plugin-include'",
      '  config:',
      `    path: ${pathToFileURL(shippedConfig).href}`,
      '    patches:',
      '      - insert:',
      '          - id: acp-home-witness',
      `            name: ${pathToFileURL(witnessModule).href}`,
      '',
    ].join('\n'))
    configPath = localConfig
  } else if (options.configPath === undefined) {
    await writeFile(configPath, CORDIS_YML)
  }
  const defaults = platformDefaultEnvironment(cwd)
  const harnessHome = options.platformDefaultHome ? defaults.harnessHome : join(cwd, '.harness-home')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TSX_TSCONFIG_PATH: repoTsconfig,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-acp-agent-smoke',
    DSH_AGENTS_HOME: join(cwd, '.agents'),
    ACP_HOME_WITNESS: witnessFile,
    ...options.platformDefaultHome ? defaults.env : { HARNESS_HOME: harnessHome },
  }
  if (options.platformDefaultHome) {
    delete env.HARNESS_HOME
    delete env.DSH_HOME
  }
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(_params: SessionNotification): Promise<void> {
      return Promise.resolve()
    },
    requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  spawned = { child, client, stderr }
  return { ...spawned, cwd, harnessHome, witnessFile }
}

describe('dsh-acp-demo real-load-path smoke (bin + Loader, keyless)', () => {
  it('boots via its bin and exposes only fresh text sessions', async () => {
    const { client, cwd, stderr } = await boot()
    // initialize: a broken export shape (collapsed bridge plugin, dropped inject)
    // crashes the tree on the first service read here — see postmortem 0001.
    const init = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }).catch((cause: unknown) => {
      throw new Error(`ACP initialize failed; agent stderr:\n${stderr.join('')}`, { cause })
    })
    expect(init.agentCapabilities).toEqual({
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    })

    // session/new reaches the agent FACTORY (create) without the model.
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()

    expect(stderr.join('')).not.toContain('without inject')
  }, 30_000)

  it('uses the Loader-resolved platform default when HARNESS_HOME is absent', async () => {
    const { client, harnessHome, stderr, witnessFile } = await boot({
      platformDefaultHome: true,
      observeShippedHome: true,
    })
    const init = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }).catch((cause: unknown) => {
      throw new Error(`ACP initialize failed; agent stderr:\n${stderr.join('')}`, { cause })
    })
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false)
    await expect.poll(async () => await readFile(witnessFile, 'utf8')).toBe(harnessHome)
  }, 30_000)
})
