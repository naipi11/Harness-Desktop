import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'
import {
  buildCliStandaloneWithDependencies,
  relocateNodePtyPatchPath,
  repairMissingDeclaredBins,
  retainLinuxNodePtyBinding,
  type CliStandaloneBuildDependencies,
} from './build-cli-standalone.ts'
import { applyStandaloneExecutablePaths, digestStandaloneTree } from './verify-cli-standalone.ts'
import { inventoryUpdateArtifacts } from './build-update-manifest.ts'
import type { ReleaseUpdateConfiguration } from '@harness-desktop/dsh-update-policy'

const roots: string[] = []
const updateKeyPair = generateKeyPairSync('ed25519')
const updatePolicy: ReleaseUpdateConfiguration = {
  schemaVersion: 3,
  applicationId: 'io.github.naipi11.harness-desktop',
  trust: {
    allowedOrigins: ['https://updates.example.invalid'],
    publicKeys: { 'release-test': updateKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  },
  healthCheckTimeoutMs: 120_000,
  nativeWorkerReadyTimeoutMs: 300_000,
  manifestEndpoints: {
    'stable/cli/win32/x64/zip': 'https://updates.example.invalid/stable/cli/win32-x64.json',
    'stable/cli/linux/x64/tar.gz': 'https://updates.example.invalid/stable/cli/linux-x64.json',
    'stable/cli/darwin/arm64/tar.gz': 'https://updates.example.invalid/stable/cli/darwin-arm64.json',
  },
  rollbackManifestEndpoints: {
    'stable/cli/win32/x64/zip/1.0.0': 'https://updates.example.invalid/stable/cli/win32-x64-rollback.json',
    'stable/cli/linux/x64/tar.gz/1.0.0': 'https://updates.example.invalid/stable/cli/linux-x64-rollback.json',
    'stable/cli/darwin/arm64/tar.gz/1.0.0': 'https://updates.example.invalid/stable/cli/darwin-arm64-rollback.json',
  },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('relocateNodePtyPatchPath', () => {
  it.each([
    ['folded', 'patchedDependencies:\n  node-pty@1.1.0: >-\n    ../outside/patches/node-pty@1.1.0.patch\nallowBuilds:\n'],
    ['inline', 'patchedDependencies:\n  node-pty@1.1.0: ../outside/patches/node-pty@1.1.1.patch\nallowBuilds:\n'],
  ])('relocates the %s deploy path without duplicating the declaration', (_label, workspace) => {
    const relocated = relocateNodePtyPatchPath(workspace)
    expect(relocated).toContain('  node-pty@1.1.0: patches/node-pty@1.1.0.patch')
    expect(relocated.match(/node-pty@1\.1\.0:/gu)).toHaveLength(1)
  })

  it('rejects a deploy workspace without the tracked patch declaration', () => {
    expect(() => relocateNodePtyPatchPath('allowBuilds:\n  node-pty: true\n')).toThrow(
      'packed CLI: deployed workspace does not declare the node-pty patch path',
    )
  })
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label))
  roots.push(root)
  return root
}

async function fixture(): Promise<{
  readonly cliRoot: string
  readonly runtimeRoot: string
  readonly runtimeFilename: string
  readonly runtimeSha256: string
}> {
  const root = await tempRoot('harness-cli-standalone-fixture-')
  const cliRoot = join(root, 'cli')
  const runtimeRoot = join(root, 'runtimes')
  const runtimeFilename = 'node-v0.0.0-test-win-x64.zip'
  await mkdir(join(cliRoot, 'lib'), { recursive: true })
  await mkdir(join(cliRoot, 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin'), { recursive: true })
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ name: '@harness-desktop/cli', version: '1.0.0' }))
  await writeFile(join(cliRoot, 'lib', 'bin.js'), "console.log('Usage: harness')\n")
  await writeFile(join(cliRoot, 'lib', 'dsh-bin.js'), "console.log('Usage: dsh')\n")
  await writeFile(join(cliRoot, 'lib', 'main.js'), 'export {}\n')
  await writeFile(join(cliRoot, 'lib', 'standalone-launcher.js'), 'export {}\n')
  await writeFile(join(cliRoot, 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe'), 'fixture rg')
  const runtimeBytes = Buffer.from('fixture runtime distribution')
  await writeFile(join(runtimeRoot, runtimeFilename), runtimeBytes)
  return {
    cliRoot,
    runtimeRoot,
    runtimeFilename,
    runtimeSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
  }
}

function dependencies(
  subject: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<CliStandaloneBuildDependencies> = {},
): CliStandaloneBuildDependencies {
  return {
    cliPackageRoot: subject.cliRoot,
    checksumAllowlist: {
      '0.0.0-test': {
        win32: {
          x64: {
            filename: subject.runtimeFilename,
            sha256: subject.runtimeSha256,
          },
        },
      },
    },
    updatePolicy,
    extractNodeDistribution: async (_archive, destination) => {
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'node.exe'), 'fixture node')
    },
    validateCliClosure: async () => {},
    ...overrides,
  }
}

