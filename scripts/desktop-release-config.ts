/** Verify that the non-publishing desktop artifact matrix stays closed. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { productMetadata } from '../packages/boot/app-boot/src/product-metadata.ts'

const root = resolve(import.meta.dirname, '..')
const executableName = 'harness-desktop'
const outputDirectory = 'release'
const packagedFiles = ['out/**', 'package.json', 'resources/icons/**'] as const
const winTargets = ['nsis'] as const
const winIcon = 'apps/desktop/resources/icons/win/harness-desktop.ico'
const macTargets = ['dmg', 'zip'] as const
const macArch = 'universal'
const macIcon = 'apps/desktop/resources/icons/mac/harness-desktop.icns'
const macCategory = 'public.app-category.developer-tools'
const linuxTargets = ['AppImage', 'deb'] as const
const linuxIcon = 'apps/desktop/resources/icons/linux/harness-desktop-512.png'
const linuxCategory = 'Development'
const linuxDebArtifactName = 'harness-desktop_${version}_${arch}.${ext}'
const staticExtraResources = [
  { from: 'resources/update/windows-native-rollback-worker.ps1', to: 'windows-native-rollback-worker.ps1' },
  { from: 'out/main/native-rollback-worker.js', to: 'native-rollback-worker.js' },
  { from: 'out/main/chunks', to: 'chunks' },
] as const
const windowsSupervisorResource = {
  from: 'out/native/win32-x64',
  to: '.',
  filter: ['windows-native-update-supervisor.exe'],
} as const
const windowsSupervisorFilename = 'windows-native-update-supervisor.exe'
const windowsSupervisorDirectSource = `out/native/win32-x64/${windowsSupervisorFilename}`
const artifactRunners = ['windows-2025', 'macos-15', 'ubuntu-24.04'] as const
const candidateOperations = [
  'sign-windows',
  'notarize-macos',
  'sign-update-manifests',
  'publish-npm',
  'create-github-release',
] as const
const desktopArtifactsForbiddenMarkers = ['NODE_AUTH_TOKEN', 'release:publish', 'gh release'] as const
const releaseForbiddenMarkers = ['NODE_AUTH_TOKEN', 'release:publish', 'inputs.publish'] as const
const releaseCredentialVariables = [
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'WIN_CSC_LINK',
] as const
const builderConfigFlag = '--config electron-builder.config.mjs' as const
const desktopNativePrepareCommand = 'pnpm --dir ../.. run prepare:desktop-native' as const
const releaseEvidenceEnvironment = {
  DSH_RELEASE_MATRIX_LABEL: '${{ matrix.label }}',
  DSH_RELEASE_CLI_FORMAT: '${{ matrix.cli-format }}',
  DSH_RELEASE_CHECK_NODE_RUNTIME: '${{ steps.node-runtime.outcome }}',
  DSH_RELEASE_CHECK_DESKTOP_ARTIFACTS: "${{ steps.package.outcome == 'success' && steps.desktop-artifacts.outcome || steps.package.outcome }}",
  DSH_RELEASE_CHECK_DESKTOP_UPDATER: '${{ steps.desktop-updater.outcome }}',
  DSH_RELEASE_CHECK_PACKED_CLI: '${{ steps.packed-cli.outcome }}',
  DSH_RELEASE_CHECK_CLI_ARCHIVES: "${{ steps.build-cli.outcome == 'success' && steps.verify-cli.outcome || steps.build-cli.outcome }}",
  DSH_RELEASE_CHECK_UPDATE_MANIFESTS: '${{ steps.update-manifests.outcome }}',
  DSH_RELEASE_CHECK_PRODUCED_UPDATE_MANIFESTS: '${{ steps.produced-update-manifests.outcome }}',
  DSH_RELEASE_CHECK_CLI_UPDATER: '${{ steps.cli-updater.outcome }}',
  DSH_RELEASE_CHECK_INSTALLED_DESKTOP: '${{ steps.installed-desktop.outcome }}',
  DSH_RELEASE_CHECK_NATIVE_UPDATE_ROLLBACK: '${{ steps.native-update-rollback.outcome }}',
} as const
const desktopPackageHomepage = `https://github.com/${productMetadata.repository}`
const [desktopPackageAuthorName = ''] = productMetadata.repository.split('/')
const desktopPackageAuthorEmail = `${desktopPackageAuthorName}@users.noreply.github.com`

/** Electron Builder options relevant to the closed desktop artifact matrix. */
export interface DesktopExtraResource {
  readonly from: string
  readonly to: string
  readonly filter?: string | readonly string[]
}

/** Electron Builder options relevant to the closed desktop artifact matrix. */
export interface DesktopBuilderConfig {
  readonly appId: string
  readonly productName: string
  readonly executableName: string
  readonly directories: { readonly output: string }
  readonly files: readonly string[]
  readonly extraResources: readonly DesktopExtraResource[]
  readonly asar: boolean
  readonly forceCodeSigning: boolean
  readonly publish: unknown
  readonly deb?: { readonly artifactName?: string }
  readonly win: {
    readonly target: readonly string[]
    readonly icon?: string
    readonly signExecutable?: boolean
    readonly extraResources: readonly DesktopExtraResource[]
  }
  readonly mac: {
    readonly target: readonly { readonly target: string; readonly arch?: readonly string[] }[]
    readonly icon?: string
    readonly identity?: null
    readonly category: string
  }
  readonly linux: {
    readonly target: readonly string[]
    readonly icon?: string
    readonly category: string
  }
}

