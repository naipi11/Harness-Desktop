/** Inspect one native Desktop release without installing or publishing it. */

import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, type Dirent, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { path7za } from '7zip-bin'
import { execa } from 'execa'
import * as tar from 'tar'
import {
  parseReleaseUpdateConfiguration,
  releaseManifestEndpoint,
  releaseRollbackManifestEndpoint,
  type ReleaseUpdateTarget,
} from '@harness-desktop/dsh-update-policy'
import { productMetadata } from '../../packages/boot/app-boot/src/product-metadata.ts'
import desktopPackage from '../../apps/desktop/package.json' with { type: 'json' }
import {
  appImageFilesystemSnapshot,
  inspectUpdateArtifact,
  inspectUpdateArtifactSnapshot,
} from './verify-update-manifests.ts'

const root = resolve(import.meta.dirname, '../..')
const generatedIconNames = {
  win32: 'harness-desktop.ico',
  darwin: 'harness-desktop.icns',
  linux: 'harness-desktop.png',
} as const
const updatePolicyResource = 'update-policy.json'
const windowsRollbackWorkerResource = 'windows-native-rollback-worker.ps1'
const nativeRollbackWorkerResource = 'native-rollback-worker.js'
const windowsNativeUpdateSupervisorResource = 'windows-native-update-supervisor.exe'
const nativeRollbackWorkerChunkDirectory = 'chunks'
const windowsResourceDirectory = 'resources'
const appImageResourceDirectory = 'resources'
const debResourceDirectory = 'opt/Harness Desktop/resources'
const linuxNodePtyBinding = 'app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'
const packagedRuntimeAsarEntries = [
  'node_modules/@harness-desktop/dsh-host-local-runtime/lib/bin.js',
  'node_modules/@harness-desktop/dsh-home-paths/package.json',
  'node_modules/@harness-desktop/dsh-home-paths/lib/index.js',
] as const
// Fixed verifier safety limits leave headroom for a universal Electron bundle while
// preventing one release candidate from consuming unbounded memory, CPU, or temp disk.
const maxZipSymbolicLinkTargetBytes = 4 * 1_024
const maxZipSymbolicLinkCompressedBytes = 8 * 1_024
const maxZipMemberCompressedBytes = 512 * 1_024 * 1_024
const maxZipTotalCompressedBytes = 1 * 1_024 * 1_024 * 1_024
const maxZipMemberUncompressedBytes = 512 * 1_024 * 1_024
const maxZipTotalUncompressedBytes = 2 * 1_024 * 1_024 * 1_024
const maxZipArchiveBytes = 1_280 * 1_024 * 1_024

/** Exact packaged bytes for resources that authorize detached rollback execution. */
export interface RollbackWorkerResources {
  readonly windowsRollbackWorker: Buffer | undefined
  readonly nativeRollbackWorker: Buffer | undefined
  /** Exact emitted Rollup chunks imported by the detached native rollback program. */
  readonly nativeRollbackWorkerChunks: Readonly<Record<string, Buffer | undefined>>
}

/** File members and the exact public policy extracted from one immutable installer. */
export interface EmbeddedPolicyInspection extends RollbackWorkerResources {
  readonly entries: readonly string[]
  /** Policy bytes read from the final distributable's intended resource path. */
  readonly updatePolicy: Buffer | undefined
}

/** Windows installer resources that must remain byte-identical to the current native build. */
export interface WindowsInstallerInspection extends EmbeddedPolicyInspection {
  readonly windowsNativeUpdateSupervisor: Buffer | undefined
  /** SHA-256 of the exact app.asar carried by the selected installer. */
  readonly appAsarSha256: string | undefined
}

/** Results returned by native tools after inspecting a mounted macOS DMG. */
export interface MacDmgInspection extends EmbeddedPolicyInspection {
  readonly lipoInfo: string
}

/** Native-tool operations isolated for platform-independent unit tests. */
export interface DesktopArtifactTools {
  inspectCanonicalRollbackWorkers(): Promise<RollbackWorkerResources>
  inspectCanonicalWindowsSupervisor(): Promise<Buffer>
  inspectWindowsInstaller(path: string, nativeRollbackWorkerChunks: readonly string[]): Promise<WindowsInstallerInspection>
  inspectAsar(path: string): Promise<readonly string[]>
  /** @param path - unpacked app.asar. @returns SHA-256 of the exact file bytes. */
  inspectAsarSha256(path: string): Promise<string>
  /**
   * @param executable - unpacked Electron executable owned by the inspected release.
   * @param asar - matching packaged application archive.
   * @returns whether Electron loads and cleanly stops the packaged Runtime entry.
   */
  loadPackagedRuntime(executable: string, asar: string): Promise<boolean>
  inspectMacDmg(path: string, nativeRollbackWorkerChunks: readonly string[]): Promise<MacDmgInspection>
  inspectMacZip(path: string, nativeRollbackWorkerChunks: readonly string[]): Promise<MacDmgInspection>
  inspectAppImage(path: string, nativeRollbackWorkerChunks: readonly string[]): Promise<EmbeddedPolicyInspection>
  inspectDeb(path: string, nativeRollbackWorkerChunks: readonly string[]): Promise<EmbeddedPolicyInspection>
}

/** Inputs selecting the current runner's native artifact matrix. */
export interface DesktopArtifactVerificationInput {
  readonly platform: NodeJS.Platform
  readonly releaseDirectory: string
  /** Artifact version expected from the current package build; other versions are ignored as stale local evidence. */
  readonly expectedVersion?: string
}

/** Filesystem operations used to prove private artifact snapshot semantics in focused tests. */
export interface ArtifactSnapshotOperations {
  readFile(path: string, maxBytes?: number): Promise<Buffer>
  mkdtemp(prefix: string): Promise<string>
  writeFile(path: string, bytes: Buffer, options: { readonly flag: 'wx'; readonly mode: 0o600 }): Promise<void>
  removeDirectory(path: string): Promise<void>
}

/** Native Debian command seam used to prove preflight precedes extraction. */
export type DebInspectionCommandRunner = (
  args: readonly string[],
  stdoutFile?: string,
) => Promise<void>

/**
 * Verify the installer matrix for one native runner.
 * @param input - native platform and Electron Builder release directory.
 * @returns diagnostics; an empty array means every expected artifact and icon was found.
 */
export async function verifyDesktopArtifacts(
  input: DesktopArtifactVerificationInput,
): Promise<readonly string[]> {
  return verifyDesktopArtifactsWithTools({
    ...input,
    expectedVersion: input.expectedVersion ?? desktopPackage.version,
  }, nativeDesktopArtifactTools)
}

/**
 * Verify native artifacts with injected external-tool operations.
 * @param input - native platform and Electron Builder release directory.
 * @param tools - native installer inspection operations.
 * @returns diagnostics; an empty array means the selected artifact matrix is complete.
 */
export async function verifyDesktopArtifactsWithTools(
  input: DesktopArtifactVerificationInput,
  tools: DesktopArtifactTools,
): Promise<readonly string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(input.releaseDirectory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    entries = []
  }
  switch (input.platform) {
    case 'win32':
      return verifyWindows(input.releaseDirectory, entries, tools, input.expectedVersion)
    case 'darwin':
      return verifyMac(input.releaseDirectory, entries, tools, input.expectedVersion)
    case 'linux':
      return verifyLinux(input.releaseDirectory, entries, tools, input.expectedVersion)
    default:
      return [`desktop artifact: unsupported platform ${input.platform}`]
  }
}

