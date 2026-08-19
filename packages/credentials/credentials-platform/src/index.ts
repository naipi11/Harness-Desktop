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

import { Context } from '@harness-desktop/cordis'
import { join } from 'node:path'
import { writeFileAtomic } from '@harness-desktop/dsh-atomic-write'
import { launchEnvironmentOf } from '@harness-desktop/dsh-launch-environment'
import { CredentialProvider } from '@harness-desktop/dsh-credentials'
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
  /** Durably store one value in the platform store. */
  set(ref: CredentialRef, value: string): Promise<void>
  /** Remove one value from the platform store. */
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

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const entry = this.snapshot.getFrom(ref, ['process'])
    if (entry === undefined || entry.value.length === 0) return undefined
    return { value: entry.value, source: 'env' }
  }

  async set(ref: CredentialRef, _value: string): Promise<void> {
    throw new Error(`credentials-platform: the environment adapter is read-only; cannot set "${ref}"`)
  }

  async unset(ref: CredentialRef): Promise<void> {
    throw new Error(`credentials-platform: the environment adapter is read-only; cannot unset "${ref}"`)
  }
}

/** Serialized reference metadata; never contains a secret value. */
interface MetadataDocument {
  version: 1
  references: string[]
}

/**
 * Runtime-only credentials provider that stores opaque references and
 * resolves values from the platform adapter. `set`/`unset` write through to
 * the adapter and persist the reference list under the harness home; values
 * never enter the metadata document.
 */
export class PlatformCredentialProvider extends CredentialProvider {
  private readonly spec: ResolvedSpec
  private readonly adapter: PlatformCredentialAdapter
  private metadata: Set<string> = new Set()
  /** Single exclusive operation chain so metadata writes never interleave. */
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.adapter = config.adapter ?? new EnvironmentAdapter(launchEnvironmentOf(ctx))
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
    await this.adapter.set(ref, value)
    await this.enqueue(async () => {
      this.metadata.add(ref)
      await this.writeMetadata()
    })
    this.notifyUpdated(ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    const resolved = await this.adapter.resolve(ref)
    if (!this.adapter.writable && resolved !== undefined) {
      throw new Error(`credentials-platform: "${ref}" is supplied read-only by the platform; cannot unset`)
    }
    if (!this.adapter.writable) return
    const had = this.metadata.has(ref) || resolved !== undefined
    await this.adapter.unset(ref)
    await this.enqueue(async () => {
      this.metadata.delete(ref)
      await this.writeMetadata()
    })
    if (had) this.notifyUpdated(ref)
  }

  /** Persist the sorted reference list atomically with owner-only access. */
  private async writeMetadata(): Promise<void> {
    const document: MetadataDocument = {
      version: 1,
      references: [...this.metadata].sort(),
    }
    await writeFileAtomic(this.spec.metadataFilename, JSON.stringify(document, null, 2) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

export default PlatformCredentialProvider