/** Contents owned by the desktop release configuration gate. */
export interface DesktopReleaseFiles {
  readonly builderConfig: DesktopBuilderConfig
  readonly desktopManifest: string
  readonly desktopArtifactVerifier: string
  readonly desktopArtifactsWorkflow: string
  readonly releaseCandidatesWorkflow: string
  readonly releaseWorkflow: string
}

/**
 * Return one diagnostic for each requirement the desktop release files violate.
 * @param files - Builder config, desktop manifest, and both workflow texts.
 * @returns Violations in stable requirement order.
 */
export function collectDesktopReleaseViolations(files: DesktopReleaseFiles): string[] {
  const violations: string[] = []
  const config = files.builderConfig

  const repositoryMatch = /^([^/]+)\/([^/]+)$/.exec(productMetadata.repository)
  if (repositoryMatch === null) {
    violations.push(`productMetadata: repository ${JSON.stringify(productMetadata.repository)} must be owner/name`)
  } else {
    const [, owner = '', name = ''] = repositoryMatch
    const expectedAppId = `io.github.${owner.toLowerCase()}.${name.toLowerCase()}`
    if (productMetadata.appId !== expectedAppId) {
      violations.push(
        `productMetadata: appId ${JSON.stringify(productMetadata.appId)} does not match repository ${JSON.stringify(productMetadata.repository)}`,
      )
    }
  }
  if (productMetadata.appId !== 'io.github.naipi11.harness-desktop') {
    violations.push('productMetadata: appId must remain io.github.naipi11.harness-desktop')
  }

  if (config.appId !== productMetadata.appId) {
    violations.push(`builderConfig.appId: expected ${JSON.stringify(productMetadata.appId)}`)
  }
  if (config.productName !== productMetadata.productName) {
    violations.push(`builderConfig.productName: expected ${JSON.stringify(productMetadata.productName)}`)
  }
  if (config.executableName !== executableName) {
    violations.push(`builderConfig.executableName: expected ${JSON.stringify(executableName)}`)
  }
  if (config.directories.output !== outputDirectory) {
    violations.push(`builderConfig.directories.output: expected ${JSON.stringify(outputDirectory)}`)
  }
  for (const file of packagedFiles) {
    if (!config.files.includes(file)) {
      violations.push(`builderConfig.files: expected ${JSON.stringify(file)}`)
    }
  }
  for (const resource of staticExtraResources) {
    if (!config.extraResources.some(candidate => candidate.from === resource.from && candidate.to === resource.to)) {
      violations.push(`builderConfig.extraResources: expected ${JSON.stringify(resource.from)} -> ${JSON.stringify(resource.to)}`)
    }
  }
  if (config.extraResources.some(identifiesWindowsSupervisorResource)) {
    violations.push('builderConfig.extraResources: Windows native update supervisor must remain Windows-only')
  }
  if (!config.asar) {
    violations.push('builderConfig.asar: expected true')
  }
  if (config.forceCodeSigning) {
    violations.push('builderConfig.forceCodeSigning: expected false for non-release artifacts')
  }
  if (config.publish !== null) {
    violations.push('builderConfig.publish: expected null')
  }
  if (!config.win.target.includes(winTargets[0])) {
    violations.push(`builderConfig.win.target: expected ${JSON.stringify(winTargets[0])}`)
  }
  if (config.win.icon !== desktopBuilderIconPath(winIcon)) {
    violations.push(`builderConfig.win.icon: expected ${winIcon}`)
  }
  if (config.win.signExecutable !== false) {
    violations.push('builderConfig.win.signExecutable: expected false for non-release artifacts')
  }
  const supervisorResources = config.win.extraResources.filter(identifiesWindowsSupervisorResource)
  if (supervisorResources.length !== 1 || !sameExtraResource(supervisorResources[0], windowsSupervisorResource)) {
    violations.push(
      'builderConfig.win.extraResources: expected exactly one supervisor directory mapping to the resources root with the exact EXE filter',
    )
  }
  for (const macTarget of macTargets) {
    const macTargetOk = config.mac.target.some(
      target => target.target === macTarget && (target.arch?.includes(macArch) ?? false),
    )
    if (!macTargetOk) {
      violations.push(`builderConfig.mac.target: expected ${JSON.stringify(macTarget)} for arch ${JSON.stringify(macArch)}`)
    }
  }
  if (config.mac.icon !== desktopBuilderIconPath(macIcon)) {
    violations.push(`builderConfig.mac.icon: expected ${macIcon}`)
  }
  if (config.mac.category !== macCategory) {
    violations.push(`builderConfig.mac.category: expected ${JSON.stringify(macCategory)}`)
  }
  if (config.mac.identity !== null) {
    violations.push('builderConfig.mac.identity: expected null for non-release artifacts')
  }
  for (const target of linuxTargets) {
    if (!config.linux.target.includes(target)) {
      violations.push(`builderConfig.linux.target: expected ${JSON.stringify(target)}`)
    }
  }
  if (config.linux.icon !== desktopBuilderIconPath(linuxIcon)) {
    violations.push(`builderConfig.linux.icon: expected ${linuxIcon}`)
  }
  if (config.linux.category !== linuxCategory) {
    violations.push(`builderConfig.linux.category: expected ${JSON.stringify(linuxCategory)}`)
  }
  if (config.deb?.artifactName !== linuxDebArtifactName) {
    violations.push(`builderConfig.deb.artifactName: expected ${JSON.stringify(linuxDebArtifactName)}`)
  }

  const desktopManifest = parseDesktopManifest(files.desktopManifest)
  if (desktopManifest === undefined) {
    violations.push('desktopManifest: invalid JSON')
  } else {
    const scripts = desktopManifest.scripts
    for (const script of ['prepackage', 'prepackage:dir'] as const) {
      if (!hasExactAndCommand(scripts[script], desktopNativePrepareCommand)) {
        violations.push(
          `desktopManifest: script ${JSON.stringify(script)} must run the cross-platform Desktop native prepare command`,
        )
      }
    }
    if (!(scripts['package'] ?? '').includes('--publish never')) {
      violations.push('desktopManifest: script "package" must pass --publish never')
    }
    if (!(scripts['package'] ?? '').includes(builderConfigFlag)) {
      violations.push('desktopManifest: script "package" must load the electron-builder config explicitly')
    }
    if (!(scripts['package:dir'] ?? '').includes('--publish never')) {
      violations.push('desktopManifest: script "package:dir" must pass --publish never')
    }
    if (!(scripts['package:dir'] ?? '').includes(builderConfigFlag)) {
      violations.push('desktopManifest: script "package:dir" must load the electron-builder config explicitly')
    }
    if (desktopManifest.homepage !== desktopPackageHomepage) {
      violations.push(`desktopManifest: homepage must equal ${JSON.stringify(desktopPackageHomepage)}`)
    }
    if (!isDesktopPackageAuthor(desktopManifest.author)) {
      violations.push(`desktopManifest: author must equal ${desktopPackageAuthorName} <${desktopPackageAuthorEmail}>`)
    }
  }

  if (!files.desktopArtifactsWorkflow.includes('--publish never')) {
    violations.push('desktopArtifactsWorkflow: missing --publish never')
  }
  for (const runner of artifactRunners) {
    if (!files.desktopArtifactsWorkflow.includes(runner)) {
      violations.push(`desktopArtifactsWorkflow: missing runner ${runner}`)
    }
  }
  if (!workflowStepUsesShell(files.desktopArtifactsWorkflow, 'Configure pnpm store path', 'bash')) {
    violations.push('desktopArtifactsWorkflow: Configure pnpm store path must use shell bash')
  }
  if (!workflowStepHasEnvironment(
    files.desktopArtifactsWorkflow,
    'Verify packed CLI from an empty offline prefix',
    'DSH_REQUIRE_BUILT_CLI_SMOKE',
    '1',
  )) {
    violations.push(
      'desktopArtifactsWorkflow: Verify packed CLI from an empty offline prefix must set DSH_REQUIRE_BUILT_CLI_SMOKE=1',
    )
  }
  for (const marker of desktopArtifactsForbiddenMarkers) {
    if (files.desktopArtifactsWorkflow.includes(marker)) {
      violations.push(`desktopArtifactsWorkflow: forbidden publish marker ${marker}`)
    }
  }
  violations.push(...auditDesktopArtifactsWorkflow(files.desktopArtifactsWorkflow))
  if (!files.desktopArtifactVerifier.includes("'lipo'") || !files.desktopArtifactVerifier.includes("'-info'")) {
    violations.push('desktopArtifactVerifier: macOS universal artifact inspection must invoke lipo -info')
  }
  violations.push(...auditReleaseCandidatesWorkflow(files.releaseCandidatesWorkflow))
  for (const marker of releaseForbiddenMarkers) {
    if (files.releaseWorkflow.includes(marker)) {
      violations.push(`releaseWorkflow: forbidden publish marker ${marker}`)
    }
  }

  return violations
}