async function verifyWindows(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
  expectedVersion: string | undefined,
): Promise<readonly string[]> {
  const violations: string[] = []
  const canonicalSupervisor = await tools.inspectCanonicalWindowsSupervisor()
  let installerAsarSha256: string | undefined
  const installers = entries.filter(entry => entry.isFile()
    && /^Harness Desktop Setup \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/u.test(entry.name)
    && (expectedVersion === undefined || entry.name === `Harness Desktop Setup ${expectedVersion}.exe`))
  const installer = installers[0]
  if (installers.length === 0) violations.push('desktop artifact: missing Windows NSIS installer')
  else if (installers.length > 1) violations.push('desktop artifact: expected exactly one Windows NSIS installer')
  else if (installer !== undefined) {
    const canonicalWorkers = await tools.inspectCanonicalRollbackWorkers()
    const inspection = await tools.inspectWindowsInstaller(
      join(releaseDirectory, installer.name),
      Object.keys(canonicalWorkers.nativeRollbackWorkerChunks),
    )
    installerAsarSha256 = inspection.appAsarSha256
    const version = artifactVersion(installer.name, 'Windows NSIS installer', 'Harness Desktop Setup ', '.exe')
    verifyEmbeddedResources(inspection, canonicalWorkers, windowsResourceDirectory, 'Windows', violations)
    verifyWindowsSupervisorResource(
      inspection.entries,
      inspection.windowsNativeUpdateSupervisor,
      canonicalSupervisor,
      `${windowsResourceDirectory}/${windowsNativeUpdateSupervisorResource}`,
      'Windows native update supervisor resource',
      violations,
    )
    if (containsExactEntry(inspection.entries, `${windowsResourceDirectory}/${updatePolicyResource}`)) {
      verifyEmbeddedPolicy(
        inspection.updatePolicy,
        'Windows',
        desktopTarget('win32', runtimeDesktopArchitecture(), 'nsis'),
        version,
        violations,
      )
    }
  }

  const unpacked = entries.filter(entry => entry.isDirectory()
    && /^win(?:-(?:arm64|ia32))?-unpacked$/u.test(entry.name))
  const unpackedDirectory = unpacked.length === 1 ? unpacked[0] : undefined
  const executable = unpackedDirectory !== undefined
    ? join(releaseDirectory, unpackedDirectory.name, 'harness-desktop.exe')
    : undefined
  const asar = unpackedDirectory !== undefined
    ? join(releaseDirectory, unpackedDirectory.name, 'resources', 'app.asar')
    : undefined
  const unpackedSupervisor = unpackedDirectory !== undefined
    ? join(releaseDirectory, unpackedDirectory.name, 'resources', windowsNativeUpdateSupervisorResource)
    : undefined
  const executablePresent = executable !== undefined && await exists(executable)
  if (!executablePresent) {
    violations.push('desktop artifact: missing unpacked Windows executable')
  }
  let packagedRuntimeMembersPresent = false
  if (asar === undefined || !(await exists(asar))) {
    violations.push('desktop artifact: missing unpacked Windows resources/app.asar')
  } else {
    const asarEntries = await tools.inspectAsar(asar)
    if (!containsIcon(asarEntries, generatedIconNames.win32)) {
      violations.push('desktop artifact: missing generated Windows icon')
    }
    packagedRuntimeMembersPresent = packagedRuntimeAsarEntries.every(entry => containsExactAsarEntry(asarEntries, entry))
    if (!packagedRuntimeMembersPresent) {
      violations.push('desktop artifact: packaged Runtime cannot resolve @harness-desktop/dsh-home-paths')
    }
    if (installer !== undefined && await tools.inspectAsarSha256(asar) !== installerAsarSha256) {
      violations.push('desktop artifact: unpacked Windows app.asar does not match the selected installer')
    }
  }
  if (executablePresent && asar !== undefined && packagedRuntimeMembersPresent
    && !await tools.loadPackagedRuntime(executable, asar)) {
    violations.push('desktop artifact: packaged Runtime entry cannot load')
  }
  if (unpackedSupervisor === undefined) {
    violations.push('desktop artifact: missing unpacked Windows native update supervisor resource')
  } else {
    const supervisorBytes = await readRegularBytes(unpackedSupervisor)
    if (supervisorBytes === undefined) {
      violations.push('desktop artifact: missing unpacked Windows native update supervisor resource')
    } else {
      if (!supervisorBytes.equals(canonicalSupervisor)) {
        violations.push('desktop artifact: unpacked Windows native update supervisor resource does not match canonical bytes')
      }
      if (verifyWindowsSupervisor(supervisorBytes) === undefined) {
        violations.push(
          'desktop artifact: unpacked Windows native update supervisor resource is not an AMD64 Windows GUI executable',
        )
      }
    }
  }
  return violations
}

function verifyWindowsSupervisorResource(
  entries: readonly string[],
  bytes: Buffer | undefined,
  canonical: Buffer,
  resourcePath: string,
  label: string,
  violations: string[],
): void {
  if (!containsExactEntry(entries, resourcePath)) {
    violations.push(`desktop artifact: missing ${label}`)
    return
  }
  if (bytes === undefined) {
    violations.push(`desktop artifact: cannot read ${label}`)
    return
  }
  if (!bytes.equals(canonical)) {
    violations.push(`desktop artifact: ${label} does not match canonical bytes`)
  }
  if (verifyWindowsSupervisor(bytes) === undefined) {
    violations.push(`desktop artifact: ${label} is not an AMD64 Windows GUI executable`)
  }
}

/**
 * Read the architecture and subsystem asserted by a Windows supervisor PE image.
 * @param bytes - Complete executable bytes from one immutable artifact snapshot.
 * @returns The supported metadata, or undefined for a malformed or unsupported PE image.
 */
export function verifyWindowsSupervisor(
  bytes: Buffer,
): { readonly machine: 'amd64'; readonly subsystem: 'windows-gui' } | undefined {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return undefined
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset > bytes.length - 24 || bytes.readUInt32LE(peOffset) !== 0x00004550) return undefined
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) return undefined
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20)
  const optionalHeader = peOffset + 24
  if (optionalHeaderSize < 70 || optionalHeader > bytes.length - optionalHeaderSize) return undefined
  if (bytes.readUInt16LE(optionalHeader) !== 0x20b) return undefined
  if (bytes.readUInt16LE(optionalHeader + 68) !== 2) return undefined
  return { machine: 'amd64', subsystem: 'windows-gui' }
}

async function verifyMac(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
  expectedVersion: string | undefined,
): Promise<readonly string[]> {
  const violations: string[] = []
  const images = entries.filter(entry => entry.isFile()
    && /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-universal\.dmg$/u.test(entry.name)
    && (expectedVersion === undefined || entry.name === `Harness Desktop-${expectedVersion}-universal.dmg`))
  const archives = entries.filter(entry => entry.isFile()
    && /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-universal-mac\.zip$/u.test(entry.name)
    && (expectedVersion === undefined || entry.name === `Harness Desktop-${expectedVersion}-universal-mac.zip`))
  if (images.length === 0) return ['desktop artifact: missing macOS universal DMG']
  if (images.length > 1) return ['desktop artifact: expected exactly one macOS universal DMG']
  if (archives.length === 0) return ['desktop artifact: missing macOS universal ZIP']
  if (archives.length > 1) return ['desktop artifact: expected exactly one macOS universal ZIP']
  const image = images[0]
  const archive = archives[0]
  if (image === undefined) throw new Error('desktop artifact: validated macOS DMG disappeared')
  if (archive === undefined) throw new Error('desktop artifact: validated macOS ZIP disappeared')
  const canonicalWorkers = await tools.inspectCanonicalRollbackWorkers()
  const nativeRollbackWorkerChunks = Object.keys(canonicalWorkers.nativeRollbackWorkerChunks)
  const inspection = await tools.inspectMacDmg(join(releaseDirectory, image.name), nativeRollbackWorkerChunks)
  const zipInspection = await tools.inspectMacZip(join(releaseDirectory, archive.name), nativeRollbackWorkerChunks)
  const imageVersion = artifactVersion(image.name, 'macOS DMG', 'Harness Desktop-', '-universal.dmg')
  const archiveVersion = artifactVersion(archive.name, 'macOS ZIP', 'Harness Desktop-', '-universal-mac.zip')
  if (imageVersion !== archiveVersion) {
    violations.push('desktop artifact: macOS DMG and ZIP semantic versions differ')
  }
  verifyMacInspection(inspection, canonicalWorkers, 'DMG', imageVersion, violations)
  verifyMacInspection(zipInspection, canonicalWorkers, 'ZIP', archiveVersion, violations)
  verifyPairedPolicyBytes(inspection, zipInspection, 'macOS DMG and ZIP', violations)
  return violations
}