function linuxX64NativeModule(machine = 62): Buffer {
  const native = Buffer.alloc(64)
  native.set([0x7f, 0x45, 0x4c, 0x46])
  native[4] = 2
  native[5] = 1
  native.writeUInt16LE(machine, 18)
  return native
}

async function prepareLinuxCli(
  subject: Awaited<ReturnType<typeof fixture>>,
  nodePtyBinding: readonly string[] | false = ['prebuilds', 'linux-x64', 'pty.node'],
): Promise<void> {
  await mkdir(join(subject.cliRoot, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin'), { recursive: true })
  await writeFile(join(subject.cliRoot, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg'), 'fixture rg')
  if (nodePtyBinding !== false) {
    const destination = join(subject.cliRoot, 'node_modules', 'node-pty', ...nodePtyBinding)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, linuxX64NativeModule())
  }
}

function linuxDependencies(subject: Awaited<ReturnType<typeof fixture>>): CliStandaloneBuildDependencies {
  return dependencies(subject, {
    checksumAllowlist: { '0.0.0-test': { linux: { x64: { filename: subject.runtimeFilename, sha256: subject.runtimeSha256 } } } },
    extractNodeDistribution: async (_archive, destination) => {
      await mkdir(join(destination, 'bin'), { recursive: true })
      await writeFile(join(destination, 'bin', 'node'), 'fixture node')
    },
  })
}

async function tarModes(path: string): Promise<ReadonlyMap<string, number>> {
  const modes = new Map<string, number>()
  await tar.t({
    file: path,
    onReadEntry(entry) {
      modes.set(entry.path, entry.mode ?? 0)
    },
  })
  return modes
}

describe('buildCliStandaloneWithDependencies', () => {
  it('writes byte-identical named archives, checksum sidecar, launchers, and sorted digest manifest', async () => {
    const subject = await fixture()
    const first = await tempRoot('harness-cli-standalone-first-')
    const second = await tempRoot('harness-cli-standalone-second-')
    const input = {
      platform: 'win32' as const,
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
    }

    const firstNames = await buildCliStandaloneWithDependencies({ ...input, outputDirectory: first }, dependencies(subject))
    const secondNames = await buildCliStandaloneWithDependencies({ ...input, outputDirectory: second }, dependencies(subject))

    expect(firstNames).toEqual([
      'harness-cli-1.0.0-win32-x64.zip',
      'harness-cli-1.0.0-win32-x64.sha256',
    ])
    expect(secondNames).toEqual(firstNames)
    for (const name of firstNames) {
      expect(await readFile(join(first, name))).toEqual(await readFile(join(second, name)))
    }

    const zipped = unzipSync(await readFile(join(first, firstNames[0]!)))
    expect(Object.keys(zipped)).toEqual(expect.arrayContaining([
      'manifest.json',
      'harness',
      'dsh',
      'harness.cmd',
      'dsh.cmd',
      'payload/current/runtime/node.exe',
      'launcher-runtime/node.exe',
      'update-policy.json',
      'payload/current/cli/package/lib/bin.js',
      'payload/current/cli/package/lib/dsh-bin.js',
    ]))
    const manifest = JSON.parse(Buffer.from(zipped['manifest.json']!).toString('utf8')) as {
      readonly files: Record<string, string>
    }
    expect(Object.keys(manifest.files)).toEqual(Object.keys(manifest.files).toSorted())
    expect(Object.keys(manifest.files)).not.toContain('manifest.json')
    expect(JSON.parse(Buffer.from(zipped['update-policy.json']!).toString('utf8'))).toEqual(updatePolicy)
    expect(await readFile(join(first, firstNames[1]!), 'utf8')).toMatch(
      /^[0-9a-f]{64}  harness-cli-1\.0\.0-win32-x64\.zip\n$/u,
    )
  })

  it('rejects absent and mismatched local Node distributions without downloading', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-invalid-runtime-')
    const input = {
      platform: 'win32' as const,
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }

    await expect(buildCliStandaloneWithDependencies(input, dependencies(subject, {
      checksumAllowlist: {},
    }))).rejects.toThrow('standalone CLI: no allowlisted Node runtime')
    await expect(buildCliStandaloneWithDependencies(input, dependencies(subject, {
      checksumAllowlist: {
        '0.0.0-test': { win32: { x64: { filename: subject.runtimeFilename, sha256: '0'.repeat(64) } } },
      },
    }))).rejects.toThrow('standalone CLI: Node runtime checksum mismatch')
  })

  it('uses CLI versioned filenames while retaining the independently pinned Node version', async () => {
    const subject = await fixture()
    const first = await tempRoot('harness-cli-version-one-')
    const second = await tempRoot('harness-cli-version-two-')
    const common = {
      platform: 'win32' as const,
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
    }

    const firstNames = await buildCliStandaloneWithDependencies({
      ...common, cliVersion: '1.0.0', outputDirectory: first,
    }, dependencies(subject))
    await writeFile(join(subject.cliRoot, 'package.json'), JSON.stringify({ name: '@harness-desktop/cli', version: '1.0.1' }))
    const secondNames = await buildCliStandaloneWithDependencies({
      ...common, cliVersion: '1.0.1', outputDirectory: second,
    }, dependencies(subject, {
      updatePolicy: {
        ...updatePolicy,
        rollbackManifestEndpoints: {
          ...updatePolicy.rollbackManifestEndpoints,
          'stable/cli/win32/x64/zip/1.0.1': 'https://updates.example.invalid/stable/cli/win32-x64-rollback-1.0.1.json',
        },
      },
    }))

    expect(firstNames[0]).toBe('harness-cli-1.0.0-win32-x64.zip')
    expect(secondNames[0]).toBe('harness-cli-1.0.1-win32-x64.zip')
    const firstManifest = JSON.parse(Buffer.from(unzipSync(await readFile(join(first, firstNames[0]!)))['manifest.json']!).toString()) as unknown
    const secondManifest = JSON.parse(Buffer.from(unzipSync(await readFile(join(second, secondNames[0]!)))['manifest.json']!).toString()) as unknown
    expect(firstManifest).toMatchObject({ node: { version: '0.0.0-test' }, cli: { version: '1.0.0' } })
    expect(secondManifest).toMatchObject({ node: { version: '0.0.0-test' }, cli: { version: '1.0.1' } })
    const inventory = await inventoryUpdateArtifacts({
      currentVersion: '1.0.0',
      version: '1.0.1',
      keyId: 'fixture-key',
      artifacts: [{
        channel: 'stable',
        consumer: 'cli',
        platform: 'win32',
        arch: 'x64',
        format: 'zip',
        artifactPath: join(second, secondNames[0]!),
        url: 'https://updates.example.invalid/harness-cli-1.0.1-win32-x64.zip',
      }],
    })
    expect(inventory.artifacts[0]?.members).toEqual(['manifest.json'])
  })

  it('rejects a policy without the exact candidate or rollback endpoint before staging an archive', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-policy-')
    const input = {
      platform: 'win32' as const,
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }
    let extracted = false
    const extractNodeDistribution = async (): Promise<void> => { extracted = true }

    await expect(buildCliStandaloneWithDependencies(input, dependencies(subject, {
      updatePolicy: { ...updatePolicy, manifestEndpoints: {} },
      extractNodeDistribution,
    }))).rejects.toThrow('standalone CLI: update policy omits the configured candidate endpoint')
    expect(extracted).toBe(false)

    await expect(buildCliStandaloneWithDependencies(input, dependencies(subject, {
      updatePolicy: { ...updatePolicy, rollbackManifestEndpoints: {} },
      extractNodeDistribution,
    }))).rejects.toThrow('standalone CLI: update policy omits the configured rollback endpoint')
    expect(extracted).toBe(false)
  })

  it('rejects a foreign-platform native module before writing an archive', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-native-')
    const native = Buffer.alloc(64)
    native.set([0x7f, 0x45, 0x4c, 0x46])
    native[4] = 2
    native[5] = 1
    native.writeUInt16LE(62, 18)
    await mkdir(join(subject.cliRoot, 'node_modules', 'foreign'), { recursive: true })
    await writeFile(join(subject.cliRoot, 'node_modules', 'foreign', 'foreign.node'), native)

    await expect(buildCliStandaloneWithDependencies({
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).rejects.toThrow(
      'standalone CLI: native module payload/current/cli/package/node_modules/foreign/foreign.node targets linux-x64, expected win32-x64',
    )
  })

  it('rejects a Linux standalone payload without a node-pty target binding', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-node-pty-absent-')
    await prepareLinuxCli(subject, false)
    await mkdir(join(subject.cliRoot, 'node_modules', 'node-pty'), { recursive: true })

    await expect(buildCliStandaloneWithDependencies({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, linuxDependencies(subject))).rejects.toThrow(
      'standalone CLI: Linux node-pty closure omits a linux-x64 pty.node binding',
    )
  })

  it('rejects a Linux node-pty prebuild that targets another architecture', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-node-pty-foreign-')
    await prepareLinuxCli(subject, false)
    const pty = join(subject.cliRoot, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64')
    await mkdir(pty, { recursive: true })
    await writeFile(join(pty, 'pty.node'), linuxX64NativeModule(183))

    await expect(buildCliStandaloneWithDependencies({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, linuxDependencies(subject))).rejects.toThrow(
      'standalone CLI: Linux node-pty closure omits a linux-x64 pty.node binding',
    )
  })

  it.each([
    ['prebuild', ['prebuilds', 'linux-x64', 'pty.node']],
    ['build output', ['build', 'Release', 'pty.node']],
  ] as const)('accepts a Linux node-pty $0 binding', async (_label, binding) => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-node-pty-present-')
    await prepareLinuxCli(subject, false)
    const destination = join(subject.cliRoot, 'node_modules', 'node-pty', ...binding)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, linuxX64NativeModule())

    await expect(buildCliStandaloneWithDependencies({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, linuxDependencies(subject))).resolves.toEqual([
      'harness-cli-1.0.0-linux-x64.tar.gz',
      'harness-cli-1.0.0-linux-x64.sha256',
    ])
  })

  it('rejects a Linux Koffi closure without its musl alternative before writing an archive', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-koffi-closure-')
    const native = Buffer.alloc(64)
    native.set([0x7f, 0x45, 0x4c, 0x46])
    native[4] = 2
    native[5] = 1
    native.writeUInt16LE(62, 18)
    await mkdir(join(subject.cliRoot, 'node_modules', '@koromix', 'koffi-linux-x64', 'linux_x64'), { recursive: true })
    await prepareLinuxCli(subject)
    await writeFile(join(subject.cliRoot, 'node_modules', '@koromix', 'koffi-linux-x64', 'linux_x64', 'koffi.node'), native)

    await expect(buildCliStandaloneWithDependencies({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject, {
      checksumAllowlist: { '0.0.0-test': { linux: { x64: { filename: subject.runtimeFilename, sha256: subject.runtimeSha256 } } } },
      extractNodeDistribution: async (_archive, destination) => {
        await mkdir(join(destination, 'bin'), { recursive: true })
        await writeFile(join(destination, 'bin', 'node'), 'fixture node')
      },
    }))).rejects.toThrow(
      'standalone CLI: Linux Koffi native closure omits musl_x64/koffi.node',
    )
  })

  it('rejects a Linux Koffi package without either libc native alternative before writing an archive', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-koffi-absent-')
    await mkdir(join(subject.cliRoot, 'node_modules', 'koffi'), { recursive: true })
    await prepareLinuxCli(subject)
    await writeFile(join(subject.cliRoot, 'node_modules', 'koffi', 'index.js'), 'export {}\n')

    await expect(buildCliStandaloneWithDependencies({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject, {
      checksumAllowlist: { '0.0.0-test': { linux: { x64: { filename: subject.runtimeFilename, sha256: subject.runtimeSha256 } } } },
      extractNodeDistribution: async (_archive, destination) => {
        await mkdir(join(destination, 'bin'), { recursive: true })
        await writeFile(join(destination, 'bin', 'node'), 'fixture node')
      },
    }))).rejects.toThrow(
      'standalone CLI: Linux Koffi native closure omits linux_x64/koffi.node',
    )
  })

  it('rejects an extracted supplied-tarball package whose declared bin target is missing', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-missing-bin-')
    const packageRoot = join(subject.cliRoot, 'node_modules', 'missing-bin')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'missing-bin',
      version: '1.2.3',
      bin: './bin.mjs',
    }))

    await expect(buildCliStandaloneWithDependencies({
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).rejects.toThrow(
      'standalone CLI: package missing-bin@1.2.3 declares missing bin payload/current/cli/package/node_modules/missing-bin/bin.mjs',
    )
  })

  it('repairs a missing declared bin only from an exact name and version source package', async () => {
    const subject = await fixture()
    const stagedPackage = join(subject.cliRoot, 'node_modules', 'fixture-repair')
    const sourcePackage = join(await tempRoot('harness-cli-bin-source-'), 'fixture-repair')
    const manifest = { name: 'fixture-repair', version: '4.5.6', bin: './bin.mjs', files: ['dist/'] }
    await mkdir(stagedPackage, { recursive: true })
    await writeFile(join(stagedPackage, 'package.json'), JSON.stringify(manifest))
    await mkdir(sourcePackage, { recursive: true })
    await writeFile(join(sourcePackage, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(sourcePackage, 'bin.mjs'), '#!/usr/bin/env node\n')
    await expect(repairMissingDeclaredBins(subject.cliRoot, async (name, version) => {
      expect([name, version]).toEqual(['fixture-repair', '4.5.6'])
      return sourcePackage
    })).resolves.toEqual(['node_modules/fixture-repair/bin.mjs'])
    await expect(readFile(join(stagedPackage, 'bin.mjs'), 'utf8')).resolves.toBe('#!/usr/bin/env node\n')
    const repairedManifest = JSON.parse(await readFile(join(stagedPackage, 'package.json'), 'utf8')) as {
      readonly files: readonly string[]
    }
    expect(repairedManifest.files).toEqual(['dist/', 'bin.mjs'])
  })

  it('retains the verified Linux node-pty binding in the deployed package files', async () => {
    const sourceRoot = await tempRoot('harness-cli-node-pty-source-')
    const deployedRoot = await tempRoot('harness-cli-node-pty-deployed-')
    await mkdir(join(sourceRoot, 'build', 'Release'), { recursive: true })
    await mkdir(deployedRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'node-pty', version: '1.1.0', files: ['lib/'],
    }))
    await writeFile(join(deployedRoot, 'package.json'), JSON.stringify({
      name: 'node-pty', version: '1.1.0', files: ['lib/'], custom: 'retained',
    }))
    await writeFile(join(sourceRoot, 'build', 'Release', 'pty.node'), linuxX64NativeModule())

    await retainLinuxNodePtyBinding(sourceRoot, deployedRoot)

    await expect(readFile(join(deployedRoot, 'build', 'Release', 'pty.node'))).resolves.toEqual(linuxX64NativeModule())
    await expect(readFile(join(deployedRoot, 'package.json'), 'utf8')).resolves.toContain('"build/Release/pty.node"')
    const deployedManifest = JSON.parse(await readFile(join(deployedRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(deployedManifest).toMatchObject({
      name: 'node-pty', version: '1.1.0', custom: 'retained',
    })
  })

  it('rejects a missing source Linux node-pty binding before the packed payload can be written', async () => {
    const sourceRoot = await tempRoot('harness-cli-node-pty-source-missing-')
    const deployedRoot = await tempRoot('harness-cli-node-pty-deployed-missing-')
    await mkdir(sourceRoot, { recursive: true })
    await mkdir(deployedRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
    await writeFile(join(deployedRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))

    await expect(retainLinuxNodePtyBinding(sourceRoot, deployedRoot)).rejects.toThrow(
      `packed CLI: Linux source node-pty binding is missing at ${join(sourceRoot, 'build', 'Release', 'pty.node')}`,
    )
  })

  it('hashes a payload larger than the process file-handle limit without unbounded opens', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-many-files-')
    const assets = join(subject.cliRoot, 'assets')
    await mkdir(assets)
    for (let index = 0; index < 8_300; index += 1) {
      await writeFile(join(assets, `${String(index).padStart(5, '0')}.txt`), '')
    }

    await expect(buildCliStandaloneWithDependencies({
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).resolves.toEqual([
      'harness-cli-1.0.0-win32-x64.zip',
      'harness-cli-1.0.0-win32-x64.sha256',
    ])
    const digests = await digestStandaloneTree(subject.cliRoot, new Set())
    expect(Object.keys(digests)).toHaveLength(8_306)
    expect(Object.keys(digests)).toEqual(Object.keys(digests).toSorted((left, right) => left.localeCompare(right, 'en')))
  }, 120_000)

  it.each([
    {
      platform: 'linux' as const,
      arch: 'x64',
      packageExecutable: 'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
    },
    {
      platform: 'darwin' as const,
      arch: 'arm64',
      packageExecutable: 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    },
  ])('records and preserves package executables for $platform', async ({ platform, arch, packageExecutable }) => {
    const subject = await fixture()
    const output = await tempRoot(`harness-cli-standalone-${platform}-executables-`)
    if (platform === 'linux') await prepareLinuxCli(subject)
    const packageExecutablePath = join(subject.cliRoot, ...packageExecutable.split('/'))
    const rgExecutable = `node_modules/@vscode/ripgrep-${platform}-${arch}/bin/rg`
    const rgExecutablePath = join(subject.cliRoot, ...rgExecutable.split('/'))
    const declaredBin = join(subject.cliRoot, 'node_modules', 'fixture-bin', 'bin', 'fixture-tool')
    await mkdir(join(packageExecutablePath, '..'), { recursive: true })
    await writeFile(packageExecutablePath, 'fixture package executable')
    await mkdir(join(rgExecutablePath, '..'), { recursive: true })
    await writeFile(rgExecutablePath, 'fixture rg')
    await mkdir(join(declaredBin, '..'), { recursive: true })
    await writeFile(declaredBin, '#!/bin/sh\n')
    await writeFile(join(subject.cliRoot, 'node_modules', 'fixture-bin', 'package.json'), JSON.stringify({
      name: 'fixture-bin',
      version: '1.0.0',
      bin: { 'fixture-tool': 'bin/fixture-tool' },
    }))
    const buildDependencies = dependencies(subject, {
      checksumAllowlist: {
        '0.0.0-test': { [platform]: { [arch]: { filename: subject.runtimeFilename, sha256: subject.runtimeSha256 } } },
      },
      extractNodeDistribution: async (_archive, destination) => {
        await mkdir(join(destination, 'bin'), { recursive: true })
        await writeFile(join(destination, 'bin', 'node'), 'fixture node')
      },
    })

    const names = await buildCliStandaloneWithDependencies({
      platform,
      arch,
      nodeVersion: '0.0.0-test',
      cliVersion: '1.0.0',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, buildDependencies)
    expect(names).toEqual([
      `harness-cli-1.0.0-${platform}-${arch}.tar.gz`,
      `harness-cli-1.0.0-${platform}-${arch}.sha256`,
    ])
    const extraction = await tempRoot(`harness-cli-standalone-${platform}-extract-`)
    await tar.x({ file: join(output, names[0]!), cwd: extraction, strict: true })
    const manifest = JSON.parse(await readFile(join(extraction, 'manifest.json'), 'utf8')) as {
      readonly executablePaths?: readonly string[]
    }
    const requiredPaths = [...new Set([
      `payload/current/cli/package/${packageExecutable}`,
      `payload/current/cli/package/${rgExecutable}`,
      'payload/current/cli/package/node_modules/fixture-bin/bin/fixture-tool',
      'payload/current/runtime/bin/node',
      'launcher-runtime/bin/node',
      'harness',
      'dsh',
    ])]
    expect(manifest.executablePaths).toEqual(expect.arrayContaining(requiredPaths))
    const tarModeMap = await tarModes(join(output, names[0]!))
    for (const path of requiredPaths) {
      expect(tarModeMap.get(path), `tar mode for ${path}`).toBe(0o755)
    }
  })
})

describe('standalone executable verification', () => {
  it('rejects a tar member whose manifest-recorded executable bit is missing', async () => {
    await expect(applyStandaloneExecutablePaths({
      format: 'tar.gz',
      platform: 'linux',
      extraction: '/fixture',
      executablePaths: ['cli/package/bin/rg'],
    }, {
      chmod: async () => {},
      stat: async () => ({ mode: 0o644 }),
    })).resolves.toEqual([
      'standalone CLI: tar.gz executable cli/package/bin/rg has mode 644, expected 755',
    ])
  })

  it('restores ZIP executable modes from the manifest before validating them', async () => {
    let mode = 0o644

    await expect(applyStandaloneExecutablePaths({
      format: 'zip',
      platform: 'linux',
      extraction: '/fixture',
      executablePaths: ['cli/package/bin/rg'],
    }, {
      async chmod(_path, nextMode) { mode = nextMode },
      stat: async () => ({ mode }),
    })).resolves.toEqual([])
    expect(mode).toBe(0o755)
  })
})
