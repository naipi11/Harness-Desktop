/** Real source/built CLI processes attaching to one shared Runtime owner. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@harness-desktop/dsh-loader-smoke'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliSource = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const cliBuilt = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
let runtime: RuntimeProcess | undefined
let replayRoot: string | undefined

afterEach(async () => {
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
  if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
  replayRoot = undefined
})

function success(text: string): object {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

async function startRuntimeWithReplay(entries: readonly object[]): Promise<RuntimeProcess> {
  replayRoot = await mkdtemp(join(tmpdir(), 'harness-cli-runtime-replay-'))
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

async function runCli(runtimeProcess: RuntimeProcess, task: string) {
  const launch = resolveExampleLaunch({
    srcBin: cliSource,
    libBin: cliBuilt,
    mode: resolveExampleMode(),
    tsconfigPath: repoTsconfig,
    configArgs: ['run', task, '--json'],
  })
  const result = await execa(launch.command, launch.args, {
    cwd: runtimeProcess.cwd,
    reject: false,
    timeout: 45_000,
    killSignal: 'SIGKILL',
    stripFinalNewline: false,
    env: {
      ...process.env,
      ...launch.env,
      HARNESS_HOME: runtimeProcess.harnessHome,
      DSH_HOME: runtimeProcess.legacyHome,
      HOME: runtimeProcess.platformHome,
      USERPROFILE: runtimeProcess.platformHome,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    },
  })
  if (result.timedOut) throw new Error(`CLI task timed out. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

async function runInteractiveCli(runtimeProcess: RuntimeProcess) {
  const launch = resolveExampleLaunch({
    srcBin: cliSource,
    libBin: cliBuilt,
    mode: resolveExampleMode(),
    tsconfigPath: repoTsconfig,
  })
  return execa(launch.command, launch.args, {
    cwd: runtimeProcess.cwd,
    reject: false,
    timeout: 45_000,
    killSignal: 'SIGKILL',
    input: '/exit\r',
    env: {
      ...process.env,
      ...launch.env,
      HARNESS_HOME: runtimeProcess.harnessHome,
      DSH_HOME: runtimeProcess.legacyHome,
      HOME: runtimeProcess.platformHome,
      USERPROFILE: runtimeProcess.platformHome,
      DSH_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    },
  })
}

describe('Runtime terminal client real entry', () => {
  it('keeps two JSONL task processes on one Runtime owner and emits protocol records only', async () => {
    runtime = await startRuntimeWithReplay([success('FIRST_RUNTIME_OUTPUT')])
    const endpoint = await waitForEndpoint(runtime)
    const recordPath = join(runtime.harnessHome, 'runtime-endpoint.json')
    const before = JSON.parse(await readFile(recordPath, 'utf8')) as { runtimeId: string; port: number }

    const first = await runCli(runtime, 'first shared Runtime task')
    const second = await runInteractiveCli(runtime)
    const after = JSON.parse(await readFile(recordPath, 'utf8')) as { runtimeId: string; port: number }

    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stderr).toBe('')
    const lines = first.stdout.split(/\r?\n/u).filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const events = lines.map(line => JSON.parse(line) as { kind: string; text?: string })
    expect(events[0]?.kind).toBe('session-opened')
    expect(events, `Runtime stderr:\n${runtime.stderr()}\nCLI stderr:\n${first.stderr}`)
      .toContainEqual({ kind: 'output', text: 'FIRST_RUNTIME_OUTPUT' })
    expect(second.exitCode, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    expect(second.stderr).toBe('')
    expect(after).toEqual(before)
    expect(endpoint.port).toBe(before.port)

    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
    runtime = undefined
  }, 120_000)
})