function verifyMacInspection(
  inspection: MacDmgInspection,
  canonicalWorkers: RollbackWorkerResources,
  format: 'DMG' | 'ZIP',
  version: string,
  violations: string[],
): void {
  if (!/\bx86_64\b/u.test(inspection.lipoInfo)) {
    violations.push(`desktop artifact: macOS ${format} application binary is missing x86_64 architecture`)
  }
  if (!/\barm64\b/u.test(inspection.lipoInfo)) {
    violations.push(`desktop artifact: macOS ${format} application binary is missing arm64 architecture`)
  }
  if (!containsIcon(inspection.entries, generatedIconNames.darwin)) {
    violations.push(`desktop artifact: missing generated macOS ${format} icon`)
  }
  verifyEmbeddedResources(inspection, canonicalWorkers, 'Contents/Resources', `macOS ${format}`, violations)
  if (containsExactEntry(inspection.entries, 'Contents/Resources/update-policy.json')) {
    verifyEmbeddedPolicy(
      inspection.updatePolicy,
      `macOS ${format}`,
      desktopTarget('darwin', 'universal', 'zip'),
      version,
      violations,
    )
  }
}

async function verifyLinux(
  releaseDirectory: string,
  entries: readonly Dirent[],
  tools: DesktopArtifactTools,
  expectedVersion: string | undefined,
): Promise<readonly string[]> {
  const violations: string[] = []
  const appImages = entries.filter(entry => entry.isFile()
    && /^Harness Desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.AppImage$/u.test(entry.name)
    && (expectedVersion === undefined || entry.name === `Harness Desktop-${expectedVersion}.AppImage`))
  const debs = entries.filter(entry => entry.isFile()
    && /^harness-desktop_\d+\.\d+\.\d+(?:[+~.-][0-9A-Za-z.-]+)?_(?:amd64|arm64)\.deb$/u.test(entry.name)
    && (expectedVersion === undefined || entry.name.startsWith(`harness-desktop_${expectedVersion}_`)))
  if (appImages.length === 0) violations.push('desktop artifact: missing Linux AppImage')
  else if (appImages.length > 1) violations.push('desktop artifact: expected exactly one Linux AppImage')
  if (debs.length === 0) violations.push('desktop artifact: missing Linux Deb installer')
  else if (debs.length > 1) violations.push('desktop artifact: expected exactly one Linux Deb installer')

  const appImage = appImages.length === 1 ? appImages[0] : undefined
  const deb = debs.length === 1 ? debs[0] : undefined
  const canonicalWorkers = appImage !== undefined || deb !== undefined
    ? await tools.inspectCanonicalRollbackWorkers()
    : undefined
  let appImageInspection: EmbeddedPolicyInspection | undefined
  let debInspection: EmbeddedPolicyInspection | undefined
  const nativeRollbackWorkerChunks = canonicalWorkers === undefined
    ? []
    : Object.keys(canonicalWorkers.nativeRollbackWorkerChunks)
  if (appImage !== undefined) {
    const inspected = await tools.inspectAppImage(join(releaseDirectory, appImage.name), nativeRollbackWorkerChunks)
    appImageInspection = inspected
    if (!containsIcon(inspected.entries, generatedIconNames.linux)) {
      violations.push('desktop artifact: missing generated Linux AppImage icon')
    }
    verifyLinuxResources(
      inspected,
      canonicalWorkers,
      'AppImage',
      appImageResourceDirectory,
      desktopTarget('linux', runtimeDesktopArchitecture(), 'appimage'),
      artifactVersion(appImage.name, 'Linux AppImage', 'Harness Desktop-', '.AppImage'),
      violations,
    )
  }
  if (deb !== undefined) {
    const inspected = await tools.inspectDeb(join(releaseDirectory, deb.name), nativeRollbackWorkerChunks)
    debInspection = inspected
    if (!containsIcon(inspected.entries, generatedIconNames.linux)) {
      violations.push('desktop artifact: missing generated Linux Deb icon')
    }
    // The system package manager owns Debian replacement, so its embedded policy
    // is syntax-checked without requiring a Desktop self-update endpoint.
    verifyLinuxResources(
      inspected,
      canonicalWorkers,
      'Deb',
      debResourceDirectory,
      undefined,
      undefined,
      violations,
    )
  }
  if (appImage !== undefined && deb !== undefined && appImageInspection !== undefined && debInspection !== undefined) {
    const appImageVersion = artifactVersion(appImage.name, 'Linux AppImage', 'Harness Desktop-', '.AppImage')
    const debVersion = debArtifactVersion(deb.name)
    if (appImageVersion !== debVersion) {
      violations.push('desktop artifact: Linux AppImage and Deb semantic versions differ')
    }
    verifyPairedPolicyBytes(appImageInspection, debInspection, 'Linux AppImage and Deb', violations)
  }
  return violations
}

function containsIcon(entries: readonly string[], filename: string): boolean {
  return entries.some(entry => basename(entry.replaceAll('\\', '/')) === filename)
}

function verifyLinuxResources(
  inspection: EmbeddedPolicyInspection,
  canonicalWorkers: RollbackWorkerResources | undefined,
  format: 'AppImage' | 'Deb',
  resourceDirectory: string,
  target: ReleaseUpdateTarget | undefined,
  version: string | undefined,
  violations: string[],
): void {
  if (canonicalWorkers === undefined) throw new Error('desktop artifact: canonical rollback workers were not loaded')
  const label = `Linux ${format}`
  verifyEmbeddedResources(inspection, canonicalWorkers, resourceDirectory, label, violations)
  verifyLinuxNodePtyBinding(inspection.entries, resourceDirectory, label, violations)
  if (containsExactEntry(inspection.entries, `${resourceDirectory}/${updatePolicyResource}`)) {
    verifyEmbeddedPolicy(inspection.updatePolicy, label, target, version, violations)
  }
}

function verifyLinuxNodePtyBinding(
  entries: readonly string[],
  resourceDirectory: string,
  label: string,
  violations: string[],
): void {
  if (!containsExactEntry(entries, `${resourceDirectory}/${linuxNodePtyBinding}`)) {
    violations.push(`desktop artifact: missing ${label} node-pty native binding`)
  }
}

function verifyEmbeddedResources(
  inspection: EmbeddedPolicyInspection,
  canonicalWorkers: RollbackWorkerResources,
  resourceDirectory: string,
  platform: string,
  violations: string[],
): void {
  const resources = {
    updatePolicy: { filename: updatePolicyResource, bytes: inspection.updatePolicy, canonical: undefined },
    windowsRollbackWorker: {
      filename: windowsRollbackWorkerResource,
      bytes: inspection.windowsRollbackWorker,
      canonical: canonicalWorkers.windowsRollbackWorker,
    },
    nativeRollbackWorker: {
      filename: nativeRollbackWorkerResource,
      bytes: inspection.nativeRollbackWorker,
      canonical: canonicalWorkers.nativeRollbackWorker,
    },
  }
  for (const [kind, resource] of Object.entries(resources)) {
    if (!containsExactEntry(inspection.entries, `${resourceDirectory}/${resource.filename}`)) {
      const description = resourceDescription(kind)
      violations.push(`desktop artifact: missing ${platform} ${description}`)
      continue
    }
    if (kind === 'updatePolicy') continue
    const description = resourceDescription(kind)
    if (resource.bytes === undefined) {
      violations.push(`desktop artifact: cannot read ${platform} ${description}`)
      continue
    }
    if (resource.canonical === undefined || !resource.bytes.equals(resource.canonical)) {
      violations.push(`desktop artifact: ${platform} ${description} does not match canonical bytes`)
    }
  }
  verifyNativeRollbackWorkerChunks(inspection, canonicalWorkers, resourceDirectory, platform, violations)
}

