/** Public data-root, process identity, and token-encapsulating Runtime client API. */

export {
  createLocalRuntimePlugin,
  defaultHarnessHome,
  HARNESS_HOME_ENV,
  resolveHarnessHome,
  type HarnessHome,
  type HarnessHomeInput,
  type HarnessHomeProvider,
  type HarnessHomeResolution,
} from './data-root.ts'

export {
  acquireRuntimeLock,
  type RuntimeLock,
  type RuntimeLockResult,
} from './instance-lock.ts'

export type { ProcessIdentity } from './process-identity.ts'

export type { RedactedRuntimeStatus } from './endpoint-record.ts'

export {
  createRuntimeConnector,
  normalizeRecoveryDiagnostic,
  RuntimeBusyError,
  RuntimeProtocolError,
  RuntimeUnavailableError,
  type ActiveWorkId,
  type ActiveWorkStatus,
  type ApprovalId,
  type BackgroundLeaseId,
  type BrowserHandoff,
  type BrowserHandoffId,
  type BrowserHandoffTransport,
  type DashboardAttachment,
  type DashboardControlRequest,
  type DashboardNavigation,
  type DashboardOrigin,
  type LegacyMigrationState,
  type OwnUiWorkStopResult,
  type RedactedRuntimeDiagnostic,
  type RuntimeClient,
  type RuntimeClientId,
  type RuntimeConnector,
  type RuntimeConnectorOptions,
  type RuntimeControlRequest,
  type RuntimeControlResult,
  type RuntimeDiagnosticId,
  type RuntimeId,
  type RuntimeLease,
  type RuntimeLeaseStatus,
  type RuntimeRecoveryCode,
  type RuntimeStatus,
  type SessionId,
  type TerminalConnection,
  type TerminalControlCommand,
  type TerminalInput,
  type TerminalOpenRequest,
  type TerminalProtocolEvent,
} from './runtime-client.ts'
