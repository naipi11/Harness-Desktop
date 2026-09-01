/** Detached native rollback worker behavior. */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  executeNativeRollback,
  parseNativeUpdateWatchState,
  parseNativeUpdateWatchPlan,
  prepareNativeRollbackArtifacts,
  superviseNativeUpdate,
  type NativeRollbackOperations,
  type NativeRollbackPlan,
  type NativeProcessReference,
  type NativeUpdateWatchPlan,
  type NativeUpdateWatchState,
} from '../src/main/update/native-rollback.ts'

const rollbackBytes = Buffer.from('verified-stable-installer')
const rollbackSha256 = createHash('sha256').update(rollbackBytes).digest('hex')
const candidateBytes = Buffer.from('verified-candidate-installer')
const candidateSha256 = createHash('sha256').update(candidateBytes).digest('hex')
const transactionId = '11111111-1111-4111-8111-111111111111'

interface RollbackFixture {
  readonly operations: NativeRollbackOperations
  readonly events: string[]
  readonly states: NativeUpdateWatchState[]
  readonly alive: Set<number>
}

function fixture(
  candidateStaysAlive = true,
  candidateResistsGracefulTermination = false,
  candidateResistsForcefulTermination = false,
): RollbackFixture {
  const events: string[] = []
  const states: NativeUpdateWatchState[] = []
  const alive = new Set<number>()
  let now = 0
  let applicationLaunches = 0
  return {
    events,
    states,
    alive,
    operations: {
      isProcessAlive: process => alive.has(process.processId),
      terminate: (process) => {
        events.push(`terminate:${process.processId}`)
        if (!candidateResistsGracefulTermination) alive.delete(process.processId)
      },
      forceTerminate: (process) => {
        events.push(`force-terminate:${process.processId}`)
        if (!candidateResistsForcefulTermination) alive.delete(process.processId)
      },
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds },
      readArtifact: async path => path.includes('candidate-artifact') ? candidateBytes : rollbackBytes,
      snapshotArtifact: async path => ({ path, dispose: async () => {} }),
      readWatchState: async () => states.shift(),
      writeWatchHeartbeat: async () => {},
      writeRollbackCompletion: async () => {},
      run: async (command, args) => { events.push(`run:${command}:${args.join(',')}`) },
      launch: (command) => {
        events.push(`launch:${command}`)
        applicationLaunches += 1
        if (candidateStaysAlive && applicationLaunches === 1 && events.some(event => event.includes('candidate-artifact'))) alive.add(22)
        return processReference(applicationLaunches === 1 && events.some(event => event.includes('candidate-artifact')) ? 22 : 44)
      },
      mkdtemp: async prefix => `${prefix}stage`,
      readdir: async () => [{ name: 'Harness Desktop.app', isDirectory: () => true }],
      rename: async (from, to) => { events.push(`rename:${from}:${to}`) },
      copyFile: async (from, to) => { events.push(`copy:${from}:${to}`) },
      chmod: async (path, mode) => { events.push(`chmod:${path}:${String(mode)}`) },
      stat: async () => ({ isFile: () => true }),
      remove: async (path) => { events.push(`remove:${path}`) },
    },
  }
}

function processReference(
  processId: number,
  options: { readonly executablePath?: string; readonly linuxStartTicks?: string } = {},
): NativeProcessReference {
  return {
    processId,
    executablePath: options.executablePath ?? 'C:\\Harness Desktop\\harness-desktop.exe',
    startedBeforeMs: 1_700_000_000_000,
    ...(options.linuxStartTicks === undefined ? {} : { linuxStartTicks: options.linuxStartTicks }),
  }
}