/** Verify every split module required by the detached native rollback program. */
function verifyNativeRollbackWorkerChunks(
  inspection: EmbeddedPolicyInspection,
  canonicalWorkers: RollbackWorkerResources,
  resourceDirectory: string,
  platform: string,
  violations: string[],
): void {
  for (const [filename, canonical] of Object.entries(canonicalWorkers.nativeRollbackWorkerChunks)) {
    const resource = `${nativeRollbackWorkerChunkDirectory}/${filename}`
    if (!containsExactEntry(inspection.entries, `${resourceDirectory}/${resource}`)) {
      violations.push(`desktop artifact: missing ${platform} native rollback program chunk ${JSON.stringify(filename)}`)
      continue
    }
    const bytes = inspection.nativeRollbackWorkerChunks[filename]
    if (bytes === undefined) {
      violations.push(`desktop artifact: cannot read ${platform} native rollback program chunk ${JSON.stringify(filename)}`)
      continue
    }
    if (canonical === undefined || !bytes.equals(canonical)) {
      violations.push(`desktop artifact: ${platform} native rollback program chunk ${JSON.stringify(filename)} does not match canonical bytes`)
    }
  }
}

function resourceDescription(kind: string): string {
  const description = kind === 'updatePolicy'
    ? 'update policy resource'
    : kind === 'windowsRollbackWorker'
      ? 'Windows native rollback worker resource'
      : 'native rollback program resource'
  return description
}

function verifyEmbeddedPolicy(
  bytes: Buffer | undefined,
  platform: string,
  target: ReleaseUpdateTarget | undefined,
  version: string | undefined,
  violations: string[],
): void {
  if (bytes === undefined) {
    violations.push(`desktop artifact: cannot read ${platform} update policy resource`)
    return
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const configuration = parseReleaseUpdateConfiguration(JSON.parse(text) as unknown, productMetadata.appId)
    if (target !== undefined && (version === undefined
      || releaseManifestEndpoint(configuration, target) === undefined
      || releaseRollbackManifestEndpoint(configuration, { ...target, currentVersion: version }) === undefined)) {
      throw new Error('release policy does not serve the installed target')
    }
  } catch {
    violations.push(`desktop artifact: ${platform} update policy resource is invalid`)
  }
}

function verifyPairedPolicyBytes(
  left: EmbeddedPolicyInspection,
  right: EmbeddedPolicyInspection,
  label: string,
  violations: string[],
): void {
  if (left.updatePolicy !== undefined && right.updatePolicy !== undefined
    && !left.updatePolicy.equals(right.updatePolicy)) {
    violations.push(`desktop artifact: ${label} update policy bytes differ`)
  }
}

function containsExactEntry(entries: readonly string[], expected: string): boolean {
  return entries.some(entry => entry.replaceAll('\\', '/') === expected)
}

function containsExactAsarEntry(entries: readonly string[], expected: string): boolean {
  return entries.some(entry => entry.replaceAll('\\', '/').replace(/^\//u, '') === expected)
}

function artifactVersion(name: string, label: string, prefix: string, suffix: string): string {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    throw new Error(`desktop artifact: ${label} filename does not identify its version`)
  }
  const version = name.slice(prefix.length, -suffix.length)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`desktop artifact: ${label} has no semantic version`)
  }
  return version
}

function debArtifactVersion(name: string): string {
  const match = /^harness-desktop_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_(?:amd64|arm64)\.deb$/u.exec(name)
  const version = match?.[1]
  if (version === undefined) throw new Error('desktop artifact: Linux Deb installer has no semantic version')
  return version
}

function desktopTarget(
  platform: ReleaseUpdateTarget['platform'],
  arch: ReleaseUpdateTarget['arch'],
  format: ReleaseUpdateTarget['format'],
): ReleaseUpdateTarget {
  return { channel: 'stable', consumer: 'desktop', platform, arch, format }
}

function runtimeDesktopArchitecture(): 'x64' | 'arm64' {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`desktop artifact: unsupported runner architecture ${process.arch}`)
}

/** Load the exact packaged Runtime entry through Electron's Node mode and require a clean stdin-owned lifetime. */
async function loadPackagedRuntime(executable: string, asar: string): Promise<boolean> {
  const home = await mkdtemp(join(tmpdir(), 'harness-desktop-runtime-load-'))
  const entry = process.platform === 'win32'
    ? `${asar.replaceAll('\\', '/')}/${packagedRuntimeAsarEntries[0]}`
    : join(asar, ...packagedRuntimeAsarEntries[0].split('/'))
  try {
    const platformHome = join(home, 'platform-home')
    const readyFile = join(home, 'runtime-ready')
    const probePath = join(home, 'packaged-runtime-probe.mjs')
    if (process.platform !== 'win32') {
      await writeFile(probePath, `await import(${JSON.stringify(pathToFileURL(entry).href)})\n`, { mode: 0o600 })
    }
    await mkdir(join(platformHome, 'AppData', 'Roaming'), { recursive: true })
    await mkdir(join(platformHome, 'AppData', 'Local'), { recursive: true })
    return await new Promise<boolean>((resolveLoad) => {
      const environment = packagedRuntimeEnvironment(home, platformHome)
      const args = process.platform === 'win32' ? [] : [probePath]
      if (process.platform === 'win32') {
        delete environment.ELECTRON_RUN_AS_NODE
        environment.DSH_DESKTOP_RUNTIME_PROBE = '1'
      }
      const child = spawn(executable, args, {
        cwd: home,
        env: { ...environment, DSH_RUNTIME_READY_FILE: readyFile },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let forcedFailure = false
      let stdinClosed = false
      let readyFileSeen = false
      const outputLimit = 16 * 1_024
      const isReady = (): boolean => stdout.includes('harness-runtime: ready ')
        || stderr.includes('harness-runtime: ready ')
        || readyFileSeen
      const closeInputWhenReady = (): void => {
        if (!stdinClosed && isReady()) {
          stdinClosed = true
          child.stdin.end()
        }
      }
      const appendOutput = (target: 'stdout' | 'stderr', chunk: string): void => {
        if (target === 'stdout') stdout += chunk
        else stderr += chunk
        if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > outputLimit) {
          forcedFailure = true
          child.kill()
          return
        }
        closeInputWhenReady()
      }
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(readyPoller)
        resolveLoad(value)
      }
      const timer = setTimeout(() => {
        forcedFailure = true
        child.kill('SIGKILL')
        if (process.platform === 'win32' && child.pid !== undefined && process.env.SystemRoot !== undefined) {
          spawn(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), [
            '/PID', String(child.pid), '/T', '/F',
          ], { stdio: 'ignore', windowsHide: true })
        }
      }, 30_000)
      const readyPoller = setInterval(() => {
        if (readyFileSeen || settled) return
        void exists(readyFile).then((present) => {
          if (!present || readyFileSeen || settled) return
          readyFileSeen = true
          closeInputWhenReady()
        })
      }, 25)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { appendOutput('stdout', chunk) })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { appendOutput('stderr', chunk) })
      child.once('error', (error) => {
        console.error(`desktop artifact: packaged Runtime process error: ${error instanceof Error ? error.message : String(error)}`)
        finish(false)
      })
      child.once('exit', (code, signal) => {
        const ready = isReady()
        const loaded = !forcedFailure && code === 0 && ready
          && !`${stdout}\n${stderr}`.includes('ERR_MODULE_NOT_FOUND')
        if (!loaded) {
          const detail = packagedRuntimeDiagnostic(`${stdout}\n${stderr}`)
          const status = forcedFailure ? 'forced-failure' : `exit-${String(code)}`
          console.error(`desktop artifact: packaged Runtime status=${status} signal=${String(signal)} ready=${String(ready)}${detail === '' ? '' : ` stderr=${detail}`}`)
        }
        finish(loaded)
      })
    })
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

function packagedRuntimeDiagnostic(stderr: string): string {
  return stderr
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+/gu, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4 * 1_024)
}

function packagedRuntimeEnvironment(home: string, platformHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    HARNESS_HOME: home,
    HARNESS_RUNTIME_TEST_MODE: 'stdin-lifetime',
    DSH_TELEMETRY_DISABLED: '1',
    HOME: platformHome,
    USERPROFILE: platformHome,
    APPDATA: join(platformHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(platformHome, 'AppData', 'Local'),
  }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'] as const) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function lines(command: string, args: readonly string[], cwd?: string): Promise<readonly string[]> {
  const result = await execa(command, [...args], { ...(cwd === undefined ? {} : { cwd }), reject: true })
  return result.stdout.split(/\r?\n/u).filter(Boolean)
}

