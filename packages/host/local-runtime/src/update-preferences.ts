/** Runtime-owned Desktop update preference and redacted outcome persistence. */

import z from '@harness-desktop/schemastery'
import {
  settingsNamespace,
  type SettingsProvider,
  type SettingsScope,
} from '@harness-desktop/dsh-settings'

const SEMANTIC_VERSION_PATTERN = new RegExp([
  '^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)',
  '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
].join(''))

/** Settings namespace carrying one user's selected update channel. */
export const DESKTOP_UPDATE_SETTINGS_NAMESPACE = settingsNamespace('desktop-update')

/** Release channels a Harness Desktop client may select. */
export const DESKTOP_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const

/** One selected Desktop update channel. */
export type DesktopUpdateChannel = typeof DESKTOP_UPDATE_CHANNELS[number]

/** Terminal states a verified updater may record without exposing implementation detail. */
export const DESKTOP_UPDATE_OUTCOME_KINDS = ['up-to-date', 'staged', 'applied', 'rolled-back', 'failed'] as const

/** One redacted update lifecycle state. */
export type DesktopUpdateOutcomeKind = typeof DESKTOP_UPDATE_OUTCOME_KINDS[number]

/** Stable, secret-free diagnostic codes a verified updater may persist. */
export const DESKTOP_UPDATE_OUTCOME_CODES = [
  'unconfigured-trust-root',
  'up-to-date',
  'staged',
  'applied',
  'rolled-back',
  'manifest-rejected',
  'artifact-rejected',
  'health-check-failed',
  'install-failed',
] as const

/** One redacted outcome code. */
export type DesktopUpdateOutcomeCode = typeof DESKTOP_UPDATE_OUTCOME_CODES[number]

/** A durable update result that contains no location, credential, manifest, or raw error. */
export interface DesktopUpdateOutcome {
  /** Candidate or current Harness Desktop semantic version. */
  readonly version: string
  /** Selected release channel at the time of the result. */
  readonly channel: DesktopUpdateChannel
  /** Coarse verified updater result. */
  readonly kind: DesktopUpdateOutcomeKind
  /** Stable redacted cause or result code. */
  readonly code: DesktopUpdateOutcomeCode
  /** Retained compatible version after a successful health acknowledgement, when known. */
  readonly lastKnownGoodVersion?: string
}

/** One user's stored Desktop update selection and last redacted outcome. */
export interface DesktopUpdateSettings {
  /** Release channel used by a later native updater. */
  readonly channel: DesktopUpdateChannel
  /** Most recently committed redacted outcome, when one exists. */
  readonly lastOutcome?: DesktopUpdateOutcome | undefined
}

/** Schema for a redacted persisted outcome. */
export const DESKTOP_UPDATE_OUTCOME_SCHEMA: z<DesktopUpdateOutcome> = z.object({
  version: z.string().required().pattern(SEMANTIC_VERSION_PATTERN),
  channel: z.union(DESKTOP_UPDATE_CHANNELS).required(),
  kind: z.union(DESKTOP_UPDATE_OUTCOME_KINDS).required(),
  code: z.union(DESKTOP_UPDATE_OUTCOME_CODES).required(),
  lastKnownGoodVersion: z.string().pattern(SEMANTIC_VERSION_PATTERN),
})

/** Schema for the Runtime-owned Desktop update settings section. */
export const DESKTOP_UPDATE_SETTINGS_SCHEMA: z<DesktopUpdateSettings> = z.object({
  channel: z.union(DESKTOP_UPDATE_CHANNELS).default('stable'),
  lastOutcome: z.union([DESKTOP_UPDATE_OUTCOME_SCHEMA, z.const(undefined)]),
})

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/**
 * @param value - untrusted candidate value.
 * @returns whether the value names one supported Desktop update channel.
 */
export function isDesktopUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return typeof value === 'string' && DESKTOP_UPDATE_CHANNELS.includes(value as DesktopUpdateChannel)
}

/**
 * @param value - untrusted candidate version.
 * @returns whether the value is a bounded semantic version.
 */
function isSemanticVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && SEMANTIC_VERSION_PATTERN.test(value)
}

/**
 * @param value - untrusted candidate outcome.
 * @returns whether the value is the fixed-format redacted update outcome.
 */
export function isDesktopUpdateOutcome(value: unknown): value is DesktopUpdateOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const outcome = value as Record<string, unknown>
  const keys = outcome.lastKnownGoodVersion === undefined
    ? ['version', 'channel', 'kind', 'code']
    : ['version', 'channel', 'kind', 'code', 'lastKnownGoodVersion']
  return hasExactKeys(outcome, keys)
    && isSemanticVersion(outcome.version)
    && isDesktopUpdateChannel(outcome.channel)
    && typeof outcome.kind === 'string' && DESKTOP_UPDATE_OUTCOME_KINDS.includes(outcome.kind as DesktopUpdateOutcomeKind)
    && typeof outcome.code === 'string' && DESKTOP_UPDATE_OUTCOME_CODES.includes(outcome.code as DesktopUpdateOutcomeCode)
    && (outcome.lastKnownGoodVersion === undefined || isSemanticVersion(outcome.lastKnownGoodVersion))
}

/** Refuse durable fields outside the fixed redacted record. */
function validateDesktopUpdateSettings(value: DesktopUpdateSettings): void {
  const settings = value as unknown as Record<string, unknown>
  const outcome = value.lastOutcome
  if (!hasExactKeys(settings, outcome === undefined ? ['channel'] : ['channel', 'lastOutcome'])) {
    throw new Error('host-local-runtime: desktop update settings contain an unsupported field')
  }
  if (!isDesktopUpdateChannel(value.channel)) {
    throw new Error('host-local-runtime: desktop update settings contain an unsupported channel')
  }
  if (outcome !== undefined && !isDesktopUpdateOutcome(outcome)) {
    throw new Error('host-local-runtime: desktop update outcome contains an unsupported field')
  }
}

/**
 * Owns one Runtime's update preference scope through the composed settings provider.
 * A caller supplies the provider rather than a storage path so all writes use the
 * Runtime's existing serialized persistence mechanism.
 */
export class DesktopUpdatePreferences {
  private readonly scope: SettingsScope<DesktopUpdateSettings>

  /**
   * @param settings - composed Runtime settings provider that owns the durable document.
   */
  constructor(settings: SettingsProvider) {
    this.scope = settings.register(DESKTOP_UPDATE_SETTINGS_NAMESPACE, DESKTOP_UPDATE_SETTINGS_SCHEMA, {
      validate: validateDesktopUpdateSettings,
    })
  }

  /** @returns the resolved selected update channel. */
  getChannel(): DesktopUpdateChannel {
    return this.scope.get().channel
  }

  /**
   * Persist the selected channel through the Runtime settings provider.
   * @param channel - one accepted release channel.
   * @returns fulfillment after the serialized settings write commits.
   */
  setChannel(channel: DesktopUpdateChannel): Promise<void> {
    return this.scope.update({ channel })
  }

  /**
   * Persist one fixed-format outcome without creating a separate update-state writer.
   * @param outcome - redacted result from a future verified native updater.
   * @returns fulfillment after the serialized settings write commits.
   */
  record(outcome: DesktopUpdateOutcome): Promise<void> {
    return this.scope.update({ lastOutcome: outcome })
  }
}
