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
const macTarget = 'dmg'
const macArch = 'universal'
const macIcon = 'apps/desktop/resources/icons/mac/harness-desktop.icns'
const macCategory = 'public.app-category.developer-tools'
const linuxTargets = ['AppImage', 'deb'] as const
const linuxIcon = 'apps/desktop/resources/icons/linux/harness-desktop-512.png'
const linuxCategory = 'Development'
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

/** Electron Builder options relevant to the closed desktop artifact matrix. */
export interface DesktopBuilderConfig {
  readonly appId: string
  readonly productName: string
  readonly executableName: string
  readonly directories: { readonly output: string }
  readonly files: readonly string[]
  readonly asar: boolean
  readonly publish: unknown
  readonly win: { readonly target: readonly string[]; readonly icon?: string }
  readonly mac: {
    readonly target: readonly { readonly target: string; readonly arch?: readonly string[] }[]
    readonly icon?: string
    readonly category: string
  }
  readonly linux: { readonly target: readonly string[]; readonly icon?: string; readonly category: string }
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
  if (!config.asar) {
    violations.push('builderConfig.asar: expected true')
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
  const macTargetOk = config.mac.target.some(
    target => target.target === macTarget && (target.arch?.includes(macArch) ?? false),
  )
  if (!macTargetOk) {
    violations.push(`builderConfig.mac.target: expected ${JSON.stringify(macTarget)} for arch ${JSON.stringify(macArch)}`)
  }
  if (config.mac.icon !== desktopBuilderIconPath(macIcon)) {
    violations.push(`builderConfig.mac.icon: expected ${macIcon}`)
  }
  if (config.mac.category !== macCategory) {
    violations.push(`builderConfig.mac.category: expected ${JSON.stringify(macCategory)}`)
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

  const scripts = parseDesktopScripts(files.desktopManifest)
  if (scripts === undefined) {
    violations.push('desktopManifest: invalid JSON')
  } else {
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
    { os: 'windows-2025', desktop: 'nsis', cli: 'zip' },
    { os: 'macos-15', desktop: 'dmg-universal', cli: 'tar.gz' },
    { os: 'ubuntu-24.04', desktop: 'appimage-deb', cli: 'tar.gz' },
  ]
  for (const expected of expectedRows) {
    const row = rows.find(candidate => candidate.os === expected.os)
    if (row === undefined || row['desktop-formats'] !== expected.desktop || row['cli-format'] !== expected.cli) {
      violations.push(
        `desktopArtifactsWorkflow: ${expected.os} must own ${expected.desktop} Desktop and ${expected.cli} CLI artifacts`,
      )
    }
  }

  const requiredSteps = [
    ['Verify pinned Node distribution checksum', 'pnpm exec tsx scripts/release/verify-node-runtime-archive.ts'],
    ['Package installer', 'pnpm --filter @harness-desktop/dsh-desktop run package --publish never'],
    ['Inspect native Desktop artifacts', 'pnpm run release:verify-desktop-artifacts'],
    ['Test Desktop updater and rollback', 'pnpm run desktop:test-updater'],
    ['Verify packed CLI from an empty offline prefix', 'pnpm run release:verify-packed-cli'],
    ['Build standalone CLI archives', 'pnpm run release:build-cli-standalone'],
    ['Verify standalone CLI archives', 'pnpm run release:verify-cli-standalone'],
    ['Verify update manifests with ephemeral fixtures', 'pnpm run release:verify-update-manifests'],
    ['Test CLI updater and rollback', 'pnpm run release:test-cli-update'],
    ['Smoke installed Desktop artifacts', 'pnpm run release:smoke-installed-desktop'],
  ]
  const steps = workflowSteps(packageJob)
  let previousIndex = -1
  for (const [name, command] of requiredSteps) {
    const index = steps.findIndex((step, candidateIndex) => candidateIndex > previousIndex
      && step.name === name && normalizedRun(step.run) === command)
    if (index === -1) {
      violations.push(name === 'Verify pinned Node distribution checksum'
        ? 'desktopArtifactsWorkflow: Verify pinned Node distribution checksum must execute the exact verifier command'
        : `desktopArtifactsWorkflow: missing ordered exact command ${command}`)
    }
    else previousIndex = index
  }
  const uploadSteps = Array.isArray(packageJob.steps)
    ? packageJob.steps.filter(isRecord).filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    : []
  const uploadPath = uploadSteps.length === 1 && isRecord(uploadSteps[0]?.with) ? uploadSteps[0].with.path : undefined
  if (typeof uploadPath !== 'string' || uploadPath.split(/\r?\n/u).filter(Boolean).some(path => (
    !path.trim().startsWith('apps/desktop/release/')
    && !path.trim().startsWith('dist/cli-standalone/')
    && !path.trim().startsWith('dist/release-logs/')
    && path.trim() !== '${{ matrix.cli-artifact }}'
  ))) {
    violations.push('desktopArtifactsWorkflow: upload step may contain only native artifacts and redacted release logs')
  }
  return violations
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

function parseDesktopScripts(manifestText: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(manifestText) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  } catch {
    return undefined
  }
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