const nativeDesktopArtifactTools: DesktopArtifactTools = {
  async inspectCanonicalRollbackWorkers() {
    return {
      windowsRollbackWorker: await readRequiredRegularBytes(
        join(root, 'apps', 'desktop', 'resources', 'update', windowsRollbackWorkerResource),
      ),
      nativeRollbackWorker: await readRequiredRegularBytes(
        join(root, 'apps', 'desktop', 'out', 'main', nativeRollbackWorkerResource),
      ),
      nativeRollbackWorkerChunks: await readCanonicalNativeRollbackWorkerChunks(),
    }
  },
  async inspectCanonicalWindowsSupervisor() {
    return readRequiredRegularBytes(
      join(root, 'apps', 'desktop', 'out', 'native', 'win32-x64', windowsNativeUpdateSupervisorResource),
    )
  },
  async inspectWindowsInstaller(path, nativeRollbackWorkerChunks) {
    return inspectPrivateArtifactSnapshot(path, 'artifact.exe', async snapshotPath => ({
      entries: (await inspectUpdateArtifact(snapshotPath, 'nsis')).members,
      appAsarSha256: await extract7ZipSha256(
        path7za,
        snapshotPath,
        `${windowsResourceDirectory}/app.asar`,
      ),
      windowsNativeUpdateSupervisor: await extract7ZipBytes(
        path7za,
        snapshotPath,
        `${windowsResourceDirectory}/${windowsNativeUpdateSupervisorResource}`,
      ),
      ...await extract7ZipResources(snapshotPath, windowsResourceDirectory, nativeRollbackWorkerChunks),
    }))
  },
  async inspectAsar(path) {
    return lines('pnpm', ['exec', 'asar', 'list', path], root)
  },
  async inspectAsarSha256(path) {
    return sha256File(path)
  },
  async loadPackagedRuntime(executable, asar) {
    return loadPackagedRuntime(executable, asar)
  },
  async inspectMacDmg(path, nativeRollbackWorkerChunks) {
    return inspectPrivateArtifactSnapshot(path, 'artifact.dmg', async (snapshotPath) => {
      await execa('hdiutil', ['imageinfo', snapshotPath], { reject: true })
      const mount = await mkdtemp(join(tmpdir(), 'harness-desktop-dmg-'))
      let attached = false
      try {
        await execa('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, snapshotPath], { reject: true })
        attached = true
        return await inspectMacApplication(await findMacApplication(mount), nativeRollbackWorkerChunks)
      } finally {
        if (attached) await execa('hdiutil', ['detach', mount], { reject: true })
        await rm(mount, { recursive: true, force: true })
      }
    })
  },
  async inspectMacZip(path, nativeRollbackWorkerChunks) {
    return inspectPrivateArtifactSnapshot(path, 'artifact.zip', async (snapshotPath, snapshot) => {
      assertSafeMacZipSnapshot(snapshot)
      const extraction = await mkdtemp(join(tmpdir(), 'harness-desktop-zip-'))
      try {
        await execa('ditto', ['-x', '-k', snapshotPath, extraction], { reject: true })
        return await inspectMacApplication(await findMacApplication(extraction), nativeRollbackWorkerChunks)
      } finally {
        await rm(extraction, { recursive: true, force: true })
      }
    }, nativeArtifactSnapshotOperations, maxZipArchiveBytes)
  },
  async inspectAppImage(path, nativeRollbackWorkerChunks) {
    return inspectAppImageResources(path, nativeRollbackWorkerChunks)
  },
  async inspectDeb(path, nativeRollbackWorkerChunks) {
    return inspectDebResources(path, nativeRollbackWorkerChunks)
  },
}

async function inspectAppImageResources(
  path: string,
  nativeRollbackWorkerChunks: readonly string[],
): Promise<EmbeddedPolicyInspection> {
  return inspectPrivateArtifactSnapshot(path, 'artifact.AppImage', async (_snapshotPath, snapshot) => {
    const entries = await inspectUpdateArtifactSnapshot(snapshot, 'appimage')
    const directory = await mkdtemp(join(tmpdir(), 'harness-desktop-appimage-'))
    const filesystemPath = join(directory, 'artifact.squashfs')
    const extraction = join(directory, 'extracted')
    try {
      await writeFile(filesystemPath, appImageFilesystemSnapshot(snapshot), { flag: 'wx', mode: 0o600 })
      await execa('unsquashfs', ['-no-progress', '-no-xattrs', '-dest', extraction, filesystemPath,
        ...embeddedResourcePaths(appImageResourceDirectory, nativeRollbackWorkerChunks)], {
        reject: true,
      })
      return {
        entries,
        ...await readExtractedResources(extraction, appImageResourceDirectory, nativeRollbackWorkerChunks),
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

async function inspectDebResources(
  path: string,
  nativeRollbackWorkerChunks: readonly string[],
): Promise<EmbeddedPolicyInspection> {
  return inspectPrivateArtifactSnapshot(path, 'artifact.deb', async snapshotPath => (
    inspectDebArtifactSnapshot(snapshotPath, nativeDpkgDebCommand, nativeRollbackWorkerChunks)
  ))
}

/**
 * Preflight one private Debian snapshot before extracting its filesystem payload.
 * @param artifact - private immutable Deb snapshot path.
 * @param runDpkgDeb - Debian reader used for payload streaming and extraction.
 * @returns members and security resources read from the extracted payload.
 */
export async function inspectDebArtifactSnapshot(
  artifact: string,
  runDpkgDeb: DebInspectionCommandRunner = nativeDpkgDebCommand,
  nativeRollbackWorkerChunks: readonly string[] = [],
): Promise<EmbeddedPolicyInspection> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-desktop-deb-'))
  const payloadArchive = join(directory, 'payload.tar')
  const extraction = join(directory, 'extracted')
  try {
    await writeFile(payloadArchive, '', { flag: 'wx', mode: 0o600 })
    await runDpkgDeb(['--fsys-tarfile', artifact], payloadArchive)
    await assertSafeDebTarFile(payloadArchive)
    await runDpkgDeb(['--extract', artifact, extraction])
    return {
      entries: await recursiveEntries(extraction),
      ...await readExtractedResources(extraction, debResourceDirectory, nativeRollbackWorkerChunks),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function nativeDpkgDebCommand(args: readonly string[], stdoutFile?: string): Promise<void> {
  if (stdoutFile !== undefined) {
    await writeCommandStdoutToFile('dpkg-deb', args, stdoutFile)
    return
  }
  await execa('dpkg-deb', [...args], {
    reject: true,
  })
}

/**
 * Stream one native command's stdout directly to a caller-owned file without buffering a package payload in memory.
 * @param command - fixed native command selected by the caller.
 * @param args - literal command arguments.
 * @param destination - private output file that receives stdout.
 */
export async function writeCommandStdoutToFile(
  command: string,
  args: readonly string[],
  destination: string,
): Promise<void> {
  const handle = await open(destination, 'w')
  try {
    await new Promise<void>((resolveCommand, rejectCommand) => {
      const child = spawn(command, [...args], {
        stdio: ['ignore', handle.fd, 'pipe'],
        windowsHide: true,
      })
      const stderr: Buffer[] = []
      let stderrBytes = 0
      const stderrLimit = 16 * 1_024
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= stderrLimit) return
        const retained = chunk.subarray(0, stderrLimit - stderrBytes)
        stderr.push(retained)
        stderrBytes += retained.length
      })
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        callback()
      }
      child.once('error', (error) => {
        finish(() => {
          rejectCommand(error)
        })
      })
      child.once('close', (code, signal) => {
        if (code === 0) {
          finish(resolveCommand)
          return
        }
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        const outcome = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
        finish(() => {
          rejectCommand(new Error(`${command} failed with ${outcome}${detail === '' ? '' : `: ${detail}`}`))
        })
      })
    })
  } finally {
    await handle.close()
  }
}

async function extract7ZipBytes(command: string, artifact: string, resource: string): Promise<Buffer | undefined> {
  const result = await execa(command, ['x', '-so', '--', artifact, resource], {
    encoding: 'buffer',
    reject: false,
    stripFinalNewline: false,
  })
  if (result.exitCode !== 0) return undefined
  return Buffer.from(result.stdout)
}

async function extract7ZipSha256(command: string, artifact: string, resource: string): Promise<string | undefined> {
  return new Promise((resolveDigest, rejectDigest) => {
    const child = spawn(command, ['x', '-so', '--', artifact, resource], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const hash = createHash('sha256')
    let bytes = 0
    let exceeded = false
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxZipMemberUncompressedBytes) {
        exceeded = true
        child.kill()
        return
      }
      hash.update(chunk)
    })
    child.once('error', rejectDigest)
    child.once('exit', (code) => {
      if (exceeded) rejectDigest(new Error('desktop artifact: Windows app.asar exceeds inspection limit'))
      else resolveDigest(code === 0 ? hash.digest('hex') : undefined)
    })
  })
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, rejectDigest) => {
    const stream = createReadStream(path)
    const hash = createHash('sha256')
    stream.on('data', (chunk) => { hash.update(chunk) })
    stream.once('error', rejectDigest)
    stream.once('end', () => { resolveDigest(hash.digest('hex')) })
  })
}