function auditDesktopArtifactsWorkflow(workflowText: string): string[] {
  const workflow = parseWorkflow(workflowText)
  if (workflow === undefined) return ['desktopArtifactsWorkflow: invalid YAML']
  const violations: string[] = []
  const triggers = recordKeys(workflow.on)
  if (!sameStrings(triggers, ['pull_request', 'workflow_dispatch'])) {
    violations.push('desktopArtifactsWorkflow: pull_request and workflow_dispatch must be the only triggers')
  }
  if (!hasReadOnlyContentsPermission(workflow.permissions)) {
    violations.push('desktopArtifactsWorkflow: permissions must grant contents read only')
  }
  if (!isRecord(workflow.env) || workflow.env.DSH_UPDATE_SNAPSHOT_ROOT !== 'dist/ci-update-snapshots') {
    violations.push('desktopArtifactsWorkflow: DSH_UPDATE_SNAPSHOT_ROOT must select the clean-checkout snapshot root')
  }
  const packageJob = workflowJob(workflow, 'package')
  if (packageJob === undefined) return [...violations, 'desktopArtifactsWorkflow: package job is missing']
  if (!isRecord(workflow.jobs) || !sameStrings(Object.keys(workflow.jobs), ['package'])) {
    violations.push('desktopArtifactsWorkflow: package must be the only job')
  }
  if (containsKey(workflow, 'environment') || containsKey(workflow, 'secrets')
    || workflowText.includes('${{ secrets.') || containsAnyKey(workflow, releaseCredentialVariables)) {
    violations.push('desktopArtifactsWorkflow: credential or release-environment access is forbidden')
  }

  const commands = jobRunCommands(packageJob)
  const commandText = commands.join('\n')
  if (/\b(?:npm|pnpm)\s+publish\b/u.test(commandText) || commandText.includes('release:publish')) {
    violations.push('desktopArtifactsWorkflow: publish command is forbidden')
  }
  if (/\b(?:codesign|signtool|notarytool)\b/u.test(commandText)) {
    violations.push('desktopArtifactsWorkflow: signing or notarization command is forbidden')
  }
  if (/\bgh\s+release\s+upload\b|\brelease:upload\b|\bupdate-upload\b/u.test(commandText)) {
    violations.push('desktopArtifactsWorkflow: release upload command is forbidden')
  }
  const actionText = jobActions(packageJob).join('\n')
  if (/action-gh-release|upload-release|codesign|notar|signtool/iu.test(actionText)) {
    violations.push('desktopArtifactsWorkflow: release signing or upload action is forbidden')
  }

  const rows = matrixRows(packageJob)
  const expectedRows = [
    { os: 'windows-2025', label: 'windows-nsis', desktop: 'nsis', cli: 'zip', artifact: 'dist/cli-standalone/harness-cli-*.zip' },
    { os: 'macos-15', label: 'macos-universal-dmg-zip', desktop: 'dmg-zip-universal', cli: 'tar.gz', artifact: 'dist/cli-standalone/harness-cli-*.tar.gz', architectures: 'arm64,x64' },
    { os: 'ubuntu-24.04', label: 'linux-appimage-deb', desktop: 'appimage-deb', cli: 'tar.gz', artifact: 'dist/cli-standalone/harness-cli-*.tar.gz' },
  ]
  for (const expected of expectedRows) {
    const row = rows.find(candidate => candidate.os === expected.os)
    if (row === undefined || row.label !== expected.label || row['desktop-formats'] !== expected.desktop || row['cli-format'] !== expected.cli
      || row['cli-artifact'] !== expected.artifact
      || ('architectures' in expected && row['cli-architectures'] !== expected.architectures)) {
      violations.push(
        `desktopArtifactsWorkflow: ${expected.os} must own ${expected.label} ${expected.desktop} Desktop and ${expected.cli} CLI artifact ${expected.artifact}`,
      )
    }
  }

  const requiredSteps = [
    ['Verify pinned Node distribution checksum', 'pnpm exec tsx scripts/release/verify-node-runtime-archive.ts', 'node-runtime'],
    ['Generate ephemeral public update policy', 'pnpm exec tsx scripts/release/create-ephemeral-update-policy.ts\necho "DSH_UPDATE_POLICY=${DSH_UPDATE_POLICY_OUTPUT}" >> "$GITHUB_ENV"\necho "DSH_DESKTOP_UPDATE_POLICY=${DSH_UPDATE_POLICY_OUTPUT}" >> "$GITHUB_ENV"'],
    ['Package installer', 'pnpm --filter @harness-desktop/dsh-desktop run package --publish never', 'package'],
    ['Inspect native Desktop artifacts', 'pnpm run release:verify-desktop-artifacts', 'desktop-artifacts'],
    ['Test Desktop updater and rollback', 'pnpm run desktop:test-updater', 'desktop-updater'],
    ['Verify packed CLI from an empty offline prefix', 'pnpm run release:verify-packed-cli', 'packed-cli'],
    ['Verify update manifests with ephemeral fixtures', 'pnpm run release:verify-update-manifests', 'update-manifests'],
    ["Sign and verify manifests for this row's produced artifacts", 'pnpm run release:verify-produced-update-manifests', 'produced-update-manifests'],
    ['Test CLI updater and rollback', 'pnpm run release:test-cli-update', 'cli-updater'],
    ['Smoke installed Desktop artifacts', 'pnpm run release:smoke-installed-desktop', 'installed-desktop'],
    ['Exercise actual installed native update and rollback', 'pnpm --dir apps/desktop run test:e2e:native-update', 'native-update-rollback'],
    ['Write redacted native release evidence', 'pnpm exec tsx scripts/release/collect-release-evidence.ts', 'release-evidence'],
  ]
  const steps = workflowSteps(packageJob)
  if (workflowInvokesWindowsNativeSupervisorBuild(steps)) {
    violations.push(
      'desktopArtifactsWorkflow: native supervisor preparation belongs to the Desktop package lifecycle',
    )
  }
  let previousIndex = -1
  for (const [name, command, id] of requiredSteps) {
    const index = steps.findIndex((step, candidateIndex) => candidateIndex > previousIndex
      && step.name === name && normalizedRun(step.run) === command && (id === undefined || step.id === id))
    if (index === -1) {
      violations.push(name === 'Verify pinned Node distribution checksum'
        ? 'desktopArtifactsWorkflow: Verify pinned Node distribution checksum must execute the exact verifier command'
        : `desktopArtifactsWorkflow: missing ordered exact command ${command}`)
    }
    else previousIndex = index
  }
  const manylinuxNodePtyIndex = steps.findIndex(step => step.name === 'Rebuild Linux node-pty against manylinux 2.28')
  const repositoryBuildIndex = steps.findIndex(step => step.name === 'Build repository and Desktop app')
  const manylinuxNodePty = steps[manylinuxNodePtyIndex]
  if (!workflowHasLinuxManylinuxNodePtyRebuild(manylinuxNodePty)
    || repositoryBuildIndex === -1 || manylinuxNodePtyIndex >= repositoryBuildIndex) {
    violations.push('desktopArtifactsWorkflow: Linux node-pty must be rebuilt against manylinux 2.28 before the repository build')
  }
  const linuxAppImageInspection = steps.find(step => step.name === 'Enable Linux AppImage FUSE runtime and static inspection')
  if (!workflowHasLinuxAppImageInspectionTools(linuxAppImageInspection)) {
    violations.push('desktopArtifactsWorkflow: Linux AppImage static inspection must provide FUSE and unsquashfs')
  }
  const buildCli = steps.find(step => step.name === 'Build standalone CLI archives' && step.id === 'build-cli')
  const verifyCli = steps.find(step => step.name === 'Verify standalone CLI archives' && step.id === 'verify-cli')
  if (!provesBothMacCliArchitectures(buildCli, 'release:build-cli-standalone')) {
    violations.push('desktopArtifactsWorkflow: build-cli must own both macOS arm64 and x64 archives in one outcome')
  }
  if (!provesBothMacCliArchitectures(verifyCli, 'release:verify-cli-standalone')) {
    violations.push('desktopArtifactsWorkflow: verify-cli must own both macOS arm64 and x64 archives in one outcome')
  }
  if (!workflowStepHasExactEnvironment(workflowText, 'Exercise actual installed native update and rollback', {
    DSH_RUN_NATIVE_UPDATE_E2E: '1',
  }) || workflowSteps(packageJob).find(step => step.name === 'Exercise actual installed native update and rollback')?.if !== undefined) {
    violations.push('desktopArtifactsWorkflow: every native row must run installed update acceptance with DSH_RUN_NATIVE_UPDATE_E2E=1')
  }
  if (!workflowStepHasExactEnvironment(workflowText, 'Write redacted native release evidence', releaseEvidenceEnvironment)
    || !workflowStepHasExactValue(workflowText, 'Write redacted native release evidence', 'if', '${{ always() }}')) {
    violations.push('desktopArtifactsWorkflow: release evidence must record the fixed matrix metadata and check outcomes under always()')
  }
  const uploadSteps = Array.isArray(packageJob.steps)
    ? packageJob.steps.filter(isRecord).filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    : []
  const artifactUpload = uploadSteps.find(step => isRecord(step.with) && step.with.name === 'harness-desktop-${{ matrix.label }}')
  const evidenceUpload = uploadSteps.find(step => isRecord(step.with) && step.with.name === 'harness-release-evidence-${{ matrix.label }}')
  const uploadPath = artifactUpload !== undefined && isRecord(artifactUpload.with) ? artifactUpload.with.path : undefined
  const evidenceUploadPath = evidenceUpload !== undefined && isRecord(evidenceUpload.with) ? evidenceUpload.with.path : undefined
  if (uploadSteps.length !== 2 || artifactUpload === undefined || evidenceUpload === undefined
    || artifactUpload.if !== '${{ success() }}' || evidenceUpload.if !== '${{ always() }}'
    || !isRecord(artifactUpload.with) || artifactUpload.with['if-no-files-found'] !== 'error'
    || !isRecord(evidenceUpload.with) || typeof evidenceUploadPath !== 'string'
    || !evidenceUploadPath.split(/\r?\n/u).map(line => line.trim()).includes('dist/release-logs/release-evidence.json')
    || evidenceUpload.with['if-no-files-found'] !== 'error') {
    violations.push('desktopArtifactsWorkflow: exactly one success-only artifact upload and one always-on redacted evidence upload are required')
  }
  const artifactUploadPaths = typeof uploadPath === 'string'
    ? uploadPath.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    : []
  const evidenceUploadPaths = typeof evidenceUploadPath === 'string'
    ? evidenceUploadPath.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    : []
  if (!sameStrings(artifactUploadPaths, ['${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/artifacts/*'])
    || !evidenceUploadPaths.includes('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/manifests/ready/*.json')
    || !evidenceUploadPaths.includes('${{ env.DSH_UPDATE_SNAPSHOT_ROOT }}/bindings.json')) {
    violations.push('desktopArtifactsWorkflow: uploads must consume DSH_UPDATE_SNAPSHOT_ROOT')
  }
  return violations
}