function rollbackPlan(platform: NativeRollbackPlan['platform']): NativeRollbackPlan {
  if (platform === 'win32') {
    return {
      schemaVersion: 1,
      platform,
      parentProcess: processReference(11),
      applicationPath: 'C:\\Harness Desktop\\harness-desktop.exe',
      rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.exe',
      rollbackSha256,
      rollbackFormat: 'nsis',
      healthCheckTimeoutMs: 30_000,
    }
  }
  if (platform === 'darwin') {
    return {
      schemaVersion: 1,
      platform,
      parentProcess: processReference(11),
      applicationPath: 'C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop',
      rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.zip',
      rollbackSha256,
      rollbackFormat: 'zip',
      healthCheckTimeoutMs: 30_000,
    }
  }
  return {
    schemaVersion: 1,
    platform,
    parentProcess: processReference(11, { linuxStartTicks: '11' }),
    applicationPath: 'C:\\Applications\\harness-desktop',
    appImagePath: 'C:\\Applications\\Harness Desktop.AppImage',
    rollbackArtifactPath: 'C:\\private\\native-updates\\rollback\\candidate.AppImage',
    rollbackSha256,
    rollbackFormat: 'appimage',
    healthCheckTimeoutMs: 30_000,
  }
}

function watchPlan(): NativeUpdateWatchPlan {
  return {
    ...rollbackPlan('win32'),
    candidateArtifactPath: 'C:\\private\\native-updates\\candidate\\candidate-artifact.exe',
    candidateSha256,
    candidateFormat: 'nsis',
    journalPath: 'C:\\private\\native-updates\\pending-native-update.json',
    candidateVersion: '1.1.0',
    transactionId,
  }
}

function linuxWatchPlan(): NativeUpdateWatchPlan {
  return {
    ...rollbackPlan('linux'),
    candidateArtifactPath: 'C:\\private\\native-updates\\candidate\\candidate-artifact.AppImage',
    candidateSha256,
    candidateFormat: 'appimage',
    journalPath: 'C:\\private\\native-updates\\pending-native-update.json',
    candidateVersion: '1.1.0',
    transactionId,
  }
}

function macWatchPlan(): NativeUpdateWatchPlan {
  return {
    ...rollbackPlan('darwin'),
    candidateArtifactPath: 'C:\\private\\native-updates\\candidate\\candidate-artifact.zip',
    candidateSha256,
    candidateFormat: 'zip',
    journalPath: 'C:\\private\\native-updates\\pending-native-update.json',
    candidateVersion: '1.1.0',
    transactionId,
  }
}

function state(phase: NativeUpdateWatchState['phase'], additional: Partial<NativeUpdateWatchState> = {}): NativeUpdateWatchState {
  return { phase, version: '1.1.0', transactionId, ...additional }
}

function persistedWatchState(
  phase: NativeUpdateWatchState['phase'],
  additional: Partial<NativeUpdateWatchState> = {},
): unknown {
  return {
    schemaVersion: 1,
    transactionId,
    phase,
    currentVersion: '1.0.0',
    version: '1.1.0',
    channel: 'stable',
    format: 'nsis',
    sha256: candidateSha256,
    rollbackFormat: 'nsis',
    rollbackSha256,
    ...additional,
  }
}

describe('parseNativeUpdateWatchState', () => {
  it('accepts the retained candidate identity in an applied journal', () => {
    expect(parseNativeUpdateWatchState(persistedWatchState('applied', { candidateProcess: processReference(22) })))
      .toEqual(state('applied', { candidateProcess: processReference(22) }))
  })

  it('accepts a legacy applied journal without a candidate identity', () => {
    expect(parseNativeUpdateWatchState(persistedWatchState('applied'))).toEqual(state('applied'))
  })
})

