/**
 * Runtime-only credential-reference provider for the Harness Desktop local
 * Runtime.
 *
 * The provider persists only opaque reference metadata beneath `HARNESS_HOME`
 * (`.credential-references.json`); secret values are resolved per request from
 * a platform/environment adapter and never touch the metadata file, command
 * lines, logs, or diagnostics. The default adapter reads the launcher's frozen
 * `process` environment layer and is read-only; a platform adapter injected by
 * the Desktop host can be writable.
 * @module @harness-desktop/dsh-credentials-platform
 */

import { Context, Service } from '@harness-desktop/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@harness-desktop/dsh-atomic-write'
import { launchEnvironmentOf } from '@harness-desktop/dsh-launch-environment'
import { CredentialProvider, credentialRef } from '@harness-desktop/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@harness-desktop/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@harness-desktop/dsh-launch-environment'

/** Basename of the reference-metadata document inside the harness home. */
export const CREDENTIAL_REFERENCES_FILENAME = '.credential-references.json'

/** Plugin config: the home plus an optional platform adapter. */
export interface Config {
  /** Absolute Harness home beneath which the metadata document lives. */
  harnessHome?: string
  /** Platform adapter; defaults to the read-only launcher environment. */
  adapter?: PlatformCredentialAdapter
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  metadataFilename: string
}

/**
 * Resolve the runtime spec from plugin config. The harness home is required:
 * the provider must never fall back to a second writable root.
 * @param config - raw plugin config.
 * @returns the resolved metadata location.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  if (config.harnessHome === undefined) {
    throw new Error('credentials-platform: harnessHome is required')
  }
  return { metadataFilename: join(config.harnessHome, CREDENTIAL_REFERENCES_FILENAME) }
}

/**
 * Platform/environment adapter supplying secret values and owning mutations.
 * A read-only adapter resolves but rejects `set`/`unset`; a writable adapter
 * is the platform's durable store (keychain, platform vault), never a file
 * this package writes values into.
 */
export interface PlatformCredentialAdapter {
  /** Whether `set`/`unset` can succeed on this adapter. */
  readonly writable: boolean
  /** Resolve one reference to its current value, or `undefined` when unconfigured. */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  /** Durably store one value; rejection must leave the current value unchanged. */
  set(ref: CredentialRef, value: string): Promise<void>
  /** Remove one value; rejection must leave the current value unchanged. */
  unset(ref: CredentialRef): Promise<void>
}

/**
 * Read-only adapter over the launcher's frozen process environment layer.
 * Empty values are absent, matching the seam rule; `set`/`unset` always reject
 * because the process environment cannot be edited from inside.
 */
class EnvironmentAdapter implements PlatformCredentialAdapter {
  readonly writable = false
  private readonly snapshot: LaunchEnvironmentSnapshot

  constructor(snapshot: LaunchEnvironmentSnapshot) {
    this.snapshot = snapshot
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const entry = this.snapshot.getFrom(ref, ['process'])
    if (entry === undefined || entry.value.length === 0) return Promise.resolve(undefined)
    return Promise.resolve({ value: entry.value, source: 'env' })
  }

  set(ref: CredentialRef, _value: string): Promise<void> {
    return Promise.reject(new Error(`credentials-platform: the environment adapter is read-only; cannot set "${ref}"`))
  }

  unset(ref: CredentialRef): Promise<void> {
    return Promise.reject(new Error(`credentials-platform: the environment adapter is read-only; cannot unset "${ref}"`))
  }
}

/** Serialized reference metadata; never contains a secret value. */
interface MetadataDocument {
  version: 1
  references: string[]
}

