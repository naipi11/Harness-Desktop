import { describe, expect, it, vi } from 'vitest'
import {
  isAppImageFuseUnavailable,
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  runInstalledArtifactLifecycle,
  type InstalledArtifactLifecycle,
} from './support/installed-artifact-lifecycle.ts'

interface FixtureLifecycle extends InstalledArtifactLifecycle {
  writeSentinel(harnessHome: string): Promise<void>
  verifyGeneratedIcon(): Promise<void>
}

function artifact(overrides: Partial<FixtureLifecycle> = {}): FixtureLifecycle {
  return {
    name: 'fixture',
    sentinelPath: 'sentinel',
    launch: vi.fn(async () => ({
      close: vi.fn(async () => {}),
    } as never)),
    writeSentinel: vi.fn(async () => {}),
    verifyGeneratedIcon: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('runInstalledArtifactLifecycle', () => {
  it('removes and cleans a prepared artifact when native launch fails', async () => {
    const remove = vi.fn(async () => {})
    const cleanup = vi.fn(async () => {})
    const subject = artifact({ launch: vi.fn(async () => { throw new Error('launch failed') }), remove, cleanup })

    await expect(runInstalledArtifactLifecycle(subject, async () => {})).rejects.toThrow('launch failed')
    expect(remove).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('closes, removes, and cleans when authenticated verification fails', async () => {
    const close = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    const cleanup = vi.fn(async () => {})
    const subject = artifact({ launch: vi.fn(async () => ({ close } as never)), remove, cleanup })

    await expect(runInstalledArtifactLifecycle(subject, async () => {
      throw new Error('verification failed')
    })).rejects.toThrow('verification failed')
    expect(close).toHaveBeenCalledWith({ preserveRuntimeRoot: true })
    expect(remove).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('still cleans when native removal fails', async () => {
    const cleanup = vi.fn(async () => {})
    const subject = artifact({ remove: vi.fn(async () => { throw new Error('remove failed') }), cleanup })

    await expect(runInstalledArtifactLifecycle(subject, async () => {})).rejects.toThrow('remove failed')
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('AppImage native launch fallback', () => {
  it('allows extraction fallback only for a reported FUSE mount failure', () => {
    expect(isAppImageFuseUnavailable(new Error('dlopen(): error loading libfuse.so.2'))).toBe(true)
    expect(isAppImageFuseUnavailable(new Error('Dashboard boot failed'))).toBe(false)
  })

  it('launches extracted AppRun only after a FUSE-specific native failure', async () => {
    const fixture = { kind: 'fixture' }
    const launch = vi.fn(async (path: string) => {
      if (path === '/release/Harness.AppImage') throw new Error('dlopen(): error loading libfuse.so.2')
      return fixture
    })

    await expect(launchAppImageWithFallback('/release/Harness.AppImage', '/tmp/squashfs-root/AppRun', launch)).resolves.toBe(fixture)
    expect(launch.mock.calls.map(([path]) => path)).toEqual([
      '/release/Harness.AppImage',
      '/tmp/squashfs-root/AppRun',
    ])
  })

  it('does not fall back for an unrelated AppImage launch failure', async () => {
    const launch = vi.fn(async () => { throw new Error('Dashboard boot failed') })

    await expect(launchAppImageWithFallback('/release/Harness.AppImage', '/tmp/squashfs-root/AppRun', launch)).rejects.toThrow('Dashboard boot failed')
    expect(launch).toHaveBeenCalledOnce()
  })
})

describe('Windows preparation rollback', () => {
  it('runs the generated uninstaller, waits for removal, then removes the temporary root', async () => {
    const calls: string[] = []

    await expect(rollbackWindowsPreparation(new Error('installed ASAR is missing'), {
      async findUninstaller() { calls.push('find'); return 'Uninstall Harness Desktop.exe' },
      async runUninstaller(path) { calls.push(`run:${path}`) },
      async waitForRemoval() { calls.push('wait') },
      async removeRoot() { calls.push('rm') },
    })).rejects.toThrow('installed ASAR is missing')
    expect(calls).toEqual(['find', 'run:Uninstall Harness Desktop.exe', 'wait', 'rm'])
  })

  it('aggregates rollback cleanup failure with the validation failure', async () => {
    const result = rollbackWindowsPreparation(new Error('installed executable is missing'), {
      async findUninstaller() { return 'uninstaller.exe' },
      async runUninstaller() { throw new Error('uninstall failed') },
      async waitForRemoval() {},
      async removeRoot() { throw new Error('root cleanup failed') },
    })
    await expect(result).rejects.toBeInstanceOf(AggregateError)
    await expect(result).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'installed executable is missing' }),
        expect.objectContaining({ message: 'uninstall failed' }),
        expect.objectContaining({ message: 'root cleanup failed' }),
      ],
    })
  })
})
