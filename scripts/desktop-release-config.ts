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
const desktopArtifactsForbiddenMarkers = ['NODE_AUTH_TOKEN', 'release:publish', 'gh release'] as const
const releaseForbiddenMarkers = ['NODE_AUTH_TOKEN', 'release:publish', 'inputs.publish'] as const
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
  readonly desktopArtifactsWorkflow: string
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
  for (const marker of releaseForbiddenMarkers) {
    if (files.releaseWorkflow.includes(marker)) {
      violations.push(`releaseWorkflow: forbidden publish marker ${marker}`)
    }
  }

  return violations
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
    desktopArtifactsWorkflow: readFileSync(resolve(root, '.github/workflows/desktop-artifacts.yml'), 'utf8'),
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