function workflowInvokesWindowsNativeSupervisorBuild(steps: readonly Record<string, unknown>[]): boolean {
  const nativeBuildCommand = 'pnpm run build:windows-native-update-supervisor'
  for (const step of steps) {
    const invocations = runCommandInvocations(step.run, step.shell, nativeBuildCommand)
    if (invocations === undefined || invocations.length > 0) return true
  }
  return false
}

function workflowHasLinuxManylinuxNodePtyRebuild(step: Record<string, unknown> | undefined): boolean {
  if (step?.if !== "${{ runner.os == 'Linux' }}" || step.shell !== 'bash' || !isRecord(step.env)
    || step.env.RUNNER_ARCH !== '${{ runner.arch }}') return false
  const run = normalizedRun(step.run)
  return [
    'case "$RUNNER_ARCH" in',
    'manylinux_2_28_x86_64',
    'manylinux_2_28_aarch64',
    'realpath packages/subprocess/subprocess-local/node_modules/node-pty',
    'docker run --rm',
    'make -C build -j2 BUILDTYPE=Release',
    'node-pty-glibc-versions.txt',
    'dpkg --compare-versions "$maximum" le 2.28',
  ].every(marker => run.includes(marker))
}

function workflowHasLinuxAppImageInspectionTools(step: Record<string, unknown> | undefined): boolean {
  if (step?.if !== "${{ runner.os == 'Linux' }}" || step.shell !== 'bash') return false
  const run = normalizedRun(step.run)
  return [
    'sudo apt-get install --yes fuse3 libfuse2t64 squashfs-tools libnspr4 libnss3 libasound2t64',
    'test -c /dev/fuse',
    'test -x /bin/fusermount3 || test -x /usr/bin/fusermount3',
    'test -x "$(command -v unsquashfs)"',
  ].every(marker => run.includes(marker))
}

