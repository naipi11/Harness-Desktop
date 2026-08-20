/**
 * Safe one-way legacy-import boundary for the Harness Desktop local Runtime.
 *
 * `DSH_HOME` is a read-only migration candidate: the Runtime never writes to
 * it, never deletes it, and copies only the supported non-secret roots into an
 * empty `HARNESS_HOME` target through a staging sibling followed by atomic
 * per-root moves. `.credentials.yaml` and `.env` are never candidates, so a
 * seeded legacy credentials document cannot move into the target. The Runtime
 * stores the pending/declined/imported/result state under `HARNESS_HOME` and
 * never chooses for the user.
 * @module @harness-desktop/dsh-host-local-runtime/legacy-import
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, rename, rm, cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@harness-desktop/dsh-atomic-write'
import type { Branded } from '@harness-desktop/dsh-brand'
import type { HarnessHome, HarnessHomeResolution } from './data-root.ts'
export type { HarnessHome, HarnessHomeResolution } from './data-root.ts'

/** Stable diagnostic id a client can render without parsing text. */
export type RuntimeDiagnosticId = Branded<'RuntimeDiagnosticId'>

/** Supported legacy roots, in copy order; `.credentials.yaml` is never a candidate. */
export const LEGACY_IMPORT_ROOTS = ['sessions', 'settings.yaml', 'projects'] as const

/** Runtime-owned migration state filename beneath the target home. */
export const LEGACY_MIGRATION_FILENAME = 'legacy-migration.json'
/** Maximum encoded bytes accepted from the Runtime-owned migration state file. */
export const MAX_LEGACY_MIGRATION_STATE_BYTES = 65_536

/** Filesystem operations the importer uses; tests may inject a partial real spread. */
export interface LegacyImportFs {
  cp: typeof cp
  mkdir: typeof mkdir
  mkdtemp: typeof mkdtemp
  readdir: typeof readdir
  rename: typeof rename
  rm: typeof rm
}

/**
 * One import request. `retained` lists roots already moved into the target by
 * a previous attempt that must not be reported as copied again.
 */
export interface LegacyImportRequest {
  /** Absolute legacy `DSH_HOME` read-only source. */
  source: string
  /** Absolute `HARNESS_HOME` target that must be empty of anything else. */
  target: HarnessHome
  /** Optional injected filesystem operations. */
  fs?: LegacyImportFs
  /** Roots already present from a previous partial attempt. */
  retained?: readonly string[]
}

/** Typed import result so callers can render a safe correction without parsing text. */
export type LegacyImportResult =
  | { readonly kind: 'imported'; readonly copied: readonly string[]; readonly source: string; readonly target: HarnessHome }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'target-not-empty'; readonly target: HarnessHome }
  | { readonly kind: 'failed'; readonly source: string; readonly target: HarnessHome; readonly retained: readonly string[]; readonly diagnosticId: RuntimeDiagnosticId }

/** Migration state the Runtime exposes to clients. */
export type LegacyMigrationState =
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'decision-required'; readonly sourceLabel: 'DSH_HOME'; readonly retryable: false }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly copied: readonly string[] }
  | { readonly kind: 'target-not-empty'; readonly retryable: true; readonly diagnosticId: RuntimeDiagnosticId; readonly retained: readonly string[] }
  | { readonly kind: 'failed'; readonly retained: readonly string[]; readonly retryable: true; readonly diagnosticId: RuntimeDiagnosticId }

const fsPromises: LegacyImportFs = { cp, mkdir, mkdtemp, readdir, rename, rm }
const RUNTIME_CONTROL_FILES = new Set([LEGACY_MIGRATION_FILENAME, 'runtime.lock', 'runtime-endpoint.json'])

/** Whether an error means absence; every other failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Copy the supported non-secret roots from `source` into an empty `target`.
 * Each root is copied into a staging sibling first, then moved into the target
 * in one rename, so a reader never observes a partial root. The source and the
 * target are never deleted; on failure the staging directory is removed, the
 * source stays untouched, and the target retains only fully moved roots so an
 * accepted import can retry. Setup and copy failures use the same typed result.
 * @param request - source, target, and optional injected filesystem.
 * @returns the typed result.
 */
