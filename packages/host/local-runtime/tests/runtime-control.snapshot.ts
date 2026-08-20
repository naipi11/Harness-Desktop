/** Keyless real-process transcript for redacted Runtime status and busy recovery. */

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  RuntimeBusyError,
  type RuntimeClient,
  type TerminalConnection,
} from '../src/runtime-client.ts'
import type { SessionId } from '../src/index.ts'
import {
  cleanupRuntimeProcess,
  releaseRuntime,
  startRuntimeProcess,
  waitForEndpoint,
  type RuntimeProcess,
} from './runtime-process-harness.ts'

let runtime: RuntimeProcess | undefined
let firstClient: RuntimeClient | undefined
let secondClient: RuntimeClient | undefined
let firstTerminal: TerminalConnection | undefined

afterEach(async () => {
  await firstTerminal?.cancel()
  await firstTerminal?.close()
  firstTerminal = undefined
  await firstClient?.close()
  firstClient = undefined
  await secondClient?.close()
  secondClient = undefined
  await cleanupRuntimeProcess(runtime)
  runtime = undefined
})

describe('Runtime control transcript', () => {
  it('shows status and same-session recovery without private endpoint values', async () => {
    runtime = await startRuntimeProcess({ mode: 'src' })
    const endpoint = await waitForEndpoint(runtime)
    const connector = createRuntimeConnector({
      input: { env: { HARNESS_HOME: runtime.harnessHome }, homeDir: runtime.platformHome },
    })
    firstClient = await connector.connect({ start: false })
    secondClient = await connector.connect({ start: false })
    const sessionId = 'snapshot-shared-session' as SessionId
    firstTerminal = await firstClient.openTerminal({
      workspace: join(runtime.cwd, 'workspace'),
      sessionId,
      initialTask: 'hold the write admission',
    })
    let busy: unknown
    try {
      await secondClient.openTerminal({
        workspace: join(runtime.cwd, 'workspace'),
        sessionId,
        initialTask: 'race the existing writer',
      })
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBusyError)
      busy = normalizeRecoveryDiagnostic(error)
    }
    const status = await firstClient.status()
    const transcript = {
      status: {
        state: status.state,
        runtimeId: '<runtime-id>',
        dashboardOrigin: status.dashboardOrigin.replace(/:\d+$/, ':<port>'),
        backgroundLease: status.backgroundLease,
      },
      busy: busy === undefined ? undefined : { ...busy as object, diagnosticId: '<diagnostic-id>' },
    }

    expect(JSON.stringify(transcript)).not.toContain(endpoint.accessToken)
    expect(JSON.stringify(transcript)).not.toContain(runtime.harnessHome)
    expect(transcript).toMatchInlineSnapshot(`
      {
        "busy": {
          "code": "runtime-unavailable",
          "correction": "Observe the active session, open a new session, or wait for the current operation to finish.",
          "diagnosticId": "<diagnostic-id>",
          "message": "Another client is already writing this session.",
          "subject": "Runtime",
        },
        "status": {
          "backgroundLease": {
            "id": "web",
            "state": "absent",
          },
          "dashboardOrigin": "http://127.0.0.1:<port>",
          "runtimeId": "<runtime-id>",
          "state": "running",
        },
      }
    `)

    await firstTerminal.cancel()
    await firstTerminal.close()
    firstTerminal = undefined
    await firstClient.close()
    firstClient = undefined
    await secondClient.close()
    secondClient = undefined
    expect((await releaseRuntime(runtime)).exitCode).toBe(0)
  }, 120_000)
})