function hasExactAndCommand(script: string | undefined, command: string): boolean {
  return script?.split('&&').map(part => part.trim()).includes(command) ?? false
}

type WorkflowShellDialect = 'bash' | 'powershell'

/**
 * Scans direct command positions used by the controlled release workflow, not arbitrary shell programs.
 * Steps without `shell` are accepted only when the Bash and PowerShell runner defaults agree on target invocations.
 */
function runCommandInvocations(run: unknown, shell: unknown, command: string): readonly string[] | undefined {
  if (typeof run !== 'string') return []
  const dialect = workflowShellDialect(shell)
  if (dialect !== undefined) return commandInvocations(run, command, dialect)
  if (shell !== undefined) return undefined
  const bashInvocations = commandInvocations(run, command, 'bash')
  const powershellInvocations = commandInvocations(run, command, 'powershell')
  return bashInvocations.length === powershellInvocations.length ? bashInvocations : undefined
}

function workflowShellDialect(shell: unknown): WorkflowShellDialect | undefined {
  if (typeof shell !== 'string') return undefined
  const executable = shell.trim().split(/\s/u, 1)[0]
    ?.replace(/^['"]|['"]$/gu, '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/\.exe$/iu, '')
    .toLowerCase()
  if (executable === 'bash' || executable === 'sh') return 'bash'
  if (executable === 'pwsh' || executable === 'powershell') return 'powershell'
  return undefined
}

function commandInvocations(run: string, command: string, dialect: WorkflowShellDialect): readonly string[] {
  const expected = command.split(' ')
  return shellCommands(run, dialect).filter((words) => {
    let start = 0
    while (true) {
      const candidate = words[start]
      if (candidate === undefined || !candidate.assignmentPrefix) break
      start += 1
    }
    return expected.every((value, index) => {
      const word = words[start + index]
      return word !== undefined && word.value === value
    })
  }).map(() => command)
}

interface ShellWord {
  readonly value: string
  readonly assignmentPrefix: boolean
}

function shellCommands(script: string, dialect: WorkflowShellDialect): readonly (readonly ShellWord[])[] {
  const commands: ShellWord[][] = []
  let words: ShellWord[] = []
  let word = ''
  let wordStarted = false
  let quoted = false
  let assignmentPrefix = false
  let quote: 'single' | 'double' | undefined

  const finishWord = (): void => {
    if (!wordStarted) return
    words.push({ value: word, assignmentPrefix })
    word = ''
    wordStarted = false
    quoted = false
    assignmentPrefix = false
  }
  const finishCommand = (): void => {
    finishWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]
    if (character === undefined) break
    const next = script[index + 1]

    const lineContinuation = quote !== 'single'
      && ((dialect === 'bash' && character === '\\') || (dialect === 'powershell' && character === '`'))
      && (next === '\n' || (next === '\r' && script[index + 2] === '\n'))
    if (lineContinuation) {
      index += next === '\r' ? 2 : 1
      continue
    }
    if (quote !== undefined) {
      const escapedInDoubleQuote = quote === 'double' && next !== undefined
        && ((dialect === 'bash' && character === '\\' && '$`"\\'.includes(next))
          || (dialect === 'powershell' && character === '`'))
      if (quote === 'single' && dialect === 'powershell' && character === "'" && next === "'") {
        word += "'"
        index += 1
      } else if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"')) {
        quote = undefined
      } else if (escapedInDoubleQuote) {
        word += next
        index += 1
      } else {
        word += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      wordStarted = true
      quoted = true
      quote = character === "'" ? 'single' : 'double'
      continue
    }
    if (character === '#' && word === '') {
      while (index + 1 < script.length && script[index + 1] !== '\n') index += 1
      continue
    }
    if (/\s/u.test(character)) {
      finishWord()
      if (character === '\n' || character === '\r') finishCommand()
      continue
    }
    if (character === ';' || character === '|' || character === '&'
      || character === '(' || character === ')' || character === '{' || character === '}') {
      finishCommand()
      if ((character === '|' || character === '&') && next === character) index += 1
      continue
    }
    if (dialect === 'bash' && character === '\\' && next !== undefined) {
      word += next
      wordStarted = true
      index += 1
      continue
    }
    if (dialect === 'powershell' && character === '`' && next !== undefined) {
      word += next
      wordStarted = true
      index += 1
      continue
    }
    if (dialect === 'bash' && character === '=' && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word)) {
      assignmentPrefix = true
    }
    word += character
    wordStarted = true
  }
  finishCommand()
  return commands
}

