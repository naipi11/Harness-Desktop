/** Runtime-only terminal attachment lifecycle for the product CLI. */

import type {
  LegacyMigrationState,
  RuntimeClient,
  RuntimeConnector,
  TerminalConnection,
  TerminalOpenRequest,
} from '@harness-desktop/dsh-host-local-runtime'

/** One CLI-owned Runtime client whose child terminal attachments release independently. */
export interface TerminalRuntimeClient {
  /** @returns the Runtime's durable legacy-migration state. */
  getLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable state after the user's explicit import choice. */
  acceptLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable state after the user's explicit decline choice. */
  declineLegacyMigration(): Promise<LegacyMigrationState>
  /** @returns the durable state after the user's explicit retry choice. */
  retryLegacyMigration(): Promise<LegacyMigrationState>
  /** @param request - workspace, optional initial task, and optional resumed session. @returns an independent terminal attachment. */
  openTerminal(request: TerminalOpenRequest): Promise<TerminalConnection>
  /** @returns active work owned by this CLI attachment only. */
  observeActiveWork(): ReturnType<RuntimeClient['observeActiveWork']>
  /** Release only this CLI's base Runtime attachment. */
  close(): Promise<void>
}

/**
 * Attach one product CLI client to the shared Runtime without exposing its
 * endpoint, data root, persistence, or credential providers.
 * @param connector - token-encapsulating Runtime connector.
 * @returns the independently releasable terminal client attachment.
 */
export async function connectTerminalRuntime(connector: RuntimeConnector): Promise<TerminalRuntimeClient> {
  const client = await connector.connect({ start: true })
  return {
    getLegacyMigration: () => client.getLegacyMigration(),
    acceptLegacyMigration: () => client.acceptLegacyMigration(),
    declineLegacyMigration: () => client.declineLegacyMigration(),
    retryLegacyMigration: () => client.retryLegacyMigration(),
    openTerminal: request => client.openTerminal(request),
    observeActiveWork: () => client.observeActiveWork(),
    close: () => client.close(),
  }
}
