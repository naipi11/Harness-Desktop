/** Private request envelope and readiness marker rules for detached native rollback workers. */

import {
  nativeRollbackReadyPath,
  parseNativeRollbackPlan,
  parseNativeUpdateWatchPlan,
  type NativeRollbackPlan,
  type NativeUpdateWatchPlan,
} from './native-rollback.ts'

/** One authenticated local rollback request plus the marker that confirms worker readiness. */
export interface NativeRollbackWorkerRequest {
  /** Fixed private envelope grammar version. */
  readonly schemaVersion: 1
  /** Unpredictable worker identity written to the matching readiness marker. */
  readonly workerId: string
  /** Exact cache-local marker path derived from the verified rollback artifact. */
  readonly readyPath: string
  /** Fixed local rollback or watchdog operation with no release URL. */
  readonly plan: NativeRollbackPlan | NativeUpdateWatchPlan
}

/**
 * Build one worker envelope after Main has already authenticated every release byte.
 * @param plan - fixed rollback or watchdog operation.
 * @param workerId - unguessable worker identity reserved by Main.
 * @returns request with the only allowed readiness-marker location.
 */
export function createNativeRollbackWorkerRequest(
  plan: NativeRollbackPlan | NativeUpdateWatchPlan,
  workerId: string,
): NativeRollbackWorkerRequest {
  if (!isUuid(workerId)) throw new Error('native rollback worker identity is invalid')
  return {
    schemaVersion: 1,
    workerId,
    readyPath: nativeRollbackReadyPath(plan.rollbackArtifactPath, workerId, plan.platform),
    plan,
  }
}

/**
 * Parse one untrusted detached-worker argument before it may read, write, or execute any local path.
 * @param value - decoded JSON argument.
 * @returns fixed worker request, or undefined when its exact grammar is not satisfied.
 */
export function parseNativeRollbackWorkerRequest(value: unknown): NativeRollbackWorkerRequest | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'workerId', 'readyPath', 'plan'])
    || value.schemaVersion !== 1 || !isUuid(value.workerId) || typeof value.readyPath !== 'string') {
    return undefined
  }
  const watch = parseNativeUpdateWatchPlan(value.plan)
  const plan = watch ?? parseNativeRollbackPlan(value.plan)
  if (
    plan === undefined
    || value.readyPath !== nativeRollbackReadyPath(plan.rollbackArtifactPath, value.workerId, plan.platform)
  ) return undefined
  return { schemaVersion: 1, workerId: value.workerId, readyPath: value.readyPath, plan }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