function identifiesWindowsSupervisorResource(resource: DesktopExtraResource): boolean {
  const from = normalizedResourcePath(resource.from)
  return from === normalizedResourcePath(windowsSupervisorResource.from)
    || from === windowsSupervisorDirectSource
    || resourceBasename(resource.to) === windowsSupervisorFilename
    || normalizedResourceFilters(resource.filter).some(filter => resourceBasename(filter) === windowsSupervisorFilename)
}

function sameExtraResource(actual: DesktopExtraResource | undefined, expected: DesktopExtraResource): boolean {
  return actual !== undefined
    && sameStrings(Object.keys(actual), ['filter', 'from', 'to'])
    && actual.from === expected.from
    && actual.to === expected.to
    && Array.isArray(actual.filter)
    && Array.isArray(expected.filter)
    && JSON.stringify(actual.filter) === JSON.stringify(expected.filter)
}

function normalizedResourcePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '') || '.'
}

function normalizedResourceFilters(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  return (typeof value === 'string' ? [value] : value).map(normalizedResourcePath)
}

function resourceBasename(value: string): string | undefined {
  return normalizedResourcePath(value).split('/').filter(Boolean).at(-1)
}

function provesBothMacCliArchitectures(step: Record<string, unknown> | undefined, script: string): boolean {
  if (step === undefined || step.shell !== 'bash' || typeof step.run !== 'string') return false
  const run = normalizedRun(step.run)
  return run.includes('if [[ "${RUNNER_OS}" == "macOS" ]]')
    && run.includes('for arch in arm64 x64')
    && run.includes('DSH_CLI_STANDALONE_PLATFORM=darwin')
    && run.includes('DSH_CLI_STANDALONE_ARCH="${arch}"')
    && run.includes(`pnpm run ${script}`)
}