async function extract7ZipResources(
  artifact: string,
  resourceDirectory: string,
  nativeRollbackWorkerChunks: readonly string[],
): Promise<Omit<EmbeddedPolicyInspection, 'entries'>> {
  const paths = embeddedResourcePaths(resourceDirectory, nativeRollbackWorkerChunks)
  const bytes = await Promise.all(paths.map(resource => extract7ZipBytes(path7za, artifact, resource)))
  return extractedResourceInspection(bytes, nativeRollbackWorkerChunks)
}

function embeddedResourcePaths(resourceDirectory: string, nativeRollbackWorkerChunks: readonly string[]): readonly string[] {
  return [updatePolicyResource, windowsRollbackWorkerResource, nativeRollbackWorkerResource,
    ...nativeRollbackWorkerChunks.map(chunk => `${nativeRollbackWorkerChunkDirectory}/${chunk}`)]
    .map(resource => `${resourceDirectory}/${resource}`)
}

async function readExtractedResources(
  extraction: string,
  resourceDirectory: string,
  nativeRollbackWorkerChunks: readonly string[],
): Promise<Omit<EmbeddedPolicyInspection, 'entries'>> {
  const paths = embeddedResourcePaths(resourceDirectory, nativeRollbackWorkerChunks)
  const bytes = await Promise.all(paths.map(resource => readRegularBytes(join(extraction, ...resource.split('/')))))
  return extractedResourceInspection(bytes, nativeRollbackWorkerChunks)
}

function extractedResourceInspection(
  bytes: readonly (Buffer | undefined)[],
  nativeRollbackWorkerChunks: readonly string[],
): Omit<EmbeddedPolicyInspection, 'entries'> {
  const [updatePolicy, windowsRollbackWorker, nativeRollbackWorker, ...chunks] = bytes
  return {
    updatePolicy,
    windowsRollbackWorker,
    nativeRollbackWorker,
    nativeRollbackWorkerChunks: Object.fromEntries(nativeRollbackWorkerChunks.map((chunk, index) => [chunk, chunks[index]])),
  }
}

async function readRegularBytes(path: string): Promise<Buffer | undefined> {
  try {
    const before = await lstat(path)
    if (!before.isFile()) return undefined
    const handle = await open(path, 'r')
    try {
      const opened = await handle.stat()
      const after = await lstat(path)
      if (!opened.isFile() || !after.isFile() || !sameFile(before, opened) || !sameFile(opened, after)) return undefined
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function readBoundedArtifact(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile()) throw new Error('desktop artifact: source artifact is not an ordinary file')
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error('desktop artifact: source artifact changed before snapshot')
    }
    const bytes = await readBoundedArtifactBytes(handle, opened.size, maxBytes)
    const after = await lstat(path)
    if (!after.isFile() || !sameFile(opened, after) || after.size !== opened.size) {
      throw new Error('desktop artifact: source artifact changed during snapshot')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

/**
 * Read exactly one observed file size while allowing only one byte of growth evidence.
 * @param handle - stable open file object.
 * @param expectedBytes - size observed from that handle before reading.
 * @param maxBytes - largest accepted artifact snapshot.
 * @returns exact bytes when the file reaches EOF at the observed size.
 */
export async function readBoundedArtifactBytes(
  handle: {
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>
  },
  expectedBytes: number,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new Error('desktop artifact: source artifact exceeds private snapshot size limit')
  }
  const bytes = Buffer.allocUnsafe(expectedBytes + 1)
  let total = 0
  while (total < bytes.length) {
    const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total !== expectedBytes) throw new Error('desktop artifact: source artifact changed during snapshot')
  return bytes.subarray(0, total)
}

/**
 * Reject a Debian filesystem tar stream that could redirect or create special files during extraction.
 * @param snapshot - exact uncompressed filesystem tar bytes emitted from the private Deb snapshot.
 */
export function assertSafeDebTarSnapshot(snapshot: Buffer): void {
  const entries: DebTarEntry[] = []
  const parser = tar.t({
    sync: true,
    strict: true,
    onReadEntry: collectDebTarEntry(entries),
  })
  parser.end(snapshot)
  assertSafeDebTarEntries(entries)
}

async function assertSafeDebTarFile(path: string): Promise<void> {
  const entries: DebTarEntry[] = []
  await tar.t({ file: path, strict: true, onReadEntry: collectDebTarEntry(entries) })
  assertSafeDebTarEntries(entries)
}

interface DebTarEntry {
  readonly path: string
  readonly type: tar.types.EntryTypeName
}

function collectDebTarEntry(entries: DebTarEntry[]): (entry: tar.ReadEntry) => void {
  return (entry) => {
    entries.push({ path: entry.path, type: entry.type })
    entry.resume()
  }
}

function assertSafeDebTarEntries(entries: readonly DebTarEntry[]): void {
  const paths = new Set<string>()
  for (const entry of entries) {
    const path = normalizedDebEntryPath(entry.path, entry.type === 'Directory')
    if (path !== '') {
      if (paths.has(path)) throw new Error(`desktop artifact: Linux Deb has duplicate payload member ${JSON.stringify(path)}`)
      paths.add(path)
    }
    if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
      throw new Error(`desktop artifact: Linux Deb has unsupported payload member type ${entry.type} at ${JSON.stringify(entry.path)}`)
    }
  }
}

function normalizedDebEntryPath(path: string, directory: boolean): string {
  let normalized = path.startsWith('./') ? path.slice(2) : path
  if (directory && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  if (normalized === '' && directory) return normalized
  if (normalized === '' || normalized.includes('\\') || normalized.includes('\0') || posix.isAbsolute(normalized)
    || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`desktop artifact: Linux Deb has unsafe payload member path ${JSON.stringify(path)}`)
  }
  return normalized
}

async function readRequiredRegularBytes(path: string): Promise<Buffer> {
  const bytes = await readRegularBytes(path)
  if (bytes === undefined) throw new Error(`desktop artifact: canonical rollback worker is not an ordinary file ${JSON.stringify(path)}`)
  return bytes
}

/** Read the emitted common modules copied beside the detached native rollback program. */
async function readCanonicalNativeRollbackWorkerChunks(): Promise<Readonly<Record<string, Buffer>>> {
  const directory = join(root, 'apps', 'desktop', 'out', 'main', nativeRollbackWorkerChunkDirectory)
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  const chunks: Record<string, Buffer> = {}
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(entry.name)) {
      throw new Error(`desktop artifact: emitted native rollback chunk has unsafe name ${JSON.stringify(entry.name)}`)
    }
    chunks[entry.name] = await readRequiredRegularBytes(join(directory, entry.name))
  }
  return chunks
}