export async function importLegacyDshHome(request: LegacyImportRequest): Promise<LegacyImportResult> {
  const fs = request.fs ?? fsPromises
  const source = request.source
  const target = request.target
  const moved: string[] = []
  let staging: string | undefined

  try {
    const sourceEntries = await safeReaddir(source, fs)
    const supported = LEGACY_IMPORT_ROOTS.filter(root => sourceEntries.has(root))
    if (supported.length === 0) return { kind: 'not-found' }

    const targetEntries = await safeReaddir(target, fs)
    const retained = new Set(request.retained ?? [])
    const blocker = [...targetEntries].filter(name => !RUNTIME_CONTROL_FILES.has(name) && !retained.has(name))
    if (blocker.length > 0) return { kind: 'target-not-empty', target }

    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    staging = await fs.mkdtemp(join(dirname(target), '.harness-legacy-import-'))
    for (const root of supported) {
      // Roots moved by an earlier partial attempt stay in the target and are
      // never re-copied or re-reported as copied.
      if (retained.has(root)) continue
      await fs.cp(join(source, root), join(staging, root), { recursive: true, force: false })
      await fs.rename(join(staging, root), join(target, root))
      moved.push(root)
    }
    await fs.rm(staging, { recursive: true, force: true })
    return { kind: 'imported', copied: moved, source, target }
  } catch (_error) {
    // Any failure is a typed 'failed' result with a random diagnosticId; the
    // error text is intentionally not surfaced because it may embed paths or
    // values that must stay out of diagnostics and logs.
    if (staging !== undefined) {
      try {
        await fs.rm(staging, { recursive: true, force: true })
      } catch (_cleanupError) {
        // Staging cleanup cannot replace the typed import failure. Source and
        // target roots remain intact, and the diagnostic id identifies retry.
      }
    }
    return {
      kind: 'failed',
      source,
      target,
      retained: [...new Set([...(request.retained ?? []), ...moved])],
      diagnosticId: randomUUID() as RuntimeDiagnosticId,
    }
  }
}

/** Readdir treating ENOENT as an empty directory. */
async function safeReaddir(root: string, fs: LegacyImportFs): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return new Set(entries.map(entry => entry.name))
  } catch (error) {
    if (!isENOENT(error)) throw error
    return new Set()
  }
}

/**
 * Detect the Runtime-owned migration state for a resolution. A missing legacy
 * candidate is `not-needed`; an absent state file is a pending decision. The
 * stored state never contains the legacy source path or any secret.
 * @param resolution - resolved Harness home and legacy candidate.
 * @returns the typed migration state.
 */
export async function detectLegacyImport(resolution: HarnessHomeResolution): Promise<LegacyMigrationState> {
  if (resolution.legacyDshHome === undefined) return { kind: 'not-needed' }
  let text: string
  try {
    text = await readBoundedMigrationState(join(resolution.path, LEGACY_MIGRATION_FILENAME))
  } catch (error) {
    if (!isENOENT(error)) throw error
    return { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false }
  }
  return parseMigrationState(text)
}

/**
 * Record a user decision and execute an accepted import through the Runtime.
 * A declined decision persists `declined`; an accepted decision runs the
 * import and persists the mapped result. The Runtime never chooses for the
 * user: it only records and executes.
 * @param decision - the user decision plus the resolution that produced it.
 * @returns the resulting migration state.
 */
export async function recordLegacyImportDecision(decision: {
  decision: 'accepted' | 'declined'
  resolution: HarnessHomeResolution
}): Promise<LegacyMigrationState> {
  const { resolution } = decision
  if (resolution.legacyDshHome === undefined) {
    const state: LegacyMigrationState = { kind: 'not-needed' }
    await writeMigrationState(resolution.path, state)
    return state
  }

  if (decision.decision === 'declined') {
    const state: LegacyMigrationState = { kind: 'declined' }
    await writeMigrationState(resolution.path, state)
    return state
  }

  const prior = await readMigrationState(resolution.path)
  if (prior.kind === 'imported') return prior
  const retained = prior.kind === 'failed' || prior.kind === 'target-not-empty' ? prior.retained : undefined
  const result = await importLegacyDshHome({
    source: resolution.legacyDshHome,
    target: resolution.path,
    ...(retained === undefined ? {} : { retained }),
  })
  const state = await mapImportResult(result, resolution.path)
  await writeMigrationState(resolution.path, state)
  return state
}

/** Map a raw import result to the Runtime-facing state. */
async function mapImportResult(result: LegacyImportResult, home: HarnessHome): Promise<LegacyMigrationState> {
  switch (result.kind) {
    case 'imported':
      return { kind: 'imported', copied: result.copied }
    case 'not-found':
      return { kind: 'not-needed' }
    case 'target-not-empty':
      return {
        kind: 'target-not-empty',
        retryable: true,
        diagnosticId: randomUUID() as RuntimeDiagnosticId,
        retained: await presentSupportedRoots(home),
      }
    case 'failed':
      return { kind: 'failed', retained: result.retained, retryable: true, diagnosticId: result.diagnosticId }
  }
}