function auditReleaseCandidatesWorkflow(workflowText: string): string[] {
  const workflow = parseWorkflow(workflowText)
  if (workflow === undefined) return ['releaseCandidatesWorkflow: invalid YAML']
  const violations: string[] = []
  const triggers = recordKeys(workflow.on)
  if (!sameStrings(triggers, ['workflow_dispatch'])) {
    violations.push('releaseCandidatesWorkflow: workflow_dispatch must be the only trigger')
  }
  const dispatch = isRecord(workflow.on) ? workflow.on.workflow_dispatch : undefined
  const inputs = isRecord(dispatch) && isRecord(dispatch.inputs) ? dispatch.inputs : undefined
  if (inputs === undefined || !sameStrings(Object.keys(inputs), candidateOperations)) {
    violations.push('releaseCandidatesWorkflow: exactly five release operation inputs are required')
  }
  for (const operation of candidateOperations) {
    const input = inputs?.[operation]
    if (!isRecord(input) || input.type !== 'boolean' || input.default !== false) {
      violations.push(`releaseCandidatesWorkflow: input ${operation} must be boolean and default false`)
    }
  }
  if (!isRecord(workflow.permissions) || Object.keys(workflow.permissions).length !== 0) {
    violations.push('releaseCandidatesWorkflow: permissions must remain empty')
  }
  if (!isRecord(workflow.jobs) || !sameStrings(Object.keys(workflow.jobs), ['preflight'])) {
    violations.push('releaseCandidatesWorkflow: preflight must be the only job')
  }
  if (containsKey(workflow, 'environment') || containsKey(workflow, 'secrets')
    || workflowText.includes('${{ secrets.') || containsAnyKey(workflow, releaseCredentialVariables)) {
    violations.push('releaseCandidatesWorkflow: credentials and release environments are forbidden')
  }
  const preflight = workflowJob(workflow, 'preflight')
  if (preflight === undefined) return [...violations, 'releaseCandidatesWorkflow: preflight job is missing']
  const steps = workflowSteps(preflight)
  const checkoutStep = steps[0]
  const preflightStep = steps.find(step => step.name === 'Require exactly one candidate operation')
  if (checkoutStep?.uses !== 'actions/checkout@v6' || !isRecord(checkoutStep.with)
    || checkoutStep.with['persist-credentials'] !== false) {
    violations.push('releaseCandidatesWorkflow: checkout must disable persisted credentials')
  }
  if (normalizedRun(preflightStep?.run) !== 'node scripts/release/select-release-candidate-operation.mjs') {
    violations.push('releaseCandidatesWorkflow: preflight must execute the exact candidate validator command')
  }
  if (steps.length !== 2 || steps[1] !== preflightStep || typeof preflightStep?.uses === 'string') {
    violations.push('releaseCandidatesWorkflow: credential-free checkout and validation must be the only steps')
  }
  const preflightEnvironment = isRecord(preflightStep?.env) ? preflightStep.env : undefined
  const expectedEnvironment = {
    SIGN_WINDOWS: "${{ inputs['sign-windows'] }}",
    NOTARIZE_MACOS: "${{ inputs['notarize-macos'] }}",
    SIGN_UPDATE_MANIFESTS: "${{ inputs['sign-update-manifests'] }}",
    PUBLISH_NPM: "${{ inputs['publish-npm'] }}",
    CREATE_GITHUB_RELEASE: "${{ inputs['create-github-release'] }}",
  }
  if (preflightEnvironment === undefined || !sameRecord(preflightEnvironment, expectedEnvironment)) {
    violations.push('releaseCandidatesWorkflow: preflight must isolate all five operation selectors')
  }
  const commands = jobRunCommands(preflight).join('\n')
  if (/\b(?:npm|pnpm)\s+publish\b|\bgh\s+release\b|\b(?:codesign|signtool|notarytool)\b|\bcurl\b/u.test(commands)) {
    violations.push('releaseCandidatesWorkflow: external release actions are forbidden')
  }
  return violations
}