describe('executeNativeRollback', () => {
  it('revalidates the cached Windows installer before silent restore and relaunch', async () => {
    const subject = fixture()

    await executeNativeRollback(rollbackPlan('win32'), subject.operations)

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('extracts the verified macOS zip beside the application before one atomic fixed-path replacement', async () => {
    const subject = fixture()

    await executeNativeRollback(rollbackPlan('darwin'), subject.operations)

    expect(subject.events[0]).toBe('run:/usr/bin/ditto:-x,-k,C:\\private\\native-updates\\rollback\\candidate.zip,C:\\Applications\\.harness-desktop-rollback-stage')
    expect(subject.events.some(event => event.startsWith('run:/usr/bin/osascript:-l,JavaScript,-e,'))).toBe(true)
    expect(subject.events.some(event => event.startsWith('rename:C:\\Applications\\Harness Desktop.app:'))).toBe(false)
    expect(subject.events).toContain('remove:C:\\Applications\\.harness-desktop-rollback-stage')
    expect(subject.events).toContain('launch:C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop')
  })

  it('copies and mode-repairs the verified Linux AppImage before atomic replacement', async () => {
    const subject = fixture()

    await executeNativeRollback(rollbackPlan('linux'), subject.operations)

    expect(subject.events.some(event => event.startsWith('copy:C:\\private\\native-updates\\rollback\\candidate.AppImage:C:\\Applications\\Harness Desktop.AppImage.rollback-'))).toBe(true)
    expect(subject.events.some(event => event.startsWith('chmod:C:\\Applications\\Harness Desktop.AppImage.rollback-'))).toBe(true)
    expect(subject.events).toContain('launch:C:\\Applications\\Harness Desktop.AppImage')
  })

  it('runs a private snapshot rather than reopening the verified rollback cache path', async () => {
    const subject = fixture()
    subject.operations.snapshotArtifact = async sourcePath => ({
      path: `${sourcePath}.worker-snapshot`,
      dispose: async () => { subject.events.push('dispose:rollback-snapshot') },
    })

    await executeNativeRollback(rollbackPlan('win32'), subject.operations)

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\rollback\\candidate.exe.worker-snapshot:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
      'dispose:rollback-snapshot',
    ])
  })

  it('force-terminates an identified Main process before applying a manual rollback', async () => {
    const subject = fixture()
    subject.alive.add(11)

    await executeNativeRollback(rollbackPlan('win32'), subject.operations)

    expect(subject.events).toEqual([
      'terminate:11',
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('fails closed before mutating installers when the identified Main process survives force termination', async () => {
    const subject = fixture(true, true, true)
    subject.alive.add(11)

    await expect(executeNativeRollback(rollbackPlan('win32'), subject.operations))
      .rejects.toThrow('did not exit before the safe handoff deadline')
    expect(subject.events).toEqual(['terminate:11', 'force-terminate:11'])
  })

  it('restores a missing macOS application destination directly from the retained rollback archive', async () => {
    const subject = fixture()
    subject.operations.run = async (command, args) => {
      subject.events.push(`run:${command}:${args.join(',')}`)
      if (command === '/usr/bin/osascript') {
        const error = new Error('destination absent') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    }
    subject.operations.rename = async (from, to) => {
      subject.events.push(`rename:${from}:${to}`)
    }

    await executeNativeRollback(rollbackPlan('darwin'), subject.operations)

    expect(subject.events.some(event => event.startsWith('rename:C:\\Applications\\.harness-desktop-rollback-stage\\Harness Desktop.app:C:\\Applications\\Harness Desktop.app'))).toBe(true)
    expect(subject.events).toContain('launch:C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop')
  })

  it('leaves the fixed macOS application path untouched when atomic replacement fails', async () => {
    const subject = fixture()
    const live = 'C:\\Applications\\Harness Desktop.app'
    subject.operations.run = async (command, args) => {
      subject.events.push(`run:${command}:${args.join(',')}`)
      if (command === '/usr/bin/osascript') throw new Error('atomic replacement failed')
    }
    subject.operations.rename = async (from, to) => {
      subject.events.push(`rename:${from}:${to}`)
      throw new Error('fixed destination exists')
    }

    await expect(executeNativeRollback(rollbackPlan('darwin'), subject.operations))
      .rejects.toThrow('could not replace the current macOS application')

    expect(subject.events.some(event => event.startsWith(`rename:${live}:`))).toBe(false)
  })
})

describe('prepareNativeRollbackArtifacts', () => {
  it('retains both installers before Main exits and never reopens the native cache while supervising', async () => {
    const subject = fixture()
    const disposed: string[] = []
    subject.operations.snapshotArtifact = async sourcePath => ({
      path: `${sourcePath}.ready-snapshot`,
      dispose: async () => { disposed.push(sourcePath) },
    })
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('dashboard-health-checking', { candidateProcess: processReference(22) }),
      state('applied', { candidateProcess: processReference(22) }),
    )

    const prepared = await prepareNativeRollbackArtifacts(watchPlan(), subject.operations)
    subject.operations.readArtifact = async () => { throw new Error('native cache was reopened after worker readiness') }

    await expect(superviseNativeUpdate(watchPlan(), subject.operations, prepared)).resolves.toBe('applied')
    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe.ready-snapshot:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])

    await prepared.dispose()
    expect(disposed).toEqual([
      'C:\\private\\native-updates\\rollback\\candidate.exe',
      'C:\\private\\native-updates\\candidate\\candidate-artifact.exe',
    ])
  })
})

describe('superviseNativeUpdate', () => {
  it('publishes a candidate-start heartbeat before it waits for Dashboard health', async () => {
    const subject = fixture()
    const heartbeats: Array<{ readonly path: string; readonly content: string }> = []
    subject.operations.writeWatchHeartbeat = async (path, content) => { heartbeats.push({ path, content }) }
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('dashboard-health-checking', { candidateProcess: processReference(22) }),
      state('applied', { candidateProcess: processReference(22) }),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).resolves.toBe('applied')

    expect(heartbeats).toHaveLength(1)
    expect(heartbeats[0]).toEqual(expect.objectContaining({
      path: 'C:\\private\\native-updates\\workers\\native-update-heartbeat-11111111-1111-4111-8111-111111111111.json',
      content: expect.stringMatching(/^11111111-1111-4111-8111-111111111111:\d+\n$/u) as unknown,
    }))
  })

  it('accepts an applied journal that atomically replaces checking for the launched candidate identity', async () => {
    const subject = fixture()
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('applied', { candidateProcess: processReference(22) }),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).resolves.toBe('applied')

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('rolls back an atomic applied transition from a different candidate identity', async () => {
    const subject = fixture()
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('applied', { candidateProcess: processReference(23) }),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).resolves.toBe('rolled-back')

    expect(subject.events).toContain('terminate:22')
    expect(subject.events.at(-2)).toBe('run:C:\\private\\native-updates\\rollback\\candidate.exe:/S')
  })

  it('relaunches the untouched stable macOS application when candidate publication is denied', async () => {
    const subject = fixture()
    subject.operations.run = async (command, args) => {
      subject.events.push(`run:${command}:${args.join(',')}`)
      if (command === '/usr/bin/osascript') throw new Error('candidate destination is not writable')
    }
    subject.states.push(state('awaiting-dashboard-health'), state('awaiting-dashboard-health'))

    await expect(superviseNativeUpdate(macWatchPlan(), subject.operations)).resolves.toBe('unchanged')

    expect(subject.events).toContain('launch:C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop')
    expect(subject.events.some(event => event.includes('rollback\\candidate.zip'))).toBe(false)
  })

  it('uses an atomic replacement again when the published candidate misses health', async () => {
    const subject = fixture()
    let atomicReplacements = 0
    subject.operations.run = async (command, args) => {
      subject.events.push(`run:${command}:${args.join(',')}`)
      if (command !== '/usr/bin/osascript') return
      atomicReplacements += 1
    }
    subject.states.push(state('awaiting-dashboard-health'), state('awaiting-dashboard-health'))

    await expect(superviseNativeUpdate(macWatchPlan(), subject.operations)).resolves.toBe('rolled-back')

    expect(subject.events.filter(event => event === 'launch:C:\\Applications\\Harness Desktop.app\\Contents\\MacOS\\harness-desktop')).toHaveLength(2)
    expect(atomicReplacements).toBe(2)
    expect(subject.events.some(event => event.includes('rollback\\candidate.zip'))).toBe(true)
  })

  it('accepts an AppImage candidate whose mounted Main executable differs from its outer launcher', async () => {
    const subject = fixture()
    const launcher = processReference(22, {
      executablePath: 'C:\\Applications\\Harness Desktop.AppImage',
      linuxStartTicks: '22',
    })
    const mountedMain = processReference(22, {
      executablePath: 'C:\\tmp\\.mount_Harness\\harness-desktop',
      linuxStartTicks: '22',
    })
    subject.operations.launch = (command) => {
      subject.events.push(`launch:${command}`)
      if (command.endsWith('.AppImage')) {
        subject.alive.add(22)
        return launcher
      }
      return processReference(44)
    }
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('dashboard-health-checking', { candidateProcess: mountedMain }),
      state('applied', { candidateProcess: mountedMain }),
    )

    await expect(superviseNativeUpdate(linuxWatchPlan(), subject.operations)).resolves.toBe('applied')

    expect(subject.events).toContain('launch:C:\\Applications\\Harness Desktop.AppImage')
    expect(subject.events.some(event => event.startsWith('terminate:'))).toBe(false)
  })

  it('rolls back an AppImage candidate whose reported kernel start token differs from the launched process', async () => {
    const subject = fixture()
    const launcher = processReference(22, {
      executablePath: 'C:\\Applications\\Harness Desktop.AppImage',
      linuxStartTicks: '22',
    })
    subject.operations.launch = (command) => {
      subject.events.push(`launch:${command}`)
      if (command.endsWith('.AppImage')) {
        subject.alive.add(22)
        return launcher
      }
      return processReference(44)
    }
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('dashboard-health-checking', {
        candidateProcess: processReference(22, {
          executablePath: 'C:\\tmp\\.mount_Harness\\harness-desktop',
          linuxStartTicks: '23',
        }),
      }),
    )

    await expect(superviseNativeUpdate(linuxWatchPlan(), subject.operations)).resolves.toBe('rolled-back')

    expect(subject.events).toContain('terminate:22')
    expect(subject.events.filter(event => event === 'launch:C:\\Applications\\Harness Desktop.AppImage')).toHaveLength(2)
  })

  it('refuses an AppImage transition before Main exits when the destination cannot hold a private same-volume probe', async () => {
    const subject = fixture()
    subject.operations.mkdtemp = async () => { throw new Error('read-only AppImage parent') }
    subject.states.push(state('awaiting-dashboard-health'))

    await expect(superviseNativeUpdate(linuxWatchPlan(), subject.operations)).rejects.toThrow('read-only AppImage parent')

    expect(subject.events).toEqual([])
  })

  it('refuses an AppImage transition before Main exits when its private probe cannot be renamed', async () => {
    const subject = fixture()
    subject.operations.rename = async (from, to) => {
      subject.events.push(`rename:${from}:${to}`)
      if (from.includes('.harness-desktop-update-probe-')) throw new Error('rename denied')
    }
    subject.states.push(state('awaiting-dashboard-health'))

    await expect(superviseNativeUpdate(linuxWatchPlan(), subject.operations)).rejects.toThrow('rename denied')

    expect(subject.events.some(event => event.includes('candidate-artifact.AppImage'))).toBe(true)
    expect(subject.events.some(event => event.startsWith('launch:'))).toBe(false)
  })

  it('leaves the stable installation in place when Main cannot exit before the safe handoff deadline', async () => {
    const subject = fixture()
    subject.alive.add(11)
    subject.states.push(state('awaiting-dashboard-health'))

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toEqual([])
  })

  it('rolls back when a candidate never reaches Main health reporting', async () => {
    const subject = fixture()
    const markerEvents: string[] = []
    subject.operations.writeRollbackCompletion = async (path, content) => {
      markerEvents.push(`marker:${path}:${content.trim()}`)
    }
    subject.operations.launch = (command) => {
      subject.events.push(`launch:${command}`)
      if (command.endsWith('harness-desktop.exe') && subject.events.some(event => event.includes('rollback\\candidate.exe'))) {
        expect(markerEvents).toEqual([
          'marker:C:\\private\\native-updates\\workers\\native-update-rolled-back-11111111-1111-4111-8111-111111111111.json:11111111-1111-4111-8111-111111111111',
        ])
      }
      if (subject.events.filter(event => event.startsWith('launch:')).length === 1) subject.alive.add(22)
      return processReference(subject.events.filter(event => event.startsWith('launch:')).length === 1 ? 22 : 44)
    }
    subject.states.push(...Array.from({ length: 302 }, () => state('awaiting-dashboard-health')))

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
      'terminate:22',
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
    expect(markerEvents).toHaveLength(1)
  })

  it('restores the stable installer when the launched candidate exits before its first health write', async () => {
    const subject = fixture(false)
    subject.states.push(state('awaiting-dashboard-health'), state('awaiting-dashboard-health'))

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('terminates an unhealthy candidate process before restoring the previous installer', async () => {
    const subject = fixture()
    subject.alive.add(22)
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      ...Array.from({ length: 300 }, () => state('dashboard-health-checking', { candidateProcess: processReference(22) })),
    )

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
      'terminate:22',
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('escalates a candidate that ignores graceful termination before restoring stable bytes', async () => {
    const subject = fixture(true, true)
    subject.alive.add(22)
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      ...Array.from({ length: 300 }, () => state('dashboard-health-checking', { candidateProcess: processReference(22) })),
    )

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toContain('terminate:22')
    expect(subject.events).toContain('force-terminate:22')
    expect(subject.events.at(-2)).toBe('run:C:\\private\\native-updates\\rollback\\candidate.exe:/S')
  })

  it('does not overwrite the stable installation when an unhealthy candidate survives bounded termination', async () => {
    const subject = fixture(true, true, true)
    subject.alive.add(22)
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      ...Array.from({ length: 300 }, () => state('dashboard-health-checking', { candidateProcess: processReference(22) })),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).rejects.toThrow('could not stop the unhealthy candidate')
    expect(subject.events).not.toContain('run:C:\\private\\native-updates\\rollback\\candidate.exe:/S')
  })

  it('accepts only a matching applied terminal journal state', async () => {
    const subject = fixture()
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('dashboard-health-checking', { candidateProcess: processReference(22) }),
      state('applied', { candidateProcess: processReference(22) }),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).resolves.toBe('applied')

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('does not install a candidate after a completed transaction is already recorded', async () => {
    const subject = fixture()
    subject.states.push(state('awaiting-dashboard-health'), state('applied', { candidateProcess: processReference(22) }))

    await superviseNativeUpdate(watchPlan(), subject.operations)

    expect(subject.events).toEqual([])
  })

  it('yields a manually scheduled rollback to its fresh worker', async () => {
    const subject = fixture()
    subject.states.push(
      state('awaiting-dashboard-health'),
      state('awaiting-dashboard-health'),
      state('rollback-scheduled', { candidateProcess: processReference(22) }),
    )

    await expect(superviseNativeUpdate(watchPlan(), subject.operations)).resolves.toBe('unchanged')

    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('restores the stable installation if its journal disappears after candidate launch', async () => {
    const subject = fixture()
    subject.states.push(state('awaiting-dashboard-health'), state('awaiting-dashboard-health'))

    await superviseNativeUpdate(watchPlan(), subject.operations)
    expect(subject.events).toEqual([
      'run:C:\\private\\native-updates\\candidate\\candidate-artifact.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
      'terminate:22',
      'run:C:\\private\\native-updates\\rollback\\candidate.exe:/S',
      'launch:C:\\Harness Desktop\\harness-desktop.exe',
    ])
  })

  it('rejects an unexpected watchdog field instead of widening worker authority', () => {
    expect(parseNativeUpdateWatchPlan({
      ...watchPlan(),
      command: 'powershell.exe',
    })).toBeUndefined()
  })
})
