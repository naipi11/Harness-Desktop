/**
 * Node 22 startup-output smoke for the shipped Web CLI composition.
 *
 * Only the dedicated Node compatibility gate opts this test in after building
 * both artifacts; ordinary Vitest inventory deterministically skips it.
 * The child runs built artifacts under plain Node with the real shipped
 * web profile (dsh-base + dsh-web-app bundle patches, auto-initialized).
 * Its URL line follows the settled profile boot; SIGTERM then exercises the
 * shipped quiescent disposer.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
// Full-text session search ships off (`openAt: never` on both layers): the
// base patch carries the default, and the web restatement must not re-enable it.
const baseConfigPath = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const webConfigPath = join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')
const requireBuiltArtifacts = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'
type BuiltWebChild = ChildProcessByStdio<null, Readable, Readable>

interface ConfigRow {
  id?: string
  disabled?: unknown
  config?: { openAt?: unknown }
}

interface PatchEntry extends ConfigRow {
  insert?: ConfigRow[]
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => String(value),
})
const configSchema = yaml.JSON_SCHEMA.extend(jsExprType)

/** Observe settled startup and keep failure settlement behind child close. */
async function observeBuiltWebChild(
  child: BuiltWebChild,
  requestShutdown: () => Promise<void> | void,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolveRun, rejectRun) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let completed = false
    const closed = new Promise<number | null>((resolveClose) => {
      child.once('close', resolveClose)
    })
    const rejectAfterClose = (error: unknown): void => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      const failure = error instanceof Error ? error : new Error(String(error))
      void closed.then(() => { rejectRun(failure) })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!completed && !settled && /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout)) {
        settled = true
        void Promise.resolve().then(requestShutdown).catch(rejectAfterClose)
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      rejectAfterClose(new Error(`built Web CLI did not settle and dispose within ${timeoutMs / 1_000}s\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', rejectAfterClose)
    void closed.then((code) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      if (!settled) {
        rejectRun(new Error(`built Web CLI exited before settled startup (code ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolveRun({ stdout, stderr, code: code ?? -1 })
    })
  })
}

/** Boot the built Web CLI, wait for its settled URL, then dispose through SIGTERM. */
async function runBuiltWeb(cwd: string, harnessHome: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const profileDir = join(harnessHome, 'profiles', 'web')
  const shutdownMarker = join(profileDir, 'shutdown.marker')
  if (process.platform === 'win32') {
    await mkdir(profileDir, { recursive: true })
    await Promise.all([
      writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: cooperative-shutdown',
        "      name: './cooperative-shutdown.mjs'",
        '',
      ].join('\n')),
      writeFile(join(profileDir, 'cooperative-shutdown.mjs'), [
        "import { existsSync } from 'node:fs'",
        '',
        "export const name = 'cooperative-shutdown'",
        'export function apply(ctx) {',
        '  const timer = setInterval(() => {',
        "    if (!existsSync(new URL('./shutdown.marker', import.meta.url))) return",
        '    clearInterval(timer)',
        "    process.emit('SIGTERM')",
        '  }, 25)',
        "  ctx.effect(() => () => clearInterval(timer), 'cooperativeShutdown.interval()')",
        '}',
        '',
      ].join('\n')),
    ])
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: 'dsh-cli-smoke-dummy-key',
    HARNESS_HOME: harnessHome,
  }
  delete env.DEEPSEEK_BASE_URL
  delete env.NODE_OPTIONS
  delete env.NODE_NO_WARNINGS
  const child = spawn(process.execPath, [
    builtBin,
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return observeBuiltWebChild(child, process.platform === 'win32'
    ? async () => { await writeFile(shutdownMarker, '') }
    : () => { child.kill('SIGTERM') }, 60_000)
}

async function stopTestChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

describe('built Web child lifecycle', () => {
  it('awaits child close before rejecting a shutdown-marker write failure', async () => {
    const child = spawn(process.execPath, ['-e', [
      "process.stdout.write('dsh web: http://127.0.0.1:12345\\n')",
      'setInterval(() => {}, 1_000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let closed = false
    child.once('close', () => { closed = true })
    try {
      await expect(observeBuiltWebChild(child, async () => {
        throw new Error('shutdown marker write failed')
      }, 5_000)).rejects.toThrow('shutdown marker write failed')
      expect(closed).toBe(true)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      await stopTestChild(child)
    }
  })

  it('awaits child close before rejecting a startup timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let closed = false
    child.once('close', () => { closed = true })
    try {
      await expect(observeBuiltWebChild(child, () => {}, 50)).rejects.toThrow(
        'built Web CLI did not settle and dispose within 0.05s',
      )
      expect(closed).toBe(true)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      await stopTestChild(child)
    }
  })
})

describe.skipIf(!requireBuiltArtifacts)('built CLI lazy-search startup', () => {
  it('boots and disposes the shipped composition with full-text search off by default', async () => {
    expect(existsSync(builtBin), `missing built CLI ${resolve(builtBin)}; run pnpm build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build:web`).toBe(true)
    const baseRows = (yaml.load(await readFile(baseConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const webRows = (yaml.load(await readFile(webConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const baseRow = baseRows.find(row => row.id === 'session-query-sqlite')
    const webRow = webRows.find(row => row.id === 'session-query-sqlite')
    expect(baseRow?.config?.openAt).toBe('never')
    expect(baseRow?.disabled).toBeUndefined()
    // The web restatement keeps the shipped default; opting in is a later layer's override.
    expect(webRow?.config?.openAt).toBe('never')
    expect(webRow?.disabled).toBeUndefined()

    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cli-lazy-search-'))
    try {
      const harnessHome = join(cwd, 'observable-harness-home')
      const result = await runBuiltWeb(cwd, harnessHome)
      expect(existsSync(join(harnessHome, 'profiles', 'web', 'package.json'))).toBe(true)
      expect(result.stdout).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+/u)
      expect(result.code).toBe(0)
      expect(result.stderr).not.toMatch(/ExperimentalWarning: SQLite/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 70_000)
})