/**
 * Read an original artifact once and expose only its exclusive private snapshot to an inspector.
 * @param path - original release artifact path.
 * @param filename - private snapshot basename preserving the native format suffix.
 * @param inspect - operation that receives the private path and exact original bytes.
 * @param operations - filesystem seam for focused snapshot tests.
 * @returns inspector result from the immutable copied bytes.
 */
export async function inspectPrivateArtifactSnapshot<T>(
  path: string,
  filename: string,
  inspect: (snapshotPath: string, snapshot: Buffer) => Promise<T>,
  operations: ArtifactSnapshotOperations = nativeArtifactSnapshotOperations,
  maxBytes?: number,
): Promise<T> {
  const snapshot = await operations.readFile(path, maxBytes)
  if (maxBytes !== undefined && snapshot.length > maxBytes) {
    throw new Error('desktop artifact: source artifact exceeds private snapshot size limit')
  }
  const directory = await operations.mkdtemp(join(tmpdir(), 'harness-desktop-artifact-'))
  const snapshotPath = join(directory, filename)
  try {
    await operations.writeFile(snapshotPath, snapshot, { flag: 'wx', mode: 0o600 })
    return await inspect(snapshotPath, snapshot)
  } finally {
    await operations.removeDirectory(directory)
  }
}

const nativeArtifactSnapshotOperations: ArtifactSnapshotOperations = {
  readFile: (path, maxBytes) => maxBytes === undefined ? readFile(path) : readBoundedArtifact(path, maxBytes),
  mkdtemp: prefix => mkdtemp(prefix),
  writeFile: (path, bytes, options) => writeFile(path, bytes, options),
  removeDirectory: path => rm(path, { recursive: true, force: true }),
}

interface ZipCentralDirectoryEntry {
  readonly path: string
  readonly symbolicLink: boolean
  readonly flags: number
  readonly compressionMethod: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
  readonly centralDirectoryOffset: number
}

interface ZipLocalEntry {
  readonly start: number
  readonly dataStart: number
  readonly dataEnd: number
}

const macRequiredZipSuffixes = [
  'Contents/MacOS/harness-desktop',
  'Contents/Resources/update-policy.json',
  'Contents/Resources/windows-native-rollback-worker.ps1',
  'Contents/Resources/native-rollback-worker.js',
] as const
const macNativeRollbackWorkerChunkSuffix = 'Contents/Resources/chunks'

/**
 * Reject a macOS Desktop ZIP whose member names or symbolic links can redirect installation resources.
 * @param snapshot - immutable ZIP bytes before any platform extractor receives them.
 */
export function assertSafeMacZipSnapshot(snapshot: Buffer): void {
  if (snapshot.length > maxZipArchiveBytes) {
    throw new Error('desktop artifact: macOS ZIP compressed artifact is too large')
  }
  const entries = parseZipCentralDirectory(snapshot)
  assertZipResourceBudgets(entries)
  const localEntries: ZipLocalEntry[] = []
  for (const entry of entries) {
    assertSafeZipPath(entry.path)
    const localEntry = validateZipLocalEntry(snapshot, entry)
    localEntries.push(localEntry)
    if (!entry.symbolicLink) continue
    if (isRequiredMacZipPath(entry.path)) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link redirects required path ${JSON.stringify(entry.path)}`)
    }
    const framework = frameworkRoot(entry.path)
    if (framework === undefined) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link is outside a framework ${JSON.stringify(entry.path)}`)
    }
    const targetBytes = readZipSymbolicLinkTarget(snapshot, entry, localEntry)
    let target: string
    try {
      target = new TextDecoder('utf-8', { fatal: true }).decode(targetBytes)
    } catch {
      throw new Error(`desktop artifact: macOS ZIP symbolic link target is not UTF-8 ${JSON.stringify(entry.path)}`)
    }
    if (target === '' || target.includes('\\') || target.includes('\0') || posix.isAbsolute(target)) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link target is unsafe ${JSON.stringify(entry.path)}`)
    }
    const resolvedTarget = posix.normalize(posix.join(posix.dirname(entry.path), target))
    if (resolvedTarget !== framework && !resolvedTarget.startsWith(`${framework}/`)) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link escapes its framework ${JSON.stringify(entry.path)}`)
    }
  }
  assertNonOverlappingZipLocalEntries(localEntries)
}

/** @returns whether one ZIP symbolic link can redirect a rollback resource needed before Dashboard health. */
function isRequiredMacZipPath(path: string): boolean {
  const appSeparator = path.indexOf('.app/')
  if (appSeparator === -1) return false
  const suffix = path.slice(appSeparator + '.app/'.length)
  return suffix === macNativeRollbackWorkerChunkSuffix
    || suffix.startsWith(`${macNativeRollbackWorkerChunkSuffix}/`)
    || macRequiredZipSuffixes.some(required => required === suffix || required.startsWith(`${suffix}/`))
}

/** Read a bounded symbolic-link target without inflating unrelated ZIP members. */
function readZipSymbolicLinkTarget(
  snapshot: Buffer,
  entry: ZipCentralDirectoryEntry,
  localEntry: ZipLocalEntry,
): Buffer {
  const compressed = snapshot.subarray(localEntry.dataStart, localEntry.dataEnd)
  let target: Buffer
  try {
    if (entry.compressionMethod === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw new Error('stored size mismatch')
      target = Buffer.from(compressed)
    } else if (entry.compressionMethod === 8) {
      target = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize })
    } else {
      throw new Error('unsupported compression')
    }
  } catch {
    throw new Error(`desktop artifact: macOS ZIP symbolic link cannot be read ${JSON.stringify(entry.path)}`)
  }
  if (target.length !== entry.uncompressedSize) {
    throw new Error(`desktop artifact: macOS ZIP symbolic link size is invalid ${JSON.stringify(entry.path)}`)
  }
  return target
}

function assertZipResourceBudgets(entries: readonly ZipCentralDirectoryEntry[]): void {
  let compressedTotal = 0
  let uncompressedTotal = 0
  for (const entry of entries) {
    if (entry.compressedSize > maxZipMemberCompressedBytes) {
      throw new Error(`desktop artifact: macOS ZIP compressed member is too large ${JSON.stringify(entry.path)}`)
    }
    compressedTotal += entry.compressedSize
    if (compressedTotal > maxZipTotalCompressedBytes) {
      throw new Error('desktop artifact: macOS ZIP total compressed size is too large')
    }
    if (entry.uncompressedSize > maxZipMemberUncompressedBytes) {
      throw new Error(`desktop artifact: macOS ZIP member is too large ${JSON.stringify(entry.path)}`)
    }
    uncompressedTotal += entry.uncompressedSize
    if (uncompressedTotal > maxZipTotalUncompressedBytes) {
      throw new Error('desktop artifact: macOS ZIP total uncompressed size is too large')
    }
    if (!entry.symbolicLink) continue
    if (entry.uncompressedSize > maxZipSymbolicLinkTargetBytes) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link target is too large ${JSON.stringify(entry.path)}`)
    }
    if (entry.compressedSize > maxZipSymbolicLinkCompressedBytes) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link compressed target is too large ${JSON.stringify(entry.path)}`)
    }
    if ((entry.flags & 0x0001) !== 0) {
      throw new Error(`desktop artifact: macOS ZIP symbolic link is encrypted ${JSON.stringify(entry.path)}`)
    }
  }
}

