import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'
import {
  buildCliStandaloneWithDependencies,
  repairMissingDeclaredBins,
  type CliStandaloneBuildDependencies,
} from './build-cli-standalone.ts'
import { applyStandaloneExecutablePaths, digestStandaloneTree } from './verify-cli-standalone.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
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
  await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ name: '@harness-desktop/cli', version: '9.8.7' }))
  await writeFile(join(cliRoot, 'lib', 'bin.js'), "console.log('Usage: harness')\n")
  await writeFile(join(cliRoot, 'lib', 'dsh-bin.js'), "console.log('Usage: dsh')\n")
  await writeFile(join(cliRoot, 'lib', 'main.js'), 'export {}\n')
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
    extractNodeDistribution: async (_archive, destination) => {
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'node.exe'), 'fixture node')
    },
    validateCliClosure: async () => {},
    ...overrides,
  }
}

function zipModes(bytes: Uint8Array): ReadonlyMap<string, number> {
  const view = Buffer.from(bytes)
  let end = view.length - 22
  while (end >= 0 && view.readUInt32LE(end) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('fixture ZIP has no end-of-central-directory record')
  const count = view.readUInt16LE(end + 10)
  let offset = view.readUInt32LE(end + 16)
  const modes = new Map<string, number>()
  for (let index = 0; index < count; index += 1) {
    if (view.readUInt32LE(offset) !== 0x02014b50) throw new Error('fixture ZIP central directory is malformed')
    const nameLength = view.readUInt16LE(offset + 28)
    const extraLength = view.readUInt16LE(offset + 30)
    const commentLength = view.readUInt16LE(offset + 32)
    const name = view.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    modes.set(name, (view.readUInt32LE(offset + 38) >>> 16) & 0o777)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return modes
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
      version: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
    }

    const firstNames = await buildCliStandaloneWithDependencies({ ...input, outputDirectory: first }, dependencies(subject))
    const secondNames = await buildCliStandaloneWithDependencies({ ...input, outputDirectory: second }, dependencies(subject))

    expect(firstNames).toEqual([
      'harness-cli-0.0.0-test-win32-x64.zip',
      'harness-cli-0.0.0-test-win32-x64.tar.gz',
      'harness-cli-0.0.0-test-win32-x64.sha256',
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
      'runtime/node.exe',
      'cli/package/lib/bin.js',
      'cli/package/lib/dsh-bin.js',
    ]))
    const manifest = JSON.parse(Buffer.from(zipped['manifest.json']!).toString('utf8')) as {
      readonly files: Record<string, string>
    }
    expect(Object.keys(manifest.files)).toEqual(Object.keys(manifest.files).toSorted())
    expect(Object.keys(manifest.files)).not.toContain('manifest.json')
    expect(gunzipSync(await readFile(join(first, firstNames[1]!))).byteLength).toBeGreaterThan(0)
    expect(await readFile(join(first, firstNames[2]!), 'utf8')).toMatch(
      /^[0-9a-f]{64}  harness-cli-0\.0\.0-test-win32-x64\.zip\n[0-9a-f]{64}  harness-cli-0\.0\.0-test-win32-x64\.tar\.gz\n$/u,
    )
  })

  it('rejects absent and mismatched local Node distributions without downloading', async () => {
    const subject = await fixture()
    const output = await tempRoot('harness-cli-standalone-invalid-runtime-')
    const input = {
      platform: 'win32' as const,
      arch: 'x64',
      version: '0.0.0-test',
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
      version: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).rejects.toThrow(
      'standalone CLI: native module cli/package/node_modules/foreign/foreign.node targets linux-x64, expected win32-x64',
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
      version: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).rejects.toThrow(
      'standalone CLI: package missing-bin@1.2.3 declares missing bin cli/package/node_modules/missing-bin/bin.mjs',
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
      version: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, dependencies(subject))).resolves.toEqual([
      'harness-cli-0.0.0-test-win32-x64.zip',
      'harness-cli-0.0.0-test-win32-x64.tar.gz',
      'harness-cli-0.0.0-test-win32-x64.sha256',
    ])
    const digests = await digestStandaloneTree(subject.cliRoot, new Set())
    expect(Object.keys(digests)).toHaveLength(8_305)
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
      version: '0.0.0-test',
      nodeRuntimeRoot: subject.runtimeRoot,
      outputDirectory: output,
    }, buildDependencies)
    const zipPath = join(output, names[0]!)
    const zipped = unzipSync(await readFile(zipPath))
    const manifest = JSON.parse(Buffer.from(zipped['manifest.json']!).toString('utf8')) as {
      readonly executablePaths?: readonly string[]
    }
    const requiredPaths = [...new Set([
      `cli/package/${packageExecutable}`,
      `cli/package/${rgExecutable}`,
      'cli/package/node_modules/fixture-bin/bin/fixture-tool',
      'runtime/bin/node',
      'harness',
      'dsh',
    ])]
    expect(manifest.executablePaths).toEqual(expect.arrayContaining(requiredPaths))
    const zipModeMap = zipModes(await readFile(zipPath))
    const tarModeMap = await tarModes(join(output, names[1]!))
    for (const path of requiredPaths) {
      expect(zipModeMap.get(path), `ZIP mode for ${path}`).toBe(0o755)
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
