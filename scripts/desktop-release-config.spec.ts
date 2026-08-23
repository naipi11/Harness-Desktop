import { describe, expect, it } from 'vitest'
import { productMetadata } from '../packages/boot/app-boot/src/product-metadata.ts'
import {
  collectDesktopReleaseViolations,
  readDesktopReleaseFiles,
  type DesktopBuilderConfig,
  type DesktopReleaseFiles,
} from './desktop-release-config.ts'

function conformingBuilderConfig(): DesktopBuilderConfig {
  return {
    appId: productMetadata.appId,
    productName: productMetadata.productName,
    executableName: 'harness-desktop',
    directories: { output: 'release' },
    files: ['out/**', 'package.json', 'resources/icons/**'],
    asar: true,
    publish: null,
    win: { target: ['nsis'], icon: 'resources/icons/win/harness-desktop.ico' },
    mac: {
      target: [{ target: 'dmg', arch: ['universal'] }],
      icon: 'resources/icons/mac/harness-desktop.icns',
      category: 'public.app-category.developer-tools',
    },
    linux: {
      target: ['AppImage', 'deb'],
      icon: 'resources/icons/linux/harness-desktop-512.png',
      category: 'Development',
    },
  }
}

function conformingFiles(): DesktopReleaseFiles {
  return {
    builderConfig: conformingBuilderConfig(),
    desktopManifest: JSON.stringify({
      scripts: {
        package: 'electron-builder --config electron-builder.config.mjs --publish never',
        'package:dir': 'electron-builder --dir --config electron-builder.config.mjs --publish never',
      },
    }),
    desktopArtifactsWorkflow: [
      '--publish never',
      'windows-2025',
      'macos-15',
      'ubuntu-24.04',
    ].join('\n'),
    releaseWorkflow: 'name: Release dsh (legacy pack audit)',
  }
}

describe('desktop release config gate', () => {
  it('accepts the conforming builder, manifest, and workflows', () => {
    expect(collectDesktopReleaseViolations(conformingFiles())).toEqual([])
  })

  it('reports one diagnostic for every missing or mismatched requirement', () => {
    expect(collectDesktopReleaseViolations({
      builderConfig: {
        appId: '',
        productName: '',
        executableName: '',
        directories: { output: '' },
        files: [],
        asar: false,
        publish: { provider: 'github' },
        win: { target: [] },
        mac: { target: [], category: '' },
        linux: { target: [], category: '' },
      },
      desktopManifest: '{}',
      desktopArtifactsWorkflow: 'NODE_AUTH_TOKEN release:publish gh release',
      releaseWorkflow: 'release:publish NODE_AUTH_TOKEN inputs.publish',
    })).toEqual([
      'builderConfig.appId: expected ' + JSON.stringify(productMetadata.appId),
      'builderConfig.productName: expected ' + JSON.stringify(productMetadata.productName),
      'builderConfig.executableName: expected "harness-desktop"',
      'builderConfig.directories.output: expected "release"',
      'builderConfig.files: expected "out/**"',
      'builderConfig.files: expected "package.json"',
      'builderConfig.files: expected "resources/icons/**"',
      'builderConfig.asar: expected true',
      'builderConfig.publish: expected null',
      'builderConfig.win.target: expected "nsis"',
      'builderConfig.win.icon: expected apps/desktop/resources/icons/win/harness-desktop.ico',
      'builderConfig.mac.target: expected "dmg" for arch "universal"',
      'builderConfig.mac.icon: expected apps/desktop/resources/icons/mac/harness-desktop.icns',
      'builderConfig.mac.category: expected "public.app-category.developer-tools"',
      'builderConfig.linux.target: expected "AppImage"',
      'builderConfig.linux.target: expected "deb"',
      'builderConfig.linux.icon: expected apps/desktop/resources/icons/linux/harness-desktop-512.png',
      'builderConfig.linux.category: expected "Development"',
      'desktopManifest: script "package" must pass --publish never',
      'desktopManifest: script "package" must load the electron-builder config explicitly',
      'desktopManifest: script "package:dir" must pass --publish never',
      'desktopManifest: script "package:dir" must load the electron-builder config explicitly',
      'desktopArtifactsWorkflow: missing --publish never',
      'desktopArtifactsWorkflow: missing runner windows-2025',
      'desktopArtifactsWorkflow: missing runner macos-15',
      'desktopArtifactsWorkflow: missing runner ubuntu-24.04',
      'desktopArtifactsWorkflow: forbidden publish marker NODE_AUTH_TOKEN',
      'desktopArtifactsWorkflow: forbidden publish marker release:publish',
      'desktopArtifactsWorkflow: forbidden publish marker gh release',
      'releaseWorkflow: forbidden publish marker NODE_AUTH_TOKEN',
      'releaseWorkflow: forbidden publish marker release:publish',
      'releaseWorkflow: forbidden publish marker inputs.publish',
    ])
  })

  it('reports an icon outside the generated desktop asset directory', () => {
    const builderConfig = conformingBuilderConfig()
    const violations = collectDesktopReleaseViolations({
      ...conformingFiles(),
      builderConfig: {
        ...builderConfig,
        win: { ...builderConfig.win, icon: 'assets/deepseek.ico' },
      },
    })

    expect(violations).toContain(
      'builderConfig.win.icon: expected apps/desktop/resources/icons/win/harness-desktop.ico',
    )
  })

  it('accepts the repository-owned builder, manifest, and workflows', async () => {
    const files = await readDesktopReleaseFiles()
    expect(collectDesktopReleaseViolations(files)).toEqual([])
    expect(files.desktopArtifactsWorkflow).toContain('dist/cli-standalone')
    expect(files.desktopArtifactsWorkflow).not.toContain('apps/desktop/test-results')
  })
})
