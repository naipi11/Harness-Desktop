/** Runtime-owned Desktop update preference persistence. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@harness-desktop/cordis'
import { SettingsProvider } from '@harness-desktop/dsh-settings'
import type { UpdateChannel } from '@harness-desktop/dsh-update-policy'
import type { SettingsNamespace } from '@harness-desktop/dsh-settings'
import {
  DESKTOP_UPDATE_CHANNELS,
  DesktopUpdatePreferences,
} from '../src/update-preferences.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Minimal real settings provider retaining the persisted user document for assertions. */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown>
  private readonly persistDelayMs: number

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: {
    readonly doc?: Record<string, unknown>
    readonly persistDelayMs?: number
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.persistDelayMs = options?.persistDelayMs ?? 0
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    if (this.persistDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.persistDelayMs))
    this.doc[namespace] = structuredClone(section)
  }
}

async function boot(options?: {
  readonly doc?: Record<string, unknown>
  readonly persistDelayMs?: number
}): Promise<{ readonly preferences: DesktopUpdatePreferences; readonly settings: MemorySettings }> {
  context = new Context()
  await context.plugin(MemorySettings, options).await()
  const settings = context.get('settings') as MemorySettings
  return { preferences: new DesktopUpdatePreferences(settings), settings }
}

describe('DesktopUpdatePreferences', () => {
  it('uses the shared policy release channel type for every persisted Runtime channel', () => {
    const channels: readonly UpdateChannel[] = DESKTOP_UPDATE_CHANNELS

    expect(channels).toEqual(['stable', 'beta', 'nightly'])
  })

  it('defaults to stable and persists a user-selected channel through the settings provider', async () => {
    const { preferences, settings } = await boot()

    expect(preferences.getChannel()).toBe('stable')
    expect(preferences.getLastOutcome()).toBeUndefined()

    await preferences.setChannel('beta')

    expect(settings.doc).toEqual({
      'desktop-update': { channel: 'beta' },
    })
  })

  it('serializes a selected channel and a redacted result without losing either field', async () => {
    const { preferences, settings } = await boot({ persistDelayMs: 5 })

    await Promise.all([
      preferences.setChannel('nightly'),
      preferences.record({
        version: '1.2.3',
        channel: 'nightly',
        kind: 'staged',
        code: 'staged',
      }),
    ])

    expect(settings.doc).toEqual({
      'desktop-update': {
        channel: 'nightly',
        lastOutcome: {
          version: '1.2.3',
          channel: 'nightly',
          kind: 'staged',
          code: 'staged',
        },
      },
    })
    expect(preferences.getLastOutcome()).toEqual({
      version: '1.2.3',
      channel: 'nightly',
      kind: 'staged',
      code: 'staged',
    })
  })

  it('accepts the public source-configuration result code', async () => {
    const result = await boot({
      doc: {
        'desktop-update': {
          channel: 'stable',
          lastOutcome: {
            version: '1.2.3',
            channel: 'stable',
            kind: 'failed',
            code: 'unconfigured-update-source',
          },
        },
      },
    }).then(() => 'accepted', () => 'rejected')

    expect(result).toBe('accepted')
  })

  it('refuses a stored outcome that carries an unredacted field', async () => {
    const result = await boot({
      doc: {
        'desktop-update': {
          channel: 'stable',
          lastOutcome: {
            version: '1.2.3',
            channel: 'stable',
            kind: 'failed',
            code: 'manifest-rejected',
            url: 'https://updates.example.test/manifest.json',
          },
        },
      },
    }).then(() => 'accepted', () => 'rejected')

    expect(result).toBe('rejected')
  })

  it('refuses a stored outcome whose version is not semantic', async () => {
    const result = await boot({
      doc: {
        'desktop-update': {
          channel: 'stable',
          lastOutcome: {
            version: 'latest',
            channel: 'stable',
            kind: 'failed',
            code: 'manifest-rejected',
          },
        },
      },
    }).then(() => 'accepted', () => 'rejected')

    expect(result).toBe('rejected')
  })

  it.each([
    ['an unsupported selected channel', { channel: 'preview' }],
    ['an unsupported outcome kind', {
      channel: 'stable',
      lastOutcome: { version: '1.2.3', channel: 'stable', kind: 'checking', code: 'staged' },
    }],
    ['an unsupported outcome code', {
      channel: 'stable',
      lastOutcome: { version: '1.2.3', channel: 'stable', kind: 'failed', code: 'network-detail' },
    }],
    ['the obsolete trust-root result code', {
      channel: 'stable',
      lastOutcome: { version: '1.2.3', channel: 'stable', kind: 'failed', code: 'unconfigured-trust-root' },
    }],
  ])('refuses %s from the stored settings document', async (_label, desktopUpdate) => {
    const result = await boot({ doc: { 'desktop-update': desktopUpdate } })
      .then(() => 'accepted', () => 'rejected')

    expect(result).toBe('rejected')
  })
})
