/** Private Runtime endpoint persistence and token-free status projection. */

import { randomBytes } from 'node:crypto'
import { link, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Branded } from '@harness-desktop/dsh-brand'
import type { HarnessHome } from './data-root.ts'
import {
  runtimePrivatePathPolicy,
  type PrivatePathEvidence,
  type PrivatePathPolicy,
} from './instance-lock.ts'
import type { ProcessIdentity } from './process-identity.ts'

/** Opaque identity of one Runtime lifetime. */
export type RuntimeId = Branded<'RuntimeId'>

/** Private control-plane endpoint document; never exported by the package root. */
export interface PrivateEndpointRecord {
  readonly protocolVersion: 1
  readonly runtimeId: RuntimeId
  readonly port: number
  readonly process: ProcessIdentity
  readonly accessToken: string
}

/** Token-free state safe for application diagnostics and status output. */
export interface RedactedRuntimeStatus {
  readonly state: 'running' | 'stopping'
  readonly runtimeId: RuntimeId
  readonly port: number
  readonly backgroundLeaseCount: number
}

/** Private endpoint document beneath `HARNESS_HOME`. */
export const RUNTIME_ENDPOINT_FILENAME = 'runtime-endpoint.json'

/** Injectable path policy for private endpoint reads and writes. */
export interface PrivateEndpointRecordOptions {
  readonly privatePathPolicy?: PrivatePathPolicy
}

/**
 * Atomically replace the private endpoint document. The unpublished temp file
 * receives and verifies current-user-only access before its same-directory rename.
 * @param home - resolved Harness data root.
 * @param record - complete token-bearing control-plane record.
 * @param options - injectable platform path policy.
 * @returns verified permissions on the published endpoint file.
 */
export async function writePrivateEndpointRecord(
  home: HarnessHome,
  record: PrivateEndpointRecord,
  options: PrivateEndpointRecordOptions = {},
): Promise<PrivatePathEvidence> {
  const policy = options.privatePathPolicy ?? runtimePrivatePathPolicy
  const path = join(home, RUNTIME_ENDPOINT_FILENAME)
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await policy.protectDirectory(home)
  try {
    await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
    await policy.protectFile(temporary)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return policy.verifyFile(path)
}

/**
 * Read and validate the Runtime-private endpoint document for internal attachment.
 * @param home - resolved Harness data root.
 * @param options - injectable platform path policy.
 * @returns the complete private record after its permissions are verified.
 */
export async function readPrivateEndpointRecord(
  home: HarnessHome,
  options: PrivateEndpointRecordOptions = {},
): Promise<PrivateEndpointRecord> {
  const path = join(home, RUNTIME_ENDPOINT_FILENAME)
  await lstat(path)
  await (options.privatePathPolicy ?? runtimePrivatePathPolicy).verifyFile(path)
  return parsePrivateEndpointRecord(await readFile(path, 'utf8'))
}

/**
 * Remove the endpoint published by one Runtime identity without deleting a replacement.
 * @param home - resolved Harness data root.
 * @param runtimeId - identity allowed to remove the current record.
 */
export async function removePrivateEndpointRecord(home: HarnessHome, runtimeId: RuntimeId): Promise<void> {
  const path = join(home, RUNTIME_ENDPOINT_FILENAME)
  let record: PrivateEndpointRecord
  try {
    record = await readPrivateEndpointRecord(home)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (record.runtimeId !== runtimeId) throw new Error('host-local-runtime: endpoint ownership changed before removal')
  const retiredPath = `${path}.${randomBytes(8).toString('hex')}.retiring`
  try {
    await rename(path, retiredPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  let retiredRecord: PrivateEndpointRecord
  try {
    await runtimePrivatePathPolicy.verifyFile(retiredPath)
    retiredRecord = parsePrivateEndpointRecord(await readFile(retiredPath, 'utf8'))
  } catch (error) {
    await restoreRetiredEndpoint(retiredPath, path, error)
    throw error
  }
  if (retiredRecord.runtimeId !== runtimeId) {
    const ownershipError = new Error('host-local-runtime: endpoint ownership changed before removal')
    await restoreRetiredEndpoint(retiredPath, path, ownershipError)
    throw ownershipError
  }
  await rm(retiredPath)
}

/** Restore a claimed replacement unless a still newer endpoint already exists. */
async function restoreRetiredEndpoint(retiredPath: string, path: string, cause: unknown): Promise<void> {
  try {
    await link(retiredPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new AggregateError([cause, error], 'host-local-runtime: endpoint retirement and replacement restoration both failed')
    }
  }
  try {
    await rm(retiredPath)
  } catch (error) {
    throw new AggregateError([cause, error], 'host-local-runtime: endpoint replacement restored but tombstone cleanup failed')
  }
}

/**
 * Derive the only application-visible Runtime status from a private record.
 * @param record - private endpoint identity and port.
 * @param state - current Runtime lifecycle state.
 * @param backgroundLeaseCount - active explicit background leases.
 * @returns a token-free status object.
 */
export function redactRuntimeStatus(
  record: PrivateEndpointRecord,
  state: RedactedRuntimeStatus['state'],
  backgroundLeaseCount: number,
): RedactedRuntimeStatus {
  return {
    state,
    runtimeId: record.runtimeId,
    port: record.port,
    backgroundLeaseCount,
  }
}

/** Validate the exact version-1 endpoint fields without echoing the document. */
function parsePrivateEndpointRecord(text: string): PrivateEndpointRecord {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('host-local-runtime: endpoint record must contain an object')
  }
  const record = value as Record<string, unknown>
  const processValue = record.process
  if (record.protocolVersion !== 1
    || typeof record.runtimeId !== 'string' || record.runtimeId.length === 0
    || !Number.isSafeInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65_535
    || typeof record.accessToken !== 'string' || record.accessToken.length === 0
    || typeof processValue !== 'object' || processValue === null || Array.isArray(processValue)) {
    throw new Error('host-local-runtime: endpoint record contains invalid version-1 fields')
  }
  const processRecord = processValue as Record<string, unknown>
  if (!Number.isSafeInteger(processRecord.pid) || (processRecord.pid as number) <= 0
    || typeof processRecord.startedAt !== 'string' || processRecord.startedAt.length === 0) {
    throw new Error('host-local-runtime: endpoint record contains an invalid process identity')
  }
  return {
    protocolVersion: 1,
    runtimeId: record.runtimeId as RuntimeId,
    port: record.port as number,
    process: { pid: processRecord.pid as number, startedAt: processRecord.startedAt },
    accessToken: record.accessToken,
  }
}
