/** Runtime Web attachment, browser handoff, and named-lease orchestration. */

import type { Writable } from 'node:stream'
import {
  normalizeRecoveryDiagnostic,
  RuntimeUnavailableError,
  type BrowserHandoffTransport,
  type DashboardAttachment,
  type RuntimeClient,
  type RuntimeConnector,
  type RuntimeLeaseStatus,
  type RuntimeStatus,
} from '@harness-desktop/dsh-host-local-runtime'
import type { WebInvocation } from './args.ts'

/** Output channels owned by one Web CLI invocation. */
export interface WebIO {
  /** Public status and lease acknowledgements. */
  readonly stdout: Writable
  /** Redacted recovery diagnostics. */
  readonly stderr: Writable
}

/**
 * Connect one Web command to the shared Runtime without taking process or storage ownership.
 * @param invocation - parsed open, status, stop, and lease intent.
 * @param connector - token-encapsulating Runtime connector.
 * @param opener - launcher-owned one-time browser transport.
 * @param io - explicit public-output channels.
 * @returns the public CLI exit code.
 */
export async function runWebInvocation(
  invocation: WebInvocation,
  connector: RuntimeConnector,
  opener: BrowserHandoffTransport,
  io: WebIO,
): Promise<number> {
  let client: RuntimeClient | undefined
  let dashboard: DashboardAttachment | undefined
  let failure: unknown
  try {
    client = await connector.connect({ start: invocation.operation === 'open' })
    switch (invocation.operation) {
      case 'status':
        writeStatus(io.stdout, await client.status())
        break
      case 'stop':
        writeLease(io.stdout, await client.releaseBackgroundLease())
        break
      case 'open':
        if (invocation.lease === 'background') {
          const lease = await client.acquireBackgroundLease()
          writeLease(io.stdout, { id: lease.id, state: 'present' })
        }
        if (invocation.open) {
          dashboard = await client.attachDashboard()
          const navigation = await dashboard.createBrowserHandoff()
          await opener.open(navigation)
        }
        break
      default:
        invocation.operation satisfies never
    }
  } catch (error) {
    failure = error
  }

  const cleanupErrors: unknown[] = []
  if (dashboard !== undefined) {
    try {
      await dashboard.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (client !== undefined) {
    try {
      await client.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (failure === undefined && cleanupErrors.length === 1) failure = cleanupErrors[0]
  if (failure === undefined && cleanupErrors.length > 1) {
    failure = new AggregateError(cleanupErrors, 'Web attachments failed to close')
  } else if (failure !== undefined && cleanupErrors.length > 0) {
    failure = new AggregateError([failure, ...cleanupErrors], 'Web operation and attachment cleanup both failed')
  }
  if (failure === undefined) return 0
  writeDiagnostic(io.stderr, failure)
  return failure instanceof RuntimeUnavailableError ? 3 : 5
}

function writeStatus(stdout: Writable, status: RuntimeStatus): void {
  stdout.write(
    `Runtime: ${status.state} (${status.runtimeId})\n`
    + `Dashboard: ${status.dashboardOrigin}\n`
    + `Web lease: ${status.backgroundLease.id} ${status.backgroundLease.state}\n`,
  )
}

function writeLease(stdout: Writable, lease: RuntimeLeaseStatus): void {
  stdout.write(`Web lease: ${lease.id} ${lease.state}\n`)
}

function writeDiagnostic(stderr: Writable, error: unknown): void {
  const diagnostic = normalizeRecoveryDiagnostic(error)
  stderr.write(`${diagnostic.message}\n${diagnostic.correction}\nDiagnostic: ${diagnostic.diagnosticId}\n`)
}
