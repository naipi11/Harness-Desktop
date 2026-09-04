/** Published plain-Node acceptance for the current Harness Desktop product grammar. */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const harnessBin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const dshBin = fileURLToPath(new URL('../lib/dsh-bin.js', import.meta.url))
const cliVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
let runtime: RuntimeProcess | undefined
let replayRoot: string | undefined

afterEach(async () => {
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
  if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
  replayRoot = undefined
})

async function runBuiltEntry(
  bin: string,
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    readonly input?: string
  } = {},
): Promise<{ stdout: string; code: number; stderr: string }> {
  const result = await execa(process.execPath, [bin, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    input: options.input ?? '',
    timeout: 45_000,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  if (result.timedOut) throw new Error(`built CLI timed out. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return { stdout: result.stdout, code: result.exitCode ?? -1, stderr: result.stderr }
}

function runtimeEnv(runtimeProcess: RuntimeProcess): NodeJS.ProcessEnv {
  return {
    HARNESS_HOME: runtimeProcess.harnessHome,
    DSH_HOME: runtimeProcess.legacyHome,
    HOME: runtimeProcess.platformHome,
    USERPROFILE: runtimeProcess.platformHome,
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
  }
}

async function startRuntimeWithReplay(entries: readonly object[]): Promise<RuntimeProcess> {
  replayRoot = await mkdtemp(join(tmpdir(), 'harness-built-product-replay-'))
  const override = join(replayRoot, 'replay.override.json')
  await writeFile(override, `${JSON.stringify(entries, undefined, 2)}\n`)
  const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
  const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
  process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${override}.missing`
  process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = override
  try {
    return await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
  } finally {
    if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
    if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
  }
}

describe.skipIf(!(await access(harnessBin).then(() => true, () => false))
  || !(await access(dshBin).then(() => true, () => false)))('CLI BUILT product bins (plain Node)', () => {
  it('keeps harness primary and dsh compatible across help and version', async () => {
    const [harnessHelp, dshHelp, harnessVersion, dshVersion] = await Promise.all([
      runBuiltEntry(harnessBin, ['--help']),
      runBuiltEntry(dshBin, ['--help']),
      runBuiltEntry(harnessBin, ['--version']),
      runBuiltEntry(dshBin, ['--version']),
    ])

    expect(harnessHelp).toMatchObject({ code: 0, stderr: '' })
    expect(harnessHelp.stdout).toContain('harness run "fix the tests" --json')
    expect(harnessHelp.stdout).toContain('harness web --background')
    expect(harnessHelp.stdout).not.toContain('--profile')
    expect(dshHelp).toMatchObject({ code: 0, stderr: '' })
    expect(dshHelp.stdout).toContain('dsh run "fix the tests" --json')
    expect(dshHelp.stdout).toContain('dsh web --background')
    expect(dshHelp.stdout).not.toContain('--profile')
    expect(harnessVersion).toEqual({ code: 0, stdout: `${cliVersion}\n`, stderr: '' })
    expect(dshVersion).toEqual(harnessVersion)
  }, 30_000)

  it('rejects removed profile, plugin, and Web config syntax', async () => {
    for (const args of [
      ['--profile', 'web'],
      ['--profile=web'],
      ['plugin', '--profile', 'demo', 'add', 'pkg'],
      ['web', '--patch', 'extra.yml'],
      ['web', '--port', '3080'],
    ]) {
      const result = await runBuiltEntry(harnessBin, args)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Use `harness [task]`')
    }
  }, 30_000)

  it('accepts only argument-free desktop syntax without Runtime startup', async () => {
    expect(await runBuiltEntry(harnessBin, ['desktop'])).toEqual({ code: 0, stdout: '', stderr: '' })
    const invalid = await runBuiltEntry(dshBin, ['desktop', 'extra'])
    expect(invalid.code).toBe(2)
    expect(invalid.stdout).toBe('')
    expect(invalid.stderr).toContain('desktop takes no arguments')
  })

  it('discovers Web status without creating a Runtime home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-built-status-'))
    const missingHome = join(root, 'missing-home')
    try {
      const status = await runBuiltEntry(dshBin, ['web', '--status'], {
        cwd: root,
        env: {
          HARNESS_HOME: missingHome,
          DSH_HOME: join(root, 'legacy'),
          HOME: root,
          USERPROFILE: root,
          DSH_TELEMETRY_DISABLED: '1',
        },
      })
      expect(status.code).toBe(3)
      expect(status.stdout).toBe('')
      expect(status.stderr).toContain('The local Harness Runtime is not running.')
      await expect(access(missingHome)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('retains and idempotently releases the named Web lease on one real Runtime', async () => {
    runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    await waitForEndpoint(runtime)
    const env = runtimeEnv(runtime)

    const acquired = await runBuiltEntry(harnessBin, ['web', '--background', '--no-open'], { cwd: runtime.cwd, env })
    expect(acquired).toEqual({ code: 0, stdout: 'Web lease: web present\n', stderr: '' })
    const status = await runBuiltEntry(dshBin, ['web', '--status'], { cwd: runtime.cwd, env })
    expect(status.code, status.stderr).toBe(0)
    expect(status.stdout).toContain('Runtime: running')
    expect(status.stdout).toContain('Web lease: web present')
    const stopped = await runBuiltEntry(dshBin, ['web', '--stop'], { cwd: runtime.cwd, env })
    const duplicate = await runBuiltEntry(harnessBin, ['web', '--stop'], { cwd: runtime.cwd, env })
    expect(stopped).toEqual({ code: 0, stdout: 'Web lease: web absent\n', stderr: '' })
    expect(duplicate).toEqual(stopped)

    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)

  it('runs JSONL and bare interactive modes through the shared Runtime', async () => {
    runtime = await startRuntimeWithReplay([{
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'BUILT_PRODUCT_OUTPUT' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'BUILT_PRODUCT_OUTPUT' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    }])
    await waitForEndpoint(runtime)
    const env = runtimeEnv(runtime)

    const run = await runBuiltEntry(harnessBin, ['run', 'built product task', '--json'], { cwd: runtime.cwd, env })
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).toBe('')
    const events = run.stdout.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as { kind: string; text?: string })
    expect(events[0]?.kind).toBe('session-opened')
    expect(events).toContainEqual({ kind: 'output', text: 'BUILT_PRODUCT_OUTPUT' })

    const interactive = await runBuiltEntry(dshBin, [], { cwd: runtime.cwd, env, input: '/exit\r' })
    expect(interactive.code, interactive.stderr).toBe(0)

    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)
})
