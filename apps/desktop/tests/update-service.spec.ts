/** Desktop update staging transaction behavior. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { EMPTY_UPDATE_TRUST, type UpdateTrust } from '@harness-desktop/dsh-update-policy'
import { desktopReadyAcknowledgement } from '../src/main/readiness.ts'
import { DesktopUpdateService, type DesktopUpdateRuntime } from '../src/main/update/service.ts'
import { createDesktopUpdateFixture, type FixtureLaunchResult } from './support/update-fixture.ts'

interface RuntimeFixture {
  readonly runtime: DesktopUpdateRuntime
  readonly outcomes: unknown[]
}

function runtimeFixture(): RuntimeFixture {
  const outcomes: unknown[] = []
  return {
    outcomes,
    runtime: {
      getDesktopUpdateChannel: async () => 'stable',
      recordDesktopUpdateOutcome: async (outcome) => { outcomes.push(outcome) },
    },
  }
}

describe('DesktopUpdateService', () => {
  it('short-circuits empty trust before manifest or artifact work', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime } = runtimeFixture()
    try {
      const service = new DesktopUpdateService({
        appId: fixture.manifest.applicationId,
        currentVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        trust: EMPTY_UPDATE_TRUST,
        runtime,
        loadManifest: fixture.loadManifest,
        adapter: fixture.adapter,
      })

      await expect(service.checkAndStage()).resolves.toEqual({ kind: 'up-to-date', code: 'unconfigured-trust-root' })
      expect(fixture.calls).toEqual({ load: 0, download: 0, inspect: 0, stage: 0, launch: 0, restore: 0, cleanup: 0 })
    } finally {
      await fixture.close()
    }
  })

  it('stages only verified candidate bytes and inspected members', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime, outcomes } = runtimeFixture()
    try {
      const service = serviceFor(fixture.trust, fixture, runtime)

      await expect(service.checkAndStage()).resolves.toEqual({
        kind: 'staged', code: 'candidate-staged', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.retainedVersion, 'utf8')).resolves.toBe('1.0.0')
      expect(fixture.calls).toMatchObject({ load: 1, download: 1, inspect: 1, stage: 1, launch: 0 })
      expect(outcomes).toEqual([{ version: '1.1.0', channel: 'stable', kind: 'staged', code: 'staged' }])
    } finally {
      await fixture.close()
    }
  })

  it('applies a staged candidate after exactly one authenticated Dashboard acknowledgement', async () => {
    const fixture = await createDesktopUpdateFixture('ready')
    const { runtime, outcomes } = runtimeFixture()
    try {
      const service = serviceFor(fixture.trust, fixture, runtime)
      await service.checkAndStage()

      await expect(service.applyStagedUpdate()).resolves.toEqual({
        kind: 'applied', code: 'candidate-applied', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.1.0')
      expect(fixture.calls.launch).toBe(1)
      expect(outcomes).toEqual([
        { version: '1.1.0', channel: 'stable', kind: 'staged', code: 'staged' },
        { version: '1.1.0', channel: 'stable', kind: 'applied', code: 'applied', lastKnownGoodVersion: '1.1.0' },
      ])
    } finally {
      await fixture.close()
    }
  })

  it('shares one candidate launch and outcome with concurrent apply callers', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime, outcomes } = runtimeFixture()
    let releaseLaunch!: () => void
    const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve })
    let launches = 0
    try {
      const adapter = {
        ...fixture.adapter,
        launchCandidate: async () => {
          launches += 1
          await launchReleased
          return desktopReadyAcknowledgement
        },
      }
      const service = new DesktopUpdateService({
        appId: fixture.manifest.applicationId,
        currentVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        trust: fixture.trust,
        runtime,
        loadManifest: fixture.loadManifest,
        adapter,
      })
      await service.checkAndStage()

      const first = service.applyStagedUpdate()
      const second = service.applyStagedUpdate()
      await Promise.resolve()
      expect(launches).toBe(1)
      releaseLaunch()

      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: 'applied', code: 'candidate-applied', version: '1.1.0', channel: 'stable' },
        { kind: 'applied', code: 'candidate-applied', version: '1.1.0', channel: 'stable' },
      ])
      expect(outcomes).toEqual([
        { version: '1.1.0', channel: 'stable', kind: 'staged', code: 'staged' },
        { version: '1.1.0', channel: 'stable', kind: 'applied', code: 'applied', lastKnownGoodVersion: '1.1.0' },
      ])
    } finally {
      releaseLaunch()
      await fixture.close()
    }
  })

  it('waits for an applying candidate before staging a new candidate', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime } = runtimeFixture()
    let releaseLaunch!: () => void
    const launchReleased = new Promise<void>((resolve) => { releaseLaunch = resolve })
    try {
      const adapter = {
        ...fixture.adapter,
        launchCandidate: async (candidate: Parameters<typeof fixture.adapter.launchCandidate>[0]) => {
          await launchReleased
          return await fixture.adapter.launchCandidate(candidate)
        },
      }
      const service = new DesktopUpdateService({
        appId: fixture.manifest.applicationId,
        currentVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        trust: fixture.trust,
        runtime,
        loadManifest: fixture.loadManifest,
        adapter,
      })
      await service.checkAndStage()

      const applying = service.applyStagedUpdate()
      const checking = service.checkAndStage()
      await Promise.resolve()
      expect(fixture.calls).toMatchObject({ stage: 1, launch: 0 })
      releaseLaunch()

      await expect(applying).resolves.toEqual({
        kind: 'applied', code: 'candidate-applied', version: '1.1.0', channel: 'stable',
      })
      await expect(checking).resolves.toEqual({
        kind: 'staged', code: 'candidate-staged', version: '1.1.0', channel: 'stable',
      })
      expect(fixture.calls).toMatchObject({ stage: 2, launch: 1 })
    } finally {
      releaseLaunch()
      await fixture.close()
    }
  })

  it('preserves the current installation when retaining it fails before publication', async () => {
    const fixture = await createDesktopUpdateFixture('ready', { failRetain: true })
    const { runtime, outcomes } = runtimeFixture()
    try {
      const service = serviceFor(fixture.trust, fixture, runtime)

      await expect(service.checkAndStage()).resolves.toEqual({
        kind: 'failed', code: 'candidate-restore-failed', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(fixture.harnessSentinel, 'utf8')).resolves.toBe('keep')
      expect(fixture.calls).toMatchObject({ stage: 1, restore: 1, launch: 0 })
      expect(outcomes).toEqual([{ version: '1.1.0', channel: 'stable', kind: 'failed', code: 'install-failed' }])
    } finally {
      await fixture.close()
    }
  })

  it('restores a displaced retained root when its replacement publication fails', async () => {
    const fixture = await createDesktopUpdateFixture('ready', { failRetainPublishOnStage: 2 })
    const { runtime } = runtimeFixture()
    try {
      const service = serviceFor(fixture.trust, fixture, runtime)
      await service.checkAndStage()

      await expect(service.checkAndStage()).resolves.toEqual({
        kind: 'failed', code: 'candidate-staging-failed', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.retainedVersion, 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(fixture.harnessSentinel, 'utf8')).resolves.toBe('keep')
      await expect(service.applyStagedUpdate()).resolves.toEqual({ kind: 'up-to-date', code: 'no-staged-candidate' })
      expect(fixture.calls.launch).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it('restores the displaced live installation when restored publication fails', async () => {
    const fixture = await createDesktopUpdateFixture('malformed', { failRestorePublish: true })
    const { runtime } = runtimeFixture()
    try {
      const service = serviceFor(fixture.trust, fixture, runtime)
      await service.checkAndStage()

      await expect(service.applyStagedUpdate()).resolves.toEqual({
        kind: 'failed', code: 'candidate-restore-failed', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.1.0')
      await expect(readFile(fixture.retainedVersion, 'utf8')).resolves.toBe('1.0.0')
      await expect(readFile(fixture.harnessSentinel, 'utf8')).resolves.toBe('keep')
    } finally {
      await fixture.close()
    }
  })

  it.each(['missing', 'malformed', 'failed'] as const)(
    'restores the retained installation when the candidate acknowledgement is %s',
    async (launchResult: FixtureLaunchResult) => {
      const fixture = await createDesktopUpdateFixture(launchResult)
      const { runtime, outcomes } = runtimeFixture()
      try {
        const service = serviceFor(fixture.trust, fixture, runtime)
        await service.checkAndStage()

        await expect(service.applyStagedUpdate()).resolves.toEqual({
          kind: 'rolled-back', code: 'desktop-health-check-failed', version: '1.1.0', channel: 'stable',
        })
        await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.0.0')
        await expect(readFile(fixture.harnessSentinel, 'utf8')).resolves.toBe('keep')
        expect(fixture.calls.launch).toBe(1)
        expect(fixture.calls.restore).toBe(1)
        expect(outcomes.at(-1)).toEqual({
          version: '1.1.0', channel: 'stable', kind: 'rolled-back', code: 'health-check-failed', lastKnownGoodVersion: '1.0.0',
        })
      } finally {
        await fixture.close()
      }
    },
  )

  it('rejects modified candidate bytes before staging or switching', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime, outcomes } = runtimeFixture()
    try {
      const adapter = { ...fixture.adapter, download: async () => Buffer.from('modified') }
      const service = new DesktopUpdateService({
        appId: fixture.manifest.applicationId,
        currentVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        trust: fixture.trust,
        runtime,
        loadManifest: fixture.loadManifest,
        adapter,
      })

      await expect(service.checkAndStage()).resolves.toEqual({
        kind: 'failed', code: 'candidate-bytes-rejected', version: '1.1.0', channel: 'stable',
      })
      await expect(readFile(fixture.installationVersion, 'utf8')).resolves.toBe('1.0.0')
      expect(fixture.calls.stage).toBe(0)
      expect(outcomes).toEqual([{ version: '1.1.0', channel: 'stable', kind: 'failed', code: 'artifact-rejected' }])
      expect(createHash('sha256').update(fixture.archive).digest('hex')).not.toBe(createHash('sha256').update('modified').digest('hex'))
    } finally {
      await fixture.close()
    }
  })

  it('rejects mismatched actual members before staging or switching', async () => {
    const fixture = await createDesktopUpdateFixture()
    const { runtime, outcomes } = runtimeFixture()
    let inspections = 0
    try {
      const adapter = {
        ...fixture.adapter,
        inspect: async () => {
          inspections += 1
          return ['unexpected-member']
        },
      }
      const service = new DesktopUpdateService({
        appId: fixture.manifest.applicationId,
        currentVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        trust: fixture.trust,
        runtime,
        loadManifest: fixture.loadManifest,
        adapter,
      })

      await expect(service.checkAndStage()).resolves.toEqual({
        kind: 'failed', code: 'candidate-members-rejected', version: '1.1.0', channel: 'stable',
      })
      await expect(service.applyStagedUpdate()).resolves.toEqual({ kind: 'up-to-date', code: 'no-staged-candidate' })
      expect(inspections).toBe(1)
      expect(fixture.calls).toMatchObject({ stage: 0, launch: 0 })
      expect(outcomes).toEqual([{ version: '1.1.0', channel: 'stable', kind: 'failed', code: 'artifact-rejected' }])
    } finally {
      await fixture.close()
    }
  })
})

function serviceFor(
  trust: UpdateTrust,
  fixture: Awaited<ReturnType<typeof createDesktopUpdateFixture>>,
  runtime: DesktopUpdateRuntime,
): DesktopUpdateService {
  return new DesktopUpdateService({
    appId: fixture.manifest.applicationId,
    currentVersion: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    trust,
    runtime,
    loadManifest: fixture.loadManifest,
    adapter: fixture.adapter,
  })
}
