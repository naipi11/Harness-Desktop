/** Keyless real-entry JSONL transcript for the product Runtime terminal client. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExampleLaunch, resolveExampleMode } from '@harness-desktop/dsh-loader-smoke'
import {
  cleanupRuntimeProcess,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from '../../../packages/host/local-runtime/tests/runtime-process-harness.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliSource = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const cliBuilt = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
let runtime: RuntimeProcess | undefined
let replayRoot: string | undefined

afterEach(async () => {
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
  if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
  replayRoot = undefined
})

describe('terminal Runtime transcript', () => {
  it('snapshots newline-delimited protocol output through the real CLI entry', async () => {
    replayRoot = await mkdtemp(join(tmpdir(), 'harness-cli-snapshot-replay-'))
    const override = join(replayRoot, 'replay.override.json')
    await writeFile(override, `${JSON.stringify([{
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'SNAPSHOT_RUNTIME_OUTPUT' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'SNAPSHOT_RUNTIME_OUTPUT' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    }], undefined, 2)}\n`)
    const previousFile = process.env.DSH_RUNTIME_TEST_REPLAY_FILE
    const previousOverride = process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
    process.env.DSH_RUNTIME_TEST_REPLAY_FILE = `${override}.missing`
    process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = override
    try {
      runtime = await startRuntimeProcess({ mode: 'src', entry: 'source-backend-fixture', denyWorkspaceLib: true })
    } finally {
      if (previousFile === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_FILE
      else process.env.DSH_RUNTIME_TEST_REPLAY_FILE = previousFile
      if (previousOverride === undefined) delete process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE
      else process.env.DSH_RUNTIME_TEST_REPLAY_OVERRIDE = previousOverride
    }
    await waitForEndpoint(runtime)
    const launch = resolveExampleLaunch({
      srcBin: cliSource,
      libBin: cliBuilt,
      mode: resolveExampleMode(),
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: ['run', 'snapshot Runtime JSONL', '--json'],
    })
    const result = await execa(launch.command, launch.args, {
      cwd: runtime.cwd,
      reject: false,
      timeout: 45_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        ...launch.env,
        HARNESS_HOME: runtime.harnessHome,
        DSH_HOME: runtime.legacyHome,
        HOME: runtime.platformHome,
        USERPROFILE: runtime.platformHome,
        FORCE_COLOR: '0',
      },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const transcript = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
      const event = JSON.parse(line) as { kind: string; sessionId?: string }
      return event.kind === 'session-opened' ? { ...event, sessionId: '<session-id>' } : event
    })

    expect(transcript).toMatchInlineSnapshot(`
      [
        {
          "kind": "session-opened",
          "sessionId": "<session-id>",
        },
        {
          "kind": "model-changed",
          "model": "deepseek-v4-flash",
        },
        {
          "kind": "output",
          "text": "SNAPSHOT_RUNTIME_OUTPUT",
        },
      ]
    `)
  }, 120_000)
})
