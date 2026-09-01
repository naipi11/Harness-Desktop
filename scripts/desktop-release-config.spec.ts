import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { productMetadata } from '../packages/boot/app-boot/src/product-metadata.ts'
import {
  collectDesktopReleaseViolations,
  readDesktopReleaseFiles,
  type DesktopBuilderConfig,
  type DesktopReleaseFiles,
} from './desktop-release-config.ts'

const temporaryRoots: string[] = []
const builderConfigUrl = pathToFileURL(resolve(import.meta.dirname, '../apps/desktop/electron-builder.config.mjs')).href

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function loadBuilderConfig(environment: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment }
  delete env.DSH_DESKTOP_UPDATE_POLICY
  if (environment.DSH_DESKTOP_UPDATE_POLICY !== undefined) {
    env.DSH_DESKTOP_UPDATE_POLICY = environment.DSH_DESKTOP_UPDATE_POLICY
  }
  const { stdout } = await execa(process.execPath, [
    '--input-type=module',
    '--eval',
    `const { default: config } = await import(${JSON.stringify(builderConfigUrl)}); process.stdout.write(JSON.stringify(config))`,
  ], { cwd: resolve(import.meta.dirname, '..'), env })
  return JSON.parse(stdout) as Record<string, unknown>
}

async function releasePolicy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-desktop-release-policy-'))
  temporaryRoots.push(root)
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const path = join(root, 'update-policy.json')
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 3,
    applicationId: productMetadata.appId,
    trust: { allowedOrigins: ['https://updates.example.invalid'], publicKeys: { 'release-test': publicKey } },
    healthCheckTimeoutMs: 120_000,
    nativeWorkerReadyTimeoutMs: 300_000,
    manifestEndpoints: { 'stable/desktop/win32/x64/nsis': 'https://updates.example.invalid/stable/desktop/win32-x64.json' },
    rollbackManifestEndpoints: { 'stable/desktop/win32/x64/nsis/1.0.0': 'https://updates.example.invalid/stable/desktop/win32-x64-rollback.json' },
  })}\n`)
  return path
}

function conformingBuilderConfig(): DesktopBuilderConfig {
  const config = {
    appId: productMetadata.appId,
    productName: productMetadata.productName,
    executableName: 'harness-desktop',
    directories: { output: 'release' },
    files: ['out/**', 'package.json', 'resources/icons/**'],
    extraResources: [
      { from: 'resources/update/windows-native-rollback-worker.ps1', to: 'windows-native-rollback-worker.ps1' },
      { from: 'out/main/native-rollback-worker.js', to: 'native-rollback-worker.js' },
      { from: 'out/main/chunks', to: 'chunks' },
    ],
    asar: true,
    forceCodeSigning: false,
    publish: null,
    win: {
      target: ['nsis'],
      icon: 'resources/icons/win/harness-desktop.ico',
      signExecutable: false,
      extraResources: [{
        from: 'out/native/win32-x64',
        to: '.',
        filter: ['windows-native-update-supervisor.exe'],
      }],
    },
    mac: {
      target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
      icon: 'resources/icons/mac/harness-desktop.icns',
      category: 'public.app-category.developer-tools',
      identity: null,
    },
    linux: {
      target: ['AppImage', 'deb'],
      icon: 'resources/icons/linux/harness-desktop-512.png',
      category: 'Development',
    },
  }
  return config
}

interface InstalledFileMatcher {
  readonly from: string
  readonly to: string
  readonly patterns: readonly string[]
}

interface InstalledFileMatcherModule {
  getFileMatchers(
    config: Record<string, unknown>,
    name: 'extraResources',
    defaultDestination: string,
    options: {
      readonly defaultSrc: string
      readonly globalOutDir: string
      readonly macroExpander: (value: string) => string
      readonly customBuildOptions: Record<string, unknown>
    },
  ): InstalledFileMatcher[] | null
  copyFiles(
    matchers: readonly InstalledFileMatcher[] | null,
    transformer: (source: string) => unknown,
    isUseHardLink?: boolean,
  ): Promise<void>
}

interface InstalledBuilderFsModule {
  readonly CopyFileTransformer: new (
    afterCopy: (destination: string) => Promise<boolean>,
  ) => unknown
}

async function probeExtraResourceCopy(
  extraResources: readonly Record<string, unknown>[],
): Promise<{
  readonly matcher: InstalledFileMatcher
  readonly destinationEntries: readonly string[]
  readonly transformed: readonly string[]
  readonly afterCopy: readonly string[]
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'harness-extra-resource-probe-'))
  temporaryRoots.push(projectRoot)
  const nativeRoot = join(projectRoot, 'out', 'native', 'win32-x64')
  const resourceRoot = join(projectRoot, 'app', 'resources')
  await mkdir(nativeRoot, { recursive: true })
  await Promise.all([
    writeFile(join(nativeRoot, 'windows-native-update-supervisor.exe'), 'exe'),
    writeFile(join(nativeRoot, 'windows-native-update-supervisor.obj'), 'obj'),
    writeFile(join(nativeRoot, 'unrelated.exe'), 'other'),
    writeFile(join(nativeRoot, '.private'), 'dot'),
  ])

  const requireFromDesktop = createRequire(resolve(import.meta.dirname, '../apps/desktop/package.json'))
  const fileMatcherModule = await import(pathToFileURL(
    requireFromDesktop.resolve('app-builder-lib/out/fileMatcher.js'),
  ).href) as InstalledFileMatcherModule
  const builderFsModule = await import(pathToFileURL(
    requireFromDesktop.resolve('builder-util/out/fs.js'),
  ).href) as InstalledBuilderFsModule
  const matchers = fileMatcherModule.getFileMatchers({}, 'extraResources', resourceRoot, {
    defaultSrc: projectRoot,
    globalOutDir: join(projectRoot, 'release'),
    macroExpander: value => value,
    customBuildOptions: { extraResources },
  })
  const matcher = matchers?.[0]
  if (matcher === undefined) throw new Error('probe did not resolve an extraResources matcher')
  const transformed: string[] = []
  const afterCopy: string[] = []
  await fileMatcherModule.copyFiles(matchers, (source) => {
    transformed.push(relative(projectRoot, source))
    return new builderFsModule.CopyFileTransformer(async (destination) => {
      afterCopy.push(relative(projectRoot, destination))
      return true
    })
  }, false)
  return {
    matcher,
    destinationEntries: await readdir(resourceRoot),
    transformed,
    afterCopy,
  }
}

function conformingFiles(): DesktopReleaseFiles {
  return {
    builderConfig: conformingBuilderConfig(),
    desktopManifest: JSON.stringify({
      scripts: {
        prepackage: 'pnpm --dir ../.. run verify:icons && pnpm --dir ../.. run verify:desktop-runtime-closure && pnpm --dir ../.. run prepare:desktop-native',
        package: 'electron-builder --config electron-builder.config.mjs --publish never',
        'prepackage:dir': 'pnpm --dir ../.. run verify:icons && pnpm --dir ../.. run verify:desktop-runtime-closure && pnpm --dir ../.. run prepare:desktop-native',
        'package:dir': 'electron-builder --dir --config electron-builder.config.mjs --publish never',
      },
    }),
    desktopArtifactVerifier: "execa('lipo', ['-info'])",
    desktopArtifactsWorkflow: `