/** Supported roots already present in a target, retained from an earlier attempt. */
async function presentSupportedRoots(home: HarnessHome): Promise<string[]> {
  const entries = await safeReaddir(home, fsPromises)
  return LEGACY_IMPORT_ROOTS.filter(root => entries.has(root))
}

/** Read the stored state; an absent file means no decision has been made. */
async function readMigrationState(home: HarnessHome): Promise<LegacyMigrationState> {
  let text: string
  try {
    text = await readBoundedMigrationState(join(home, LEGACY_MIGRATION_FILENAME))
  } catch (error) {
    if (!isENOENT(error)) throw error
    return { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false }
  }
  return parseMigrationState(text)
}

/**
 * Parse one stored migration state. The state file is Runtime-owned and
 * contains no secrets and no absolute source paths; an unrecognized document
 * fails loud rather than being treated as a fresh decision.
 */
function parseMigrationState(text: string): LegacyMigrationState {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('host-local-runtime: legacy-migration.json must contain valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('host-local-runtime: legacy-migration.json must contain a migration state object')
  }
  const state = value as Record<string, unknown>
  const kind = state.kind
  switch (kind) {
    case 'not-needed':
      requireExactStateKeys(state, ['kind'])
      return { kind: 'not-needed' }
    case 'declined':
      requireExactStateKeys(state, ['kind'])
      return { kind: 'declined' }
    case 'imported':
      requireExactStateKeys(state, ['kind', 'copied'])
      return { kind: 'imported', copied: readRootArray(state.copied) }
    case 'target-not-empty':
      requireExactStateKeys(state, ['kind', 'retryable', 'diagnosticId', 'retained'])
      if (state.retryable !== true) throw new Error('host-local-runtime: legacy-migration.json has an invalid retryable flag')
      return { kind: 'target-not-empty', retryable: true, diagnosticId: readDiagnosticId(state), retained: readRootArray(state.retained) }
    case 'failed':
      requireExactStateKeys(state, ['kind', 'retained', 'retryable', 'diagnosticId'])
      if (state.retryable !== true) throw new Error('host-local-runtime: legacy-migration.json has an invalid retryable flag')
      return { kind: 'failed', retained: readRootArray(state.retained), retryable: true, diagnosticId: readDiagnosticId(state) }
    case 'decision-required':
      requireExactStateKeys(state, ['kind', 'sourceLabel', 'retryable'])
      if (state.sourceLabel !== 'DSH_HOME' || state.retryable !== false) {
        throw new Error('host-local-runtime: legacy-migration.json has an invalid decision state')
      }
      return { kind: 'decision-required', sourceLabel: 'DSH_HOME', retryable: false }
    default:
      throw new Error('host-local-runtime: legacy-migration.json contains an unrecognized state')
  }
}

/** Read at most the complete migration-state byte budget before UTF-8/JSON parsing. */
async function readBoundedMigrationState(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAX_LEGACY_MIGRATION_STATE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (read.bytesRead === 0) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > MAX_LEGACY_MIGRATION_STATE_BYTES) {
      throw new Error('host-local-runtime: legacy-migration.json exceeds its byte limit')
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw new Error('host-local-runtime: legacy-migration.json must contain valid UTF-8')
    }
  } finally {
    await handle.close()
  }
}

/** Validate a stored supported-root array without echoing hostile entries. */
function readRootArray(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.some(entry => typeof entry !== 'string' || !LEGACY_IMPORT_ROOTS.includes(entry as never))
    || new Set(value).size !== value.length) {
    throw new Error('host-local-runtime: legacy-migration.json contains an invalid root list')
  }
  return value as string[]
}

/** Validate a stored diagnostic id. */
function readDiagnosticId(state: Record<string, unknown>): RuntimeDiagnosticId {
  if (typeof state.diagnosticId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.diagnosticId)) {
    throw new Error('host-local-runtime: legacy-migration.json is missing its diagnosticId')
  }
  return state.diagnosticId as RuntimeDiagnosticId
}

/** Reject unknown or missing durable fields without reflecting their values. */
function requireExactStateKeys(state: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(state)
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(state, key))) {
    throw new Error('host-local-runtime: legacy-migration.json contains invalid fields')
  }
}

/** Atomically persist the state under the target home with owner-only access. */
async function writeMigrationState(home: HarnessHome, state: LegacyMigrationState): Promise<void> {
  await writeFileAtomic(join(home, LEGACY_MIGRATION_FILENAME), JSON.stringify(state, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
}
