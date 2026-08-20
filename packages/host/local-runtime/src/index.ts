/** Public data-root, process identity, ownership, and redacted status API. */

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

export type { RedactedRuntimeStatus, RuntimeId } from './endpoint-record.ts'