name: Desktop artifacts
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
env:
  DSH_UPDATE_SNAPSHOT_ROOT: dist/ci-update-snapshots
jobs:
  package:
    strategy:
      matrix:
        include:
          - os: windows-2025
            label: windows-nsis
            desktop-formats: nsis
            cli-format: zip
            cli-artifact: dist/cli-standalone/harness-cli-*.zip
          - os: macos-15
            label: macos-universal-dmg-zip
            desktop-formats: dmg-zip-universal
            cli-format: tar.gz
            cli-artifact: dist/cli-standalone/harness-cli-*.tar.gz
            cli-architectures: arm64,x64
          - os: ubuntu-24.04
            label: linux-appimage-deb
            desktop-formats: appimage-deb
            cli-format: tar.gz
            cli-artifact: dist/cli-standalone/harness-cli-*.tar.gz
    steps:
      - name: Configure pnpm store path
        shell: bash
        run: pnpm store path
      - name: Verify pinned Node distribution checksum
        id: node-runtime
        run: pnpm exec tsx scripts/release/verify-node-runtime-archive.ts
      - name: Generate ephemeral public update policy
        run: |
          pnpm exec tsx scripts/release/create-ephemeral-update-policy.ts
          echo "DSH_UPDATE_POLICY=\${DSH_UPDATE_POLICY_OUTPUT}" >> "\$GITHUB_ENV"
          echo "DSH_DESKTOP_UPDATE_POLICY=\${DSH_UPDATE_POLICY_OUTPUT}" >> "\$GITHUB_ENV"
      - name: Build repository and Desktop app
        run: pnpm run build
      - name: Package installer
        id: package
        run: pnpm --filter @harness-desktop/dsh-desktop run package --publish never
      - name: Inspect native Desktop artifacts
        id: desktop-artifacts
        run: pnpm run release:verify-desktop-artifacts
      - name: Test Desktop updater and rollback
        id: desktop-updater
        run: pnpm run desktop:test-updater
      - name: Verify packed CLI from an empty offline prefix
        id: packed-cli
        env:
          DSH_REQUIRE_BUILT_CLI_SMOKE: '1'
        run: pnpm run release:verify-packed-cli
      - name: Build standalone CLI archives
        id: build-cli
        shell: bash
        run: |
          if [[ "\${RUNNER_OS}" == "macOS" ]]; then
            for arch in arm64 x64; do
              DSH_CLI_STANDALONE_PLATFORM=darwin DSH_CLI_STANDALONE_ARCH="\${arch}" pnpm run release:build-cli-standalone
            done
          else
            pnpm run release:build-cli-standalone
          fi
      - name: Verify standalone CLI archives
        id: verify-cli
        shell: bash
        run: |
          if [[ "\${RUNNER_OS}" == "macOS" ]]; then
            for arch in arm64 x64; do
              DSH_CLI_STANDALONE_PLATFORM=darwin DSH_CLI_STANDALONE_ARCH="\${arch}" pnpm run release:verify-cli-standalone
            done
          else
            pnpm run release:verify-cli-standalone
          fi
      - name: Verify update manifests with ephemeral fixtures
        id: update-manifests
        run: pnpm run release:verify-update-manifests
      - name: Sign and verify manifests for this row's produced artifacts
        id: produced-update-manifests
        run: pnpm run release:verify-produced-update-manifests
      - name: Test CLI updater and rollback
        id: cli-updater
        run: pnpm run release:test-cli-update
      - name: Smoke installed Desktop artifacts
        id: installed-desktop
        run: pnpm run release:smoke-installed-desktop
      - name: Exercise actual installed native update and rollback
        id: native-update-rollback
        env:
          DSH_RUN_NATIVE_UPDATE_E2E: '1'
        run: pnpm --dir apps/desktop run test:e2e:native-update
      - name: Write redacted native release evidence
        id: release-evidence
        if: \${{ always() }}
        env:
          DSH_RELEASE_MATRIX_LABEL: \${{ matrix.label }}
          DSH_RELEASE_CLI_FORMAT: \${{ matrix.cli-format }}
          DSH_RELEASE_CHECK_NODE_RUNTIME: \${{ steps.node-runtime.outcome }}
          DSH_RELEASE_CHECK_DESKTOP_ARTIFACTS: \${{ steps.package.outcome == 'success' && steps.desktop-artifacts.outcome || steps.package.outcome }}
          DSH_RELEASE_CHECK_DESKTOP_UPDATER: \${{ steps.desktop-updater.outcome }}
          DSH_RELEASE_CHECK_PACKED_CLI: \${{ steps.packed-cli.outcome }}
          DSH_RELEASE_CHECK_CLI_ARCHIVES: \${{ steps.build-cli.outcome == 'success' && steps.verify-cli.outcome || steps.build-cli.outcome }}
          DSH_RELEASE_CHECK_UPDATE_MANIFESTS: \${{ steps.update-manifests.outcome }}
          DSH_RELEASE_CHECK_PRODUCED_UPDATE_MANIFESTS: \${{ steps.produced-update-manifests.outcome }}
          DSH_RELEASE_CHECK_CLI_UPDATER: \${{ steps.cli-updater.outcome }}
          DSH_RELEASE_CHECK_INSTALLED_DESKTOP: \${{ steps.installed-desktop.outcome }}
          DSH_RELEASE_CHECK_NATIVE_UPDATE_ROLLBACK: \${{ steps.native-update-rollback.outcome }}
        run: pnpm exec tsx scripts/release/collect-release-evidence.ts
      - name: Upload native release artifacts
        if: \${{ success() }}
        uses: actions/upload-artifact@v4
        with:
          name: harness-desktop-\${{ matrix.label }}
          path: |
            \${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/artifacts/*
          if-no-files-found: error
      - name: Upload redacted native release evidence
        if: \${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: harness-release-evidence-\${{ matrix.label }}
          path: |
            dist/release-logs/release-evidence.json
            \${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/manifests/ready/*.json
            \${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/bindings.json
          if-no-files-found: error
`,
    releaseCandidatesWorkflow: `
name: Release candidate preflight
on:
  workflow_dispatch:
    inputs:
      sign-windows: { type: boolean, default: false }
      notarize-macos: { type: boolean, default: false }
      sign-update-manifests: { type: boolean, default: false }
      publish-npm: { type: boolean, default: false }
      create-github-release: { type: boolean, default: false }
permissions: {}
jobs:
  preflight:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - name: Require exactly one candidate operation
        env:
          SIGN_WINDOWS: \${{ inputs['sign-windows'] }}
          NOTARIZE_MACOS: \${{ inputs['notarize-macos'] }}
          SIGN_UPDATE_MANIFESTS: \${{ inputs['sign-update-manifests'] }}
          PUBLISH_NPM: \${{ inputs['publish-npm'] }}
          CREATE_GITHUB_RELEASE: \${{ inputs['create-github-release'] }}
        run: node scripts/release/select-release-candidate-operation.mjs
`,
    releaseWorkflow: 'name: Release dsh (legacy pack audit)',
  }
}

describe('desktop release config gate', () => {
  it('requires an embedded public policy before a release-mode build may discover signing identities', async () => {
    await expect(loadBuilderConfig({ DSH_DESKTOP_SIGNING_MODE: 'release' }))
      .rejects.toThrow('DSH_DESKTOP_UPDATE_POLICY is required when DSH_DESKTOP_SIGNING_MODE=release')

    const config = await loadBuilderConfig({
      DSH_DESKTOP_SIGNING_MODE: 'release',
      DSH_DESKTOP_UPDATE_POLICY: await releasePolicy(),
    })
    expect((config.win as Record<string, unknown>).signExecutable).toBeUndefined()
    expect((config.win as Record<string, unknown>).extraResources).toEqual([{
      from: 'out/native/win32-x64',
      to: '.',
      filter: ['windows-native-update-supervisor.exe'],
    }])
    expect((config.mac as Record<string, unknown>).identity).toBeUndefined()
    expect(config.forceCodeSigning).toBe(true)
    expect(config.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'update-policy.json' }),
    ]))
    expect(config.extraResources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ to: 'windows-native-update-supervisor.exe' }),
    ]))
  })

  it('accepts the conforming builder, manifest, and workflows', () => {
    expect(collectDesktopReleaseViolations(conformingFiles())).toEqual([])
  })

  it('requires both Desktop package entry points to prepare native artifacts even when the workflow builds them', () => {
    const files = conformingFiles()
    const desktopManifest = JSON.parse(files.desktopManifest) as { scripts: Record<string, string> }
    delete desktopManifest.scripts.prepackage
    delete desktopManifest.scripts['prepackage:dir']
    const desktopArtifactsWorkflow = files.desktopArtifactsWorkflow.replace(
      '      - name: Package installer',
      "      - name: Build Windows native update supervisor\n        if: ${{ runner.os == 'Windows' }}\n        run: pnpm run build:windows-native-update-supervisor\n      - name: Package installer",
    )

    expect(collectDesktopReleaseViolations({
      ...files,
      desktopManifest: JSON.stringify(desktopManifest),
      desktopArtifactsWorkflow,
    })).toEqual(expect.arrayContaining([
      'desktopManifest: script "prepackage" must run the cross-platform Desktop native prepare command',
      'desktopManifest: script "prepackage:dir" must run the cross-platform Desktop native prepare command',
    ]))
  })

  it('uses the pinned directory traversal for only the supervisor EXE while the old direct file bypasses it', async () => {
    const config = await loadBuilderConfig({ DSH_DESKTOP_SIGNING_MODE: 'disabled' })
    const win = config.win
    if (typeof win !== 'object' || win === null || Array.isArray(win)) throw new Error('builder config has no Windows options')
    const extraResources = (win as Record<string, unknown>).extraResources
    if (!Array.isArray(extraResources)) throw new Error('builder config has no Windows extra resources')

    const directory = await probeExtraResourceCopy(extraResources.filter(
      (resource): resource is Record<string, unknown> => typeof resource === 'object' && resource !== null,
    ))
    expect(basename(directory.matcher.from)).toBe('win32-x64')
    expect(basename(directory.matcher.to)).toBe('resources')
    expect(directory.matcher.patterns).toEqual(['windows-native-update-supervisor.exe'])
    expect(directory.destinationEntries).toEqual(['windows-native-update-supervisor.exe'])
    expect(directory.transformed).toEqual([
      join('out', 'native', 'win32-x64', 'windows-native-update-supervisor.exe'),
    ])
    expect(directory.afterCopy).toEqual([
      join('app', 'resources', 'windows-native-update-supervisor.exe'),
    ])

    const direct = await probeExtraResourceCopy([{
      from: 'out/native/win32-x64/windows-native-update-supervisor.exe',
      to: 'windows-native-update-supervisor.exe',
    }])
    expect(direct.destinationEntries).toEqual(['windows-native-update-supervisor.exe'])
    expect(direct.transformed).toEqual([])
    expect(direct.afterCopy).toEqual([])
  })

  it('requires the native supervisor only in Windows extra resources', () => {
    const files = conformingFiles()
    const builderConfig = conformingBuilderConfig()
    expect(collectDesktopReleaseViolations({
      ...files,
      builderConfig: {
        ...builderConfig,
        win: { ...builderConfig.win, extraResources: [] },
      },
    })).toContain(
      'builderConfig.win.extraResources: expected exactly one supervisor directory mapping to the resources root with the exact EXE filter',
    )

    expect(collectDesktopReleaseViolations({
      ...files,
      builderConfig: {
        ...builderConfig,
        extraResources: [...builderConfig.extraResources, {
          from: 'out/native/win32-x64',
          to: '.',
          filter: ['windows-native-update-supervisor.exe'],
        }],
      },
    })).toContain(
      'builderConfig.extraResources: Windows native update supervisor must remain Windows-only',
    )
  })

  it('rejects every duplicate or alternate Windows supervisor mapping', () => {
    const files = conformingFiles()
    const builderConfig = conformingBuilderConfig()
    const expected = builderConfig.win.extraResources[0]
    if (expected === undefined) throw new Error('conforming builder has no supervisor mapping')
    const alternatives = [
      expected,
      {
        from: 'out/native/win32-x64/windows-native-update-supervisor.exe',
        to: 'windows-native-update-supervisor.exe',
      },
      {
        from: 'out/native/win32-x64',
        to: 'duplicate',
        filter: ['windows-native-update-supervisor.exe'],
      },
      {
        from: 'unrelated',
        to: 'elsewhere',
        filter: ['windows-native-update-supervisor.exe'],
      },
      {
        from: 'unrelated',
        to: 'elsewhere',
        filter: ['nested/windows-native-update-supervisor.exe'],
      },
    ]
    for (const alternate of alternatives) {
      expect(collectDesktopReleaseViolations({
        ...files,
        builderConfig: {
          ...builderConfig,
          win: { ...builderConfig.win, extraResources: [expected, alternate] },
        },
      })).toContain(
        'builderConfig.win.extraResources: expected exactly one supervisor directory mapping to the resources root with the exact EXE filter',
      )
    }

    const inexactMappings = [
      { from: 'out/native/win32-x64', to: '.', filter: 'windows-native-update-supervisor.exe' },
      { from: 'out/native/win32-x64', to: '.', filter: ['windows-native-update-supervisor.exe', '*.obj'] },
      {
        from: 'out/native/win32-x64',
        to: '.',
        filter: ['windows-native-update-supervisor.exe'],
        unexpected: true,
      },
    ]
    for (const resource of inexactMappings) {
      expect(collectDesktopReleaseViolations({
        ...files,
        builderConfig: {
          ...builderConfig,
          win: { ...builderConfig.win, extraResources: [resource] },
        },
      })).toContain(
        'builderConfig.win.extraResources: expected exactly one supervisor directory mapping to the resources root with the exact EXE filter',
      )
    }
  })

  it('rejects a workflow-owned native build because the package lifecycle owns preparation', () => {
    const files = conformingFiles()
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Build Windows native update supervisor\n        if: ${{ runner.os == 'Windows' }}\n        run: pnpm run build:windows-native-update-supervisor\n      - name: Package installer",
      ),
    })).toContain(
      'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
    )
  })

  it('rejects duplicate, wrong-OS, and embedded native supervisor build invocations', () => {
    const files = conformingFiles()
    const cases = [
      ['standalone duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Duplicate native build\n        run: pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['multiline duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Embedded native build\n        run: |\n          Write-Output preparing\n          pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['compound duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Compound native build\n        run: pnpm run build:windows-native-update-supervisor && Write-Output duplicate\n      - name: Package installer',
      )],
      ['semicolon duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Semicolon native build\n        run: Write-Output preparing; pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['fallback duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Fallback native build\n        run: Write-Output preparing || pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['pipeline duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Pipeline native build\n        run: Write-Output preparing | pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['subshell duplicate', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Subshell native build\n        run: (pnpm run build:windows-native-update-supervisor)\n      - name: Package installer',
      )],
      ['PowerShell backtick continuation', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Continued native build\n        shell: pwsh\n        run: |\n          pnpm run `\n            build:windows-native-update-supervisor && Write-Output duplicate\n      - name: Package installer',
      )],
      ['quoted run token', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Quoted run token\n        shell: bash\n        run: pnpm 'run' build:windows-native-update-supervisor\n      - name: Package installer",
      )],
      ['quoted script token', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Quoted script token\n        shell: bash\n        run: pnpm run 'build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
      ['quoted command token', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Quoted command token\n        shell: bash\n        run: '\"pnpm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
      ['partially quoted Bash command token', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Partially quoted command token\n        shell: sh\n        run: 'pn\"pm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
      ['adjacent Bash quoted segments', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Adjacent quoted segments\n        shell: bash\n        run: \"'pn''pm' run build:windows-native-update-supervisor\"\n      - name: Package installer",
      )],
      ['plain Bash assignment', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Plain assignment\n        shell: bash\n        run: CI=1 pnpm run build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['quoted assignment value', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Quoted assignment value\n        shell: bash\n        run: CI='1' pnpm run build:windows-native-update-supervisor\n      - name: Package installer",
      )],
      ['Bash backslash continuation', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        '      - name: Bash continued native build\n        shell: bash\n        run: |-\n          pnpm run \\\n            build:windows-native-update-supervisor\n      - name: Package installer',
      )],
      ['PowerShell call operator', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: PowerShell call operator\n        shell: pwsh\n        run: '& \"pnpm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
      ['PowerShell backtick-escaped command token', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Escaped PowerShell native build\n        shell: pwsh\n        run: '& \"pn`pm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
      ['Windows PowerShell call operator', files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        "      - name: Windows PowerShell native build\n        shell: powershell\n        run: '& \"pnpm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
      )],
    ] as const
    for (const [label, desktopArtifactsWorkflow] of cases) {
      expect(collectDesktopReleaseViolations({ ...files, desktopArtifactsWorkflow }), label).toContain(
        'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
      )
    }
  })

  it('does not apply Bash quote concatenation to a PowerShell command token', () => {
    const files = conformingFiles()
    const desktopArtifactsWorkflow = files.desktopArtifactsWorkflow.replace(
      '      - name: Package installer',
      "      - name: Literal-quote PowerShell command\n        shell: pwsh\n        run: \"& 'pn''pm' run build:windows-native-update-supervisor\"\n      - name: Package installer",
    )

    expect(collectDesktopReleaseViolations({ ...files, desktopArtifactsWorkflow })).not.toContain(
      'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
    )
  })

  it('rejects a shell-dependent invocation when the workflow step omits shell', () => {
    const files = conformingFiles()
    const desktopArtifactsWorkflow = files.desktopArtifactsWorkflow.replace(
      '      - name: Package installer',
      "      - name: Default-shell native build\n        run: '& \"pn`pm\" run build:windows-native-update-supervisor'\n      - name: Package installer",
    )

    expect(collectDesktopReleaseViolations({ ...files, desktopArtifactsWorkflow })).toContain(
      'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
    )
  })

  it('does not count quoted, commented, argument, or longer native-build text as an invocation', () => {
    const files = conformingFiles()
    const harmless = [
      ['double-quoted data', undefined, 'Write-Output "pnpm run build:windows-native-update-supervisor"'],
      ['single-quoted data', undefined, "Write-Output 'pnpm run build:windows-native-update-supervisor'"],
      ['standalone comment', undefined, '# pnpm run build:windows-native-update-supervisor'],
      ['trailing comment', 'bash', 'Write-Output preparing # pnpm run build:windows-native-update-supervisor'],
      ['argument-only phrase', undefined, 'Write-Output pnpm run build:windows-native-update-supervisor'],
      ['longer script name', undefined, 'pnpm run build:windows-native-update-supervisor-extra'],
      ['entire command phrase quoted', 'bash', '"pnpm run build:windows-native-update-supervisor"'],
      ['fully quoted Bash assignment', 'bash', '"CI=1" pnpm run build:windows-native-update-supervisor'],
    ] as const
    for (const [label, shell, run] of harmless) {
      const shellLine = shell === undefined ? '' : `        shell: ${shell}\n`
      const desktopArtifactsWorkflow = files.desktopArtifactsWorkflow.replace(
        '      - name: Package installer',
        `      - name: Harmless native build text\n${shellLine}        run: |-\n          ${run}\n      - name: Package installer`,
      )
      expect(collectDesktopReleaseViolations({ ...files, desktopArtifactsWorkflow }), label).not.toContain(
        'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
      )
    }
  })

  it('requires one fixed clean-checkout snapshot root to feed verification, collection, and uploads', () => {
    const files = conformingFiles()
    const violations = collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow
        .replace('DSH_UPDATE_SNAPSHOT_ROOT: dist/ci-update-snapshots', 'DSH_UPDATE_SNAPSHOT_ROOT: dist/other')
        .replace('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/artifacts/*', 'dist/ci-update-snapshots/artifacts/*'),
    })

    expect(violations).toContain('desktopArtifactsWorkflow: DSH_UPDATE_SNAPSHOT_ROOT must select the clean-checkout snapshot root')
    expect(violations).toContain('desktopArtifactsWorkflow: uploads must consume DSH_UPDATE_SNAPSHOT_ROOT')
  })

  it('reports one diagnostic for every missing or mismatched requirement', () => {
    expect(collectDesktopReleaseViolations({
      builderConfig: {
        appId: '',
        productName: '',
        executableName: '',
        directories: { output: '' },
        files: [],
        extraResources: [],
        asar: false,
        forceCodeSigning: false,
        publish: { provider: 'github' },
        win: { target: [], extraResources: [] },
        mac: { target: [], category: '' },
        linux: { target: [], category: '' },
      },
      desktopManifest: '{}',
      desktopArtifactVerifier: '',
      desktopArtifactsWorkflow: 'NODE_AUTH_TOKEN release:publish gh release',
      releaseCandidatesWorkflow: 'on: push\nsecrets: inherit\nrun: npm publish && gh release create',
      releaseWorkflow: 'release:publish NODE_AUTH_TOKEN inputs.publish',
    })).toEqual(expect.arrayContaining([
      'builderConfig.appId: expected ' + JSON.stringify(productMetadata.appId),
      'builderConfig.productName: expected ' + JSON.stringify(productMetadata.productName),
      'builderConfig.executableName: expected "harness-desktop"',
      'builderConfig.directories.output: expected "release"',
      'builderConfig.files: expected "out/**"',
      'builderConfig.files: expected "package.json"',
      'builderConfig.files: expected "resources/icons/**"',
      'builderConfig.extraResources: expected "resources/update/windows-native-rollback-worker.ps1" -> "windows-native-rollback-worker.ps1"',
      'builderConfig.extraResources: expected "out/main/native-rollback-worker.js" -> "native-rollback-worker.js"',
      'builderConfig.extraResources: expected "out/main/chunks" -> "chunks"',
      'builderConfig.win.extraResources: expected exactly one supervisor directory mapping to the resources root with the exact EXE filter',
      'builderConfig.asar: expected true',
      'builderConfig.publish: expected null',
      'builderConfig.win.target: expected "nsis"',
      'builderConfig.win.icon: expected apps/desktop/resources/icons/win/harness-desktop.ico',
      'builderConfig.win.signExecutable: expected false for non-release artifacts',
      'builderConfig.mac.target: expected "dmg" for arch "universal"',
      'builderConfig.mac.target: expected "zip" for arch "universal"',
      'builderConfig.mac.icon: expected apps/desktop/resources/icons/mac/harness-desktop.icns',
      'builderConfig.mac.category: expected "public.app-category.developer-tools"',
      'builderConfig.mac.identity: expected null for non-release artifacts',
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
      'desktopArtifactsWorkflow: Configure pnpm store path must use shell bash',
      'desktopArtifactsWorkflow: Verify packed CLI from an empty offline prefix must set DSH_REQUIRE_BUILT_CLI_SMOKE=1',
      'desktopArtifactsWorkflow: forbidden publish marker NODE_AUTH_TOKEN',
      'desktopArtifactsWorkflow: forbidden publish marker release:publish',
      'desktopArtifactsWorkflow: forbidden publish marker gh release',
      'releaseWorkflow: forbidden publish marker NODE_AUTH_TOKEN',
      'releaseWorkflow: forbidden publish marker release:publish',
      'releaseWorkflow: forbidden publish marker inputs.publish',
    ]))
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

  it('rejects Bash-authored pnpm store setup without an explicit Bash shell', () => {
    const files = conformingFiles()
    const violations = collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: [
        '--publish never',
        'windows-2025',
        'macos-15',
        'ubuntu-24.04',
        'jobs:',
        '  package:',
        '    steps:',
        '      - name: Configure pnpm store path',
        '        run: |',
        '          store_root="$HOME/.local/share/pnpm/store"',
      ].join('\n'),
    })

    expect(violations).toContain(
      'desktopArtifactsWorkflow: Configure pnpm store path must use shell bash',
    )
  })

  it('rejects formal packed CLI verification without the required-build signal', () => {
    const files = conformingFiles()
    const violations = collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        "        env:\n          DSH_REQUIRE_BUILT_CLI_SMOKE: '1'\n",
        '',
      ),
    })

    expect(violations).toContain(
      'desktopArtifactsWorkflow: Verify packed CLI from an empty offline prefix must set DSH_REQUIRE_BUILT_CLI_SMOKE=1',
    )
  })

  it('requires platform-selected CLI archives, every native recovery entry, and redacted evidence upload', () => {
    const files = conformingFiles()
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        'cli-artifact: dist/cli-standalone/harness-cli-*.tar.gz',
        'cli-artifact: dist/cli-standalone/harness-cli-*.zip',
      ),
    })).toContain(
      'desktopArtifactsWorkflow: macos-15 must own macos-universal-dmg-zip dmg-zip-universal Desktop and tar.gz CLI artifact dist/cli-standalone/harness-cli-*.tar.gz',
    )
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replaceAll(
        'for arch in arm64 x64',
        'for arch in arm64',
      ),
    })).toEqual(expect.arrayContaining([
      'desktopArtifactsWorkflow: build-cli must own both macOS arm64 and x64 archives in one outcome',
      'desktopArtifactsWorkflow: verify-cli must own both macOS arm64 and x64 archives in one outcome',
    ]))
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        'cli-architectures: arm64,x64',
        'cli-architectures: arm64',
      ),
    })).toContain(
      'desktopArtifactsWorkflow: macos-15 must own macos-universal-dmg-zip dmg-zip-universal Desktop and tar.gz CLI artifact dist/cli-standalone/harness-cli-*.tar.gz',
    )
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        "DSH_RUN_NATIVE_UPDATE_E2E: '1'",
        "DSH_RUN_NATIVE_UPDATE_E2E: '0'",
      ),
    })).toContain(
      'desktopArtifactsWorkflow: every native row must run installed update acceptance with DSH_RUN_NATIVE_UPDATE_E2E=1',
    )
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        'dist/release-logs/release-evidence.json',
        'dist/release-logs/**',
      ),
    })).toContain(
      'desktopArtifactsWorkflow: exactly one success-only artifact upload and one always-on redacted evidence upload are required',
    )
  })

  it('rejects credentials, publishing, signing, and release upload commands in the pull-request workflow', () => {
    const files = conformingFiles()
    const violations = collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        '      - name: Smoke installed Desktop artifacts',
        '      - run: npm publish && codesign && gh release upload\n        env:\n          CSC_LINK: credential\n        secrets: inherit\n      - name: Smoke installed Desktop artifacts',
      ),
    })

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('credential'),
      expect.stringContaining('publish'),
      expect.stringContaining('signing'),
      expect.stringContaining('release upload'),
    ]))
  })

  it('requires a workflow-dispatch-only candidate preflight with five isolated false inputs', () => {
    const files = conformingFiles()
    expect(collectDesktopReleaseViolations({
      ...files,
      releaseCandidatesWorkflow: files.releaseCandidatesWorkflow.replace(
        '      sign-update-manifests: { type: boolean, default: false }',
        '      sign-update-manifests: { type: boolean, default: true }',
      ),
    })).toContain(
      'releaseCandidatesWorkflow: input sign-update-manifests must be boolean and default false',
    )
    expect(collectDesktopReleaseViolations({
      ...files,
      releaseCandidatesWorkflow: files.releaseCandidatesWorkflow.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'),
    })).toContain('releaseCandidatesWorkflow: workflow_dispatch must be the only trigger')
    expect(collectDesktopReleaseViolations({
      ...files,
      releaseCandidatesWorkflow: files.releaseCandidatesWorkflow.replace(
        'run: node scripts/release/select-release-candidate-operation.mjs',
        'run: echo node scripts/release/select-release-candidate-operation.mjs',
      ),
    })).toContain('releaseCandidatesWorkflow: preflight must execute the exact candidate validator command')
    expect(collectDesktopReleaseViolations({
      ...files,
      releaseCandidatesWorkflow: `${files.releaseCandidatesWorkflow}\n  external-release:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm publish`,
    })).toContain('releaseCandidatesWorkflow: preflight must be the only job')
  })

  it('rejects a checksum step that only echoes the trusted verifier command', () => {
    const files = conformingFiles()
    expect(collectDesktopReleaseViolations({
      ...files,
      desktopArtifactsWorkflow: files.desktopArtifactsWorkflow.replace(
        'run: pnpm exec tsx scripts/release/verify-node-runtime-archive.ts',
        'run: echo pnpm exec tsx scripts/release/verify-node-runtime-archive.ts',
      ),
    })).toContain(
      'desktopArtifactsWorkflow: Verify pinned Node distribution checksum must execute the exact verifier command',
    )
  })

  it('accepts the repository-owned builder, manifest, and workflows', async () => {
    const files = await readDesktopReleaseFiles()
    expect(collectDesktopReleaseViolations(files)).toEqual([])
    expect(productMetadata.appId).toBe('io.github.naipi11.harness-desktop')
    expect(files.desktopArtifactsWorkflow).toContain('scripts/release/verify-node-runtime-archive.ts')
    expect(files.desktopArtifactsWorkflow).toContain('desktop:test-updater')
    expect(files.desktopArtifactsWorkflow).toContain('release:test-cli-update')
    expect(files.desktopArtifactsWorkflow).toContain('release:verify-update-manifests')
    expect(files.desktopArtifactVerifier).toContain("'lipo'")
    expect(files.desktopArtifactsWorkflow).toContain('dist/cli-standalone')
    expect(files.desktopArtifactsWorkflow).not.toContain('apps/desktop/test-results')
    expect(files.desktopArtifactsWorkflow).not.toContain('apps/desktop/release/*')
    expect(files.desktopArtifactsWorkflow).not.toContain('dist/cli-standalone/*')
    expect(files.desktopArtifactsWorkflow).toContain('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/artifacts/*')
    expect(files.desktopArtifactsWorkflow).toContain('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/manifests/ready/*.json')
    expect(files.desktopArtifactsWorkflow).toContain('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/bindings.json')
    expect(files.desktopArtifactsWorkflow).toContain('dist/cli-standalone/harness-cli-*.zip')
    expect(files.desktopArtifactsWorkflow).toContain('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/artifacts/*')
    for (const input of [
      'sign-windows',
      'notarize-macos',
      'sign-update-manifests',
      'publish-npm',
      'create-github-release',
    ]) {
      expect(files.releaseCandidatesWorkflow).toContain(input)
    }
  })
})
