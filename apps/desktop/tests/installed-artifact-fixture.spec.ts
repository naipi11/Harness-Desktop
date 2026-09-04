import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertIsolatedDpkgInstalled,
  isolatedDpkgInstallArguments,
  wrapPreparedArtifact,
} from './support/installed-artifact-fixture.ts'
import {
  cleanupPreparationRoots,
  isAppImageFuseUnavailable,
  launchAppImageWithFallback,
  rollbackWindowsPreparation,
  runInstalledArtifactCollection,
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

  it('cleans the launched Runtime root when verification fails before the sentinel write', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'harness-installed-runtime-unit-'))
    const harnessHome = join(runtimeRoot, 'home')
    const preparationRoot = await mkdtemp(join(tmpdir(), 'harness-installed-preparation-unit-'))
    await mkdir(harnessHome)
    try {
      const subject = wrapPreparedArtifact({
        name: 'fixture wrapper',
        executable: 'unused',
        cwd: preparationRoot,
        asar: 'unused',
        iconMember: 'unused',
        generatedIcon: 'unused',
        async launch() {
          return {
            runtime: { harnessHome },
            close: vi.fn(async () => {}),
          } as never
        },
        remove: vi.fn(async () => {}),
      })

      await expect(runInstalledArtifactLifecycle(subject, async () => {
        throw new Error('verification failed before sentinel')
      })).rejects.toThrow('verification failed before sentinel')
      expect(() => subject.sentinelPath).toThrow('sentinel was not written')
      await expect(access(runtimeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
      await rm(preparationRoot, { recursive: true, force: true })
    }
  })

  it('uses a prepared artifact custom cleanup owner for privileged roots', async () => {
    const preparationRoot = await mkdtemp(join(tmpdir(), 'harness-installed-privileged-unit-'))
    const cleanup = vi.fn(async () => {
      await rm(preparationRoot, { recursive: true, force: true })
    })
    const subject = wrapPreparedArtifact({
      name: 'privileged fixture wrapper',
      executable: 'unused',
      cwd: preparationRoot,
      asar: 'unused',
      iconMember: 'unused',
      generatedIcon: 'unused',
      remove: vi.fn(async () => {}),
      cleanup,
    })

    await subject.cleanup()

    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('isolated Deb configuration', () => {
  it('uses dpkg install and rejects unpack-only package state', () => {
    const args = isolatedDpkgInstallArguments('/tmp/harness-root', '/release/harness-desktop.deb')
    expect(args).toEqual([
      '--root=/tmp/harness-root',
      '--force-depends',
      '--install',
      '/release/harness-desktop.deb',
    ])
    expect(args).not.toContain('--unpack')
    expect(() => { assertIsolatedDpkgInstalled('unpacked') }).toThrow('package status is unpacked, expected installed')
    expect(() => { assertIsolatedDpkgInstalled('installed') }).not.toThrow()
  })
})

describe('prepared artifact collection lifecycle', () => {
  it('removes and cleans every unvisited artifact when the first lifecycle fails', async () => {
    const secondRemove = vi.fn(async () => {})
    const secondCleanup = vi.fn(async () => {})
    const secondLaunch = vi.fn(async () => ({ close: vi.fn(async () => {}) }))
    const first = artifact({ launch: vi.fn(async () => { throw new Error('first launch failed') }) })
    const second = artifact({ launch: secondLaunch, remove: secondRemove, cleanup: secondCleanup })

    await expect(runInstalledArtifactCollection([first, second], async () => {})).rejects.toThrow('first launch failed')
    expect(secondRemove).toHaveBeenCalledOnce()
    expect(secondCleanup).toHaveBeenCalledOnce()
    expect(secondLaunch).not.toHaveBeenCalled()
  })

  it('aggregates unvisited removal and cleanup failures with the first lifecycle failure', async () => {
    const first = artifact({ launch: vi.fn(async () => { throw new Error('first failed') }) })
    const second = artifact({
      remove: vi.fn(async () => { throw new Error('second remove failed') }),
      cleanup: vi.fn(async () => { throw new Error('second cleanup failed') }),
    })

    await expect(runInstalledArtifactCollection([first, second], async () => {})).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'first failed' }),
        expect.objectContaining({ message: 'second remove failed' }),
        expect.objectContaining({ message: 'second cleanup failed' }),
      ],
    })
  })
})

describe('native artifact preparation cleanup', () => {
  it('attempts every owned root and retains the preparation failure', async () => {
    const firstRoot = vi.fn(async () => { throw new Error('AppImage root cleanup failed') })
    const secondRoot = vi.fn(async () => {})

    await expect(cleanupPreparationRoots(
      new Error('Deb preparation failed'),
      [firstRoot, secondRoot],
    )).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'Deb preparation failed' }),
        expect.objectContaining({ message: 'AppImage root cleanup failed' }),
      ],
    })
    expect(firstRoot).toHaveBeenCalledOnce()
    expect(secondRoot).toHaveBeenCalledOnce()
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
      uninstallerRequired: true,
      async findUninstaller() { calls.push('find'); return 'Uninstall Harness Desktop.exe' },
      async runUninstaller(path) { calls.push(`run:${path}`) },
      async waitForRemoval() { calls.push('wait') },
      async removeRoot() { calls.push('rm') },
    })).rejects.toThrow('installed ASAR is missing')
    expect(calls).toEqual(['find', 'run:Uninstall Harness Desktop.exe', 'wait', 'rm'])
  })

  it('aggregates rollback cleanup failure with the validation failure', async () => {
    const result = rollbackWindowsPreparation(new Error('installed executable is missing'), {
      uninstallerRequired: true,
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

  it('runs a generated uninstaller found after a nonzero installer exit', async () => {
    const calls: string[] = []

    await expect(rollbackWindowsPreparation(new Error('NSIS exited 1'), {
      uninstallerRequired: false,
      async findUninstaller() { calls.push('find'); return 'partial-uninstaller.exe' },
      async runUninstaller(path) { calls.push(`run:${path}`) },
      async waitForRemoval() { calls.push('wait') },
      async removeRoot() { calls.push('rm') },
    })).rejects.toThrow('NSIS exited 1')
    expect(calls).toEqual(['find', 'run:partial-uninstaller.exe', 'wait', 'rm'])
  })

  it('allows a true no-install failure with no generated uninstaller', async () => {
    const primary = new Error('NSIS could not start')

    await expect(rollbackWindowsPreparation(primary, {
      uninstallerRequired: false,
      async findUninstaller() { return undefined },
      async runUninstaller() { throw new Error('must not run') },
      async waitForRemoval() { throw new Error('must not wait') },
      async removeRoot() {},
    })).rejects.toBe(primary)
  })
})