function parseWorkflow(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = load(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : []
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
}

function hasReadOnlyContentsPermission(value: unknown): boolean {
  return isRecord(value) && value.contents === 'read' && Object.keys(value).length === 1
}

function workflowJob(workflow: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  return isRecord(workflow.jobs) && isRecord(workflow.jobs[name]) ? workflow.jobs[name] : undefined
}

function jobRunCommands(job: Record<string, unknown>): string[] {
  if (!Array.isArray(job.steps)) return []
  return job.steps.filter(isRecord).flatMap(step => typeof step.run === 'string' ? [step.run] : [])
}

function workflowSteps(job: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : []
}

function normalizedRun(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n').trim() : ''
}

function sameRecord(actual: Record<string, unknown>, expected: Readonly<Record<string, string>>): boolean {
  return sameStrings(Object.keys(actual), Object.keys(expected))
    && Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function jobActions(job: Record<string, unknown>): string[] {
  if (!Array.isArray(job.steps)) return []
  return job.steps.filter(isRecord).flatMap(step => typeof step.uses === 'string' ? [step.uses] : [])
}

function matrixRows(job: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!isRecord(job.strategy) || !isRecord(job.strategy.matrix) || !Array.isArray(job.strategy.matrix.include)) return []
  return job.strategy.matrix.include.filter(isRecord)
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsKey(item, key))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([candidate, nested]) => candidate === key || containsKey(nested, key))
}

function containsAnyKey(value: unknown, keys: readonly string[]): boolean {
  return keys.some(key => containsKey(value, key))
}

function desktopBuilderIconPath(repositoryPath: string): string {
  return repositoryPath.replace(/^apps\/desktop\//, '')
}

function parseDesktopManifest(manifestText: string): DesktopPackageManifest | undefined {
  try {
    const parsed = JSON.parse(manifestText) as {
      readonly scripts?: Record<string, string>
      readonly homepage?: unknown
      readonly author?: unknown
    }
    return {
      scripts: parsed.scripts ?? {},
      homepage: parsed.homepage,
      author: parsed.author,
    }
  } catch {
    return undefined
  }
}

interface DesktopPackageManifest {
  readonly scripts: Record<string, string>
  readonly homepage: unknown
  readonly author: unknown
}

function isDesktopPackageAuthor(value: unknown): boolean {
  return isRecord(value)
    && value.name === desktopPackageAuthorName
    && value.email === desktopPackageAuthorEmail
}

function workflowStepUsesShell(workflowText: string, name: string, shell: string): boolean {
  try {
    const workflow: unknown = load(workflowText)
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) return false
    const packageJob = workflow.jobs.package
    if (!isRecord(packageJob) || !Array.isArray(packageJob.steps)) return false
    return packageJob.steps.some(step => (
      isRecord(step) && step.name === name && step.shell === shell
    ))
  } catch {
    return false
  }
}

function workflowStepHasEnvironment(
  workflowText: string,
  name: string,
  key: string,
  value: string,
): boolean {
  try {
    const workflow: unknown = load(workflowText)
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) return false
    const packageJob = workflow.jobs.package
    if (!isRecord(packageJob) || !Array.isArray(packageJob.steps)) return false
    return packageJob.steps.some(step => (
      isRecord(step) && step.name === name && isRecord(step.env) && step.env[key] === value
    ))
  } catch {
    return false
  }
}

function workflowStepHasExactEnvironment(
  workflowText: string,
  name: string,
  expected: Readonly<Record<string, string>>,
): boolean {
  try {
    const workflow = parseWorkflow(workflowText)
    const packageJob = workflow === undefined ? undefined : workflowJob(workflow, 'package')
    const step = packageJob === undefined ? undefined : workflowSteps(packageJob).find(candidate => candidate.name === name)
    return step !== undefined && isRecord(step.env) && sameRecord(step.env, expected)
  } catch {
    return false
  }
}

function workflowStepHasExactValue(
  workflowText: string,
  name: string,
  key: string,
  expected: string,
): boolean {
  try {
    const workflow = parseWorkflow(workflowText)
    const packageJob = workflow === undefined ? undefined : workflowJob(workflow, 'package')
    const step = packageJob === undefined ? undefined : workflowSteps(packageJob).find(candidate => candidate.name === name)
    return step?.[key] === expected
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the repository-owned files the desktop release gate audits. */
export async function readDesktopReleaseFiles(): Promise<DesktopReleaseFiles> {
  const builderModule: unknown = await import(
    pathToFileURL(resolve(root, 'apps/desktop/electron-builder.config.mjs')).href,
  )
  return {
    builderConfig: (builderModule as { readonly default: DesktopBuilderConfig }).default,
    desktopManifest: readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'),
    desktopArtifactVerifier: readFileSync(resolve(root, 'scripts/release/verify-desktop-artifacts.ts'), 'utf8'),
    desktopArtifactsWorkflow: readFileSync(resolve(root, '.github/workflows/desktop-artifacts.yml'), 'utf8'),
    releaseCandidatesWorkflow: readFileSync(resolve(root, '.github/workflows/release-candidates.yml'), 'utf8'),
    releaseWorkflow: readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const files = await readDesktopReleaseFiles()
  const violations = collectDesktopReleaseViolations(files)
  if (violations.length === 0) {
    process.stdout.write('verify:desktop-release-config: desktop artifact matrix matches product metadata and stays non-publishing.\n')
  } else {
    process.stderr.write('verify:desktop-release-config: desktop release config violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exitCode = 1
  }
}