function validateZipLocalEntry(snapshot: Buffer, entry: ZipCentralDirectoryEntry): ZipLocalEntry {
  const offset = entry.localHeaderOffset
  if (offset + 30 > snapshot.length || snapshot.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`desktop artifact: macOS ZIP member has invalid local metadata ${JSON.stringify(entry.path)}`)
  }
  const flags = snapshot.readUInt16LE(offset + 6)
  const compressionMethod = snapshot.readUInt16LE(offset + 8)
  const crc32 = snapshot.readUInt32LE(offset + 14)
  const compressedSize = snapshot.readUInt32LE(offset + 18)
  const uncompressedSize = snapshot.readUInt32LE(offset + 22)
  const filenameLength = snapshot.readUInt16LE(offset + 26)
  const extraLength = snapshot.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + filenameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (flags !== entry.flags || compressionMethod !== entry.compressionMethod
    || !Number.isSafeInteger(dataEnd) || dataStart > entry.centralDirectoryOffset || dataEnd > entry.centralDirectoryOffset) {
    throw new Error(`desktop artifact: macOS ZIP member has invalid local metadata ${JSON.stringify(entry.path)}`)
  }
  const usesDataDescriptor = (flags & 0x0008) !== 0
  if ((!usesDataDescriptor && (crc32 !== entry.crc32 || compressedSize !== entry.compressedSize
    || uncompressedSize !== entry.uncompressedSize))
    || (usesDataDescriptor && ((crc32 !== 0 && crc32 !== entry.crc32)
      || (compressedSize !== 0 && compressedSize !== entry.compressedSize)
      || (uncompressedSize !== 0 && uncompressedSize !== entry.uncompressedSize)))) {
    throw new Error(`desktop artifact: macOS ZIP member local sizes differ ${JSON.stringify(entry.path)}`)
  }
  let localPath: string
  try {
    localPath = new TextDecoder('utf-8', { fatal: true }).decode(
      snapshot.subarray(offset + 30, offset + 30 + filenameLength),
    )
  } catch {
    throw new Error(`desktop artifact: macOS ZIP member has invalid local metadata ${JSON.stringify(entry.path)}`)
  }
  if (localPath.endsWith('/')) localPath = localPath.slice(0, -1)
  if (localPath !== entry.path) {
    throw new Error(`desktop artifact: macOS ZIP member local path differs ${JSON.stringify(entry.path)}`)
  }
  return { start: offset, dataStart, dataEnd }
}

function assertNonOverlappingZipLocalEntries(entries: readonly ZipLocalEntry[]): void {
  const ordered = [...entries].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous !== undefined && current !== undefined && current.start < previous.dataEnd) {
      throw new Error('desktop artifact: macOS ZIP local members overlap')
    }
  }
}

function parseZipCentralDirectory(snapshot: Buffer): readonly ZipCentralDirectoryEntry[] {
  const eocd = findZipEndOfCentralDirectory(snapshot)
  const disk = snapshot.readUInt16LE(eocd + 4)
  const centralDirectoryDisk = snapshot.readUInt16LE(eocd + 6)
  const entriesOnDisk = snapshot.readUInt16LE(eocd + 8)
  const entriesTotal = snapshot.readUInt16LE(eocd + 10)
  const centralDirectorySize = snapshot.readUInt32LE(eocd + 12)
  const centralDirectoryOffset = snapshot.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entriesTotal
    || entriesTotal === 0xffff || centralDirectorySize === 0xffff_ffff || centralDirectoryOffset === 0xffff_ffff) {
    throw new Error('desktop artifact: macOS ZIP requires unsupported multi-disk or ZIP64 metadata')
  }
  const end = centralDirectoryOffset + centralDirectorySize
  if (!Number.isSafeInteger(end) || centralDirectoryOffset > snapshot.length || end > eocd) {
    throw new Error('desktop artifact: macOS ZIP central directory is out of bounds')
  }
  const entries: ZipCentralDirectoryEntry[] = []
  const paths = new Set<string>()
  let offset = centralDirectoryOffset
  for (let index = 0; index < entriesTotal; index += 1) {
    if (offset + 46 > end || snapshot.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('desktop artifact: macOS ZIP has malformed central directory metadata')
    }
    const versionMadeBy = snapshot.readUInt16LE(offset + 4)
    const flags = snapshot.readUInt16LE(offset + 8)
    const compressionMethod = snapshot.readUInt16LE(offset + 10)
    const crc32 = snapshot.readUInt32LE(offset + 16)
    const compressedSize = snapshot.readUInt32LE(offset + 20)
    const uncompressedSize = snapshot.readUInt32LE(offset + 24)
    const filenameLength = snapshot.readUInt16LE(offset + 28)
    const extraLength = snapshot.readUInt16LE(offset + 30)
    const commentLength = snapshot.readUInt16LE(offset + 32)
    const recordEnd = offset + 46 + filenameLength + extraLength + commentLength
    if (recordEnd > end) throw new Error('desktop artifact: macOS ZIP member metadata is out of bounds')
    let path: string
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.subarray(offset + 46, offset + 46 + filenameLength))
    } catch {
      throw new Error('desktop artifact: macOS ZIP member name is not UTF-8')
    }
    if (path.endsWith('/')) path = path.slice(0, -1)
    if (paths.has(path)) throw new Error(`desktop artifact: macOS ZIP has duplicate member ${JSON.stringify(path)}`)
    paths.add(path)
    const host = versionMadeBy >>> 8
    const mode = snapshot.readUInt32LE(offset + 38) >>> 16
    const localHeaderOffset = snapshot.readUInt32LE(offset + 42)
    if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff || localHeaderOffset === 0xffff_ffff) {
      throw new Error('desktop artifact: macOS ZIP requires unsupported ZIP64 member metadata')
    }
    entries.push({
      path,
      symbolicLink: (host === 3 || host === 19) && (mode & 0o170000) === 0o120000,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      centralDirectoryOffset,
    })
    offset = recordEnd
  }
  if (offset !== end) throw new Error('desktop artifact: macOS ZIP central directory has trailing records')
  return entries
}

function findZipEndOfCentralDirectory(snapshot: Buffer): number {
  const first = Math.max(0, snapshot.length - 65_557)
  for (let offset = snapshot.length - 22; offset >= first; offset -= 1) {
    if (snapshot.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = snapshot.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === snapshot.length) return offset
  }
  throw new Error('desktop artifact: macOS ZIP has no end-of-central-directory record')
}

function assertSafeZipPath(path: string): void {
  if (path === '' || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) {
    throw new Error(`desktop artifact: macOS ZIP has unsafe member path ${JSON.stringify(path)}`)
  }
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`desktop artifact: macOS ZIP has unsafe member path ${JSON.stringify(path)}`)
  }
}

function frameworkRoot(path: string): string | undefined {
  const segments = path.split('/')
  const index = segments.findIndex(segment => segment.endsWith('.framework'))
  return index === -1 ? undefined : segments.slice(0, index + 1).join('/')
}

async function inspectMacApplication(
  app: string,
  nativeRollbackWorkerChunks: readonly string[],
): Promise<MacDmgInspection> {
  const binary = join(app, 'Contents', 'MacOS', 'harness-desktop')
  const entries = await recursiveEntries(app)
  const asar = join(app, 'Contents', 'Resources', 'app.asar')
  if (await exists(asar)) entries.push(...await lines('pnpm', ['exec', 'asar', 'list', asar], root))
  const lipoInfo = (await execa('lipo', ['-info', binary], { reject: true })).stdout
  return {
    entries,
    lipoInfo,
    ...await readExtractedResources(app, 'Contents/Resources', nativeRollbackWorkerChunks),
  }
}

async function findMacApplication(directory: string): Promise<string> {
  const found: string[] = []
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 3) return
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const candidate = join(current, entry.name)
      if (entry.name.endsWith('.app')) {
        found.push(candidate)
        continue
      }
      await visit(candidate, depth + 1)
    }
  }
  await visit(directory, 0)
  if (found.length !== 1) {
    throw new Error(`desktop artifact: macOS image must contain exactly one app bundle, found ${String(found.length)}`)
  }
  const application = found[0]
  if (application === undefined) throw new Error('desktop artifact: macOS app bundle disappeared during inspection')
  return application
}

async function recursiveEntries(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    found.push(relative)
    if (entry.isDirectory()) found.push(...await recursiveEntries(join(directory, entry.name), relative))
  }
  return found
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDirectory = resolve(root, process.env.DSH_DESKTOP_RELEASE_DIRECTORY ?? 'apps/desktop/release')
  const violations = await verifyDesktopArtifacts({ platform: process.platform, releaseDirectory })
  if (violations.length === 0) {
    process.stdout.write(`release:verify-desktop-artifacts: ${process.platform} artifacts verified.\n`)
  } else {
    for (const violation of violations) process.stderr.write(`${violation}\n`)
    process.exitCode = 1
  }
}