/** Whether an error means the metadata document is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Parse the strict version-1 reference document without echoing its content. */
function parseMetadataDocument(text: string): Set<CredentialRef> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_error) {
    throw new Error('credentials-platform: .credential-references.json must contain valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('credentials-platform: .credential-references.json must contain a version-1 metadata object')
  }
  const document = value as Record<string, unknown>
  const keys = Object.keys(document).sort()
  if (keys.length !== 2 || keys[0] !== 'references' || keys[1] !== 'version'
    || document.version !== 1 || !Array.isArray(document.references)) {
    throw new Error('credentials-platform: .credential-references.json must contain only version and references')
  }
  const references: CredentialRef[] = []
  for (const entry of document.references) {
    if (typeof entry !== 'string') {
      throw new Error('credentials-platform: .credential-references.json contains an invalid reference list')
    }
    try {
      references.push(credentialRef(entry))
    } catch (_error) {
      throw new Error('credentials-platform: .credential-references.json contains an invalid reference name')
    }
  }
  const sorted = [...references].sort()
  if (new Set(references).size !== references.length || sorted.some((ref, index) => ref !== references[index])) {
    throw new Error('credentials-platform: .credential-references.json references must be unique and sorted')
  }
  return new Set(references)
}

/**
 * Runtime-only credentials provider that stores opaque references and
 * resolves values from the platform adapter. Boot loads and validates the
 * reference list. `set`/`unset` atomically persist candidate metadata before
 * mutating the adapter and restore the previous metadata if the adapter
 * rejects; values never enter the metadata document.
 */
export class PlatformCredentialProvider extends CredentialProvider {
  private readonly spec: ResolvedSpec
  private readonly adapter: PlatformCredentialAdapter
  private metadata = new Set<CredentialRef>()
  /** Single exclusive operation chain so metadata writes never interleave. */
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.adapter = config.adapter ?? new EnvironmentAdapter(launchEnvironmentOf(ctx))
  }

  /** Load the durable reference list before the service becomes ready. */
  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => { await this.operations }
    try {
      this.metadata = parseMetadataDocument(await readFile(this.spec.metadataFilename, 'utf8'))
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.metadata = new Set()
    }
  }

  /** Queue one exclusive metadata operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.adapter.resolve(ref)
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const resolved = await this.adapter.resolve(ref)
    if (resolved === undefined) return { configured: false, writable: this.adapter.writable }
    return { configured: true, source: resolved.source, writable: this.adapter.writable }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-platform: an empty value cannot be stored for "${ref}"; use unset`)
    }
    if (!this.adapter.writable) {
      throw new Error(`credentials-platform: the environment adapter is read-only; cannot set "${ref}"`)
    }
    await this.enqueue(async () => {
      const next = new Set(this.metadata).add(ref)
      await this.writeMetadata(next)
      try {
        await this.adapter.set(ref, value)
      } catch (error) {
        await this.rollbackMetadata(error, 'set')
      }
      this.metadata = next
      this.notifyUpdated(ref)
    })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.enqueue(async () => {
      const resolved = await this.adapter.resolve(ref)
      if (!this.adapter.writable && resolved !== undefined) {
        throw new Error(`credentials-platform: "${ref}" is supplied read-only by the platform; cannot unset`)
      }
      if (!this.adapter.writable) return
      const had = this.metadata.has(ref) || resolved !== undefined
      const next = new Set(this.metadata)
      next.delete(ref)
      await this.writeMetadata(next)
      try {
        await this.adapter.unset(ref)
      } catch (error) {
        await this.rollbackMetadata(error, 'unset')
      }
      this.metadata = next
      if (had) this.notifyUpdated(ref)
    })
  }

  /** Persist the sorted reference list atomically with owner-only access. */
  private async writeMetadata(metadata: ReadonlySet<CredentialRef>): Promise<void> {
    const document: MetadataDocument = {
      version: 1,
      references: [...metadata].sort(),
    }
    await writeFileAtomic(this.spec.metadataFilename, JSON.stringify(document, null, 2) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /** Restore the last committed metadata after an adapter mutation rejects. */
  private async rollbackMetadata(adapterError: unknown, operation: 'set' | 'unset'): Promise<never> {
    try {
      await this.writeMetadata(this.metadata)
    } catch (metadataError) {
      throw new AggregateError(
        [adapterError, metadataError],
        `credentials-platform: adapter ${operation} failed and reference metadata rollback also failed`,
      )
    }
    throw adapterError
  }
}

export default PlatformCredentialProvider
