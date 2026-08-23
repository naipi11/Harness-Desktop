import { describe, expect, it, vi } from 'vitest'
import {
  isAppImageFuseUnavailable,
  runInstalledArtifactLifecycle,
  type InstalledDesktopArtifact,
} from './support/installed-artifact-fixture.ts'

function artifact(overrides: Partial<InstalledDesktopArtifact> = {}): InstalledDesktopArtifact {
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
})
