import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyDesktopArtifactsWithTools,
  type DesktopArtifactTools,
} from '../../../scripts/release/verify-desktop-artifacts.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function releaseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-packaged-artifacts-'))
  roots.push(root)
  return root
}

async function file(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'fixture')
}

function tools(overrides: Partial<DesktopArtifactTools> = {}): DesktopArtifactTools {
  return {
    inspectWindowsInstaller: async () => ['$PLUGINSDIR', 'app-64.7z'],
    inspectAsar: async () => ['resources/icons/win/harness-desktop.ico'],
    inspectMacDmg: async () => ({
      entries: ['Harness Desktop.app/Contents/Resources/harness-desktop.icns'],
      lipoInfo: 'Architectures in the fat file: harness-desktop are: x86_64 arm64',
    }),
    inspectAppImage: async () => ['usr/share/icons/hicolor/512x512/apps/harness-desktop.png'],
    inspectDeb: async () => ['usr/share/icons/hicolor/512x512/apps/harness-desktop.png'],
    ...overrides,
  }
}

describe('verifyDesktopArtifactsWithTools', () => {
  it('accepts the exact Windows NSIS, unpacked executable, asar, and generated icon resources', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await file(join(root, 'win-unpacked', 'resources', 'app.asar'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools()))
      .resolves.toEqual([])
  })

  it('reports a missing Windows installer and generated icon independently', async () => {
    const root = await releaseRoot()
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await file(join(root, 'win-unpacked', 'resources', 'app.asar'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectAsar: async () => [],
    }))).resolves.toEqual([
      'desktop artifact: missing Windows NSIS installer',
      'desktop artifact: missing generated Windows icon',
    ])
  })

  it('requires the macOS universal DMG binary to carry both architectures and the generated icon', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0-universal.dmg'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'darwin', releaseDirectory: root }, tools({
      inspectMacDmg: async () => ({
        entries: ['Harness Desktop.app/Contents/Resources/harness-desktop.icns'],
        lipoInfo: 'Non-fat file: harness-desktop is architecture: arm64',
      }),
    }))).resolves.toEqual([
      'desktop artifact: macOS application binary is missing x86_64 architecture',
    ])
  })

  it('requires both Linux package formats and their generated icon resource', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectAppImage: async () => [],
    }))).resolves.toEqual([
      'desktop artifact: missing Linux Deb installer',
      'desktop artifact: missing generated Linux AppImage icon',
    ])
  })

  it('requires the generated icon independently in both Linux package formats', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.0_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectAppImage: async () => ['usr/share/icons/hicolor/512x512/apps/harness-desktop.png'],
      inspectDeb: async () => [],
    }))).resolves.toEqual([
      'desktop artifact: missing generated Linux Deb icon',
    ])
  })
})
