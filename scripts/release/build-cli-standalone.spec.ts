import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCliStandaloneWithDependencies,
  type CliStandaloneBuildDependencies,
} from './build-cli-standalone.ts'
import { digestStandaloneTree } from './verify-cli-standalone.ts'

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
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ name: '@harness-desktop/cli', version: '9.8.7' }))
  await writeFile(join(cliRoot, 'lib', 'bin.js'), "console.log('Usage: harness')\n")
  await writeFile(join(cliRoot, 'lib', 'dsh-bin.js'), "console.log('Usage: dsh')\n")
  await writeFile(join(cliRoot, 'lib', 'main.js'), 'export {}\n')
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
    expect(Object.keys(digests)).toHaveLength(8_304)
    expect(Object.keys(digests)).toEqual(Object.keys(digests).toSorted((left, right) => left.localeCompare(right, 'en')))
  }, 120_000)
})
