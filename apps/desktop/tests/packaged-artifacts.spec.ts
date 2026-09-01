import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeDebTarSnapshot,
  assertSafeMacZipSnapshot,
  inspectDebArtifactSnapshot,
  inspectPrivateArtifactSnapshot,
  readBoundedArtifactBytes,
  verifyDesktopArtifactsWithTools,
  verifyWindowsSupervisor,
  type ArtifactSnapshotOperations,
  type DesktopArtifactTools,
} from '../../../scripts/release/verify-desktop-artifacts.ts'

const roots: string[] = []
const releaseKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const updatePolicy = Buffer.from(JSON.stringify({
  schemaVersion: 3,
  applicationId: 'io.github.naipi11.harness-desktop',
  trust: {
    allowedOrigins: ['https://updates.example.invalid'],
    publicKeys: { 'release-test': releaseKey },
  },
  healthCheckTimeoutMs: 120_000,
  nativeWorkerReadyTimeoutMs: 300_000,
  manifestEndpoints: {
    'stable/desktop/win32/x64/nsis': 'https://updates.example.invalid/stable/desktop/win32-x64.json',
    'stable/desktop/darwin/universal/zip': 'https://updates.example.invalid/stable/desktop/macos-zip.json',
    'stable/desktop/linux/x64/appimage': 'https://updates.example.invalid/stable/desktop/linux-appimage.json',
  },
  rollbackManifestEndpoints: {
    'stable/desktop/win32/x64/nsis/1.0.0': 'https://updates.example.invalid/stable/desktop/win32-x64-rollback.json',
    'stable/desktop/win32/x64/nsis/1.0.1': 'https://updates.example.invalid/stable/desktop/win32-x64-rollback-1.0.1.json',
    'stable/desktop/darwin/universal/zip/1.0.0': 'https://updates.example.invalid/stable/desktop/macos-zip-rollback.json',
    'stable/desktop/darwin/universal/zip/1.0.1': 'https://updates.example.invalid/stable/desktop/macos-zip-rollback-1.0.1.json',
    'stable/desktop/linux/x64/appimage/1.0.0': 'https://updates.example.invalid/stable/desktop/linux-appimage-rollback.json',
    'stable/desktop/linux/x64/appimage/1.0.1': 'https://updates.example.invalid/stable/desktop/linux-appimage-rollback-1.0.1.json',
  },
}))
const canonicalWorkers = {
  appAsarSha256: 'fixture-app-asar',
  windowsRollbackWorker: Buffer.from('canonical Windows rollback worker'),
  nativeRollbackWorker: Buffer.from('canonical native rollback worker'),
  nativeRollbackWorkerChunks: {
    'native-rollback-request-fixture.js': Buffer.from('canonical native rollback worker chunk'),
  },
} as const
const runtimeAsarEntries = [
  '\\resources\\icons\\win\\harness-desktop.ico',
  '\\node_modules\\@harness-desktop\\dsh-host-local-runtime\\lib\\bin.js',
  '\\node_modules\\@harness-desktop\\dsh-home-paths\\package.json',
  '\\node_modules\\@harness-desktop\\dsh-home-paths\\lib\\index.js',
]
const canonicalWindowsSupervisor = windowsSupervisorPe()
const macResources = [
  'Contents/Resources/harness-desktop.icns',
  'Contents/Resources/update-policy.json',
  'Contents/Resources/windows-native-rollback-worker.ps1',
  'Contents/Resources/native-rollback-worker.js',
  'Contents/Resources/chunks/native-rollback-request-fixture.js',
]
const appImageResources = [
  'usr/share/icons/hicolor/512x512/apps/harness-desktop.png',
  'resources/update-policy.json',
  'resources/windows-native-rollback-worker.ps1',
  'resources/native-rollback-worker.js',
  'resources/chunks/native-rollback-request-fixture.js',
]
const debResources = [
  'usr/share/icons/hicolor/512x512/apps/harness-desktop.png',
  'opt/Harness Desktop/resources/update-policy.json',
  'opt/Harness Desktop/resources/windows-native-rollback-worker.ps1',
  'opt/Harness Desktop/resources/native-rollback-worker.js',
  'opt/Harness Desktop/resources/chunks/native-rollback-request-fixture.js',
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function releaseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-packaged-artifacts-'))
  roots.push(root)
  return root
}

async function file(path: string, content: string | Uint8Array = 'fixture'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

async function windowsResources(root: string): Promise<void> {
  await file(join(root, 'win-unpacked', 'resources', 'app.asar'))
  await file(join(root, 'win-unpacked', 'resources', 'update-policy.json'), updatePolicy)
  await file(join(root, 'win-unpacked', 'resources', 'windows-native-rollback-worker.ps1'))
  await file(join(root, 'win-unpacked', 'resources', 'native-rollback-worker.js'))
  await file(
    join(root, 'win-unpacked', 'resources', 'windows-native-update-supervisor.exe'),
    canonicalWindowsSupervisor,
  )
}

function windowsSupervisorPe(machine = 0x8664, subsystem = 2): Buffer {
  const bytes = Buffer.alloc(0x200)
  const peOffset = 0x80
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(peOffset, 0x3c)
  bytes.writeUInt32LE(0x00004550, peOffset)
  bytes.writeUInt16LE(machine, peOffset + 4)
  bytes.writeUInt16LE(0xf0, peOffset + 20)
  const optionalHeader = peOffset + 24
  bytes.writeUInt16LE(0x20b, optionalHeader)
  bytes.writeUInt16LE(subsystem, optionalHeader + 68)
  return bytes
}

function mutatedWindowsSupervisorPe(mutate: (bytes: Buffer, peOffset: number, optionalHeader: number) => void): Buffer {
  const bytes = windowsSupervisorPe()
  const peOffset = bytes.readUInt32LE(0x3c)
  mutate(bytes, peOffset, peOffset + 24)
  return bytes
}

function macZipWithUnixSymlink(path: string, target: string, host = 3, level: 0 | 1 = 1): Buffer {
  const archive = Buffer.from(zipSync({ [path]: Buffer.from(target) }, { level }))
  const centralDirectory = firstZipCentralDirectory(archive)
  archive.writeUInt16LE((host << 8) | 20, centralDirectory + 4)
  archive.writeUInt32LE(0o120777 * 0x1_0000, centralDirectory + 38)
  return archive
}

function firstZipCentralDirectory(archive: Buffer): number {
  const centralDirectory = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  if (centralDirectory === -1) throw new Error('fixture ZIP has no central directory')
  return centralDirectory
}

function zipCentralDirectories(archive: Buffer): readonly number[] {
  const eocd = archive.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd === -1) throw new Error('fixture ZIP has no end record')
  const count = archive.readUInt16LE(eocd + 10)
  const entries: number[] = []
  let offset = archive.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    entries.push(offset)
    offset += 46 + archive.readUInt16LE(offset + 28)
      + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
  }
  return entries
}

function replaceFirstZipEntryData(archive: Buffer, data: Buffer): Buffer {
  const centralDirectory = firstZipCentralDirectory(archive)
  const eocd = archive.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), centralDirectory)
  if (eocd === -1) throw new Error('fixture ZIP has no end record')
  const dataStart = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28)
  const replaced = Buffer.concat([archive.subarray(0, dataStart), data, archive.subarray(centralDirectory)])
  const movedCentralDirectory = dataStart + data.length
  const movedEocd = movedCentralDirectory + (eocd - centralDirectory)
  replaced.writeUInt32LE(data.length, 18)
  replaced.writeUInt32LE(data.length, movedCentralDirectory + 20)
  replaced.writeUInt32LE(movedCentralDirectory, movedEocd + 16)
  return replaced
}

function emptyBlockDeflate(blocks: number): Buffer {
  const compressed = Buffer.alloc(blocks * 5 + 6)
  for (let index = 0; index < blocks; index += 1) {
    const offset = index * 5
    compressed[offset] = 0
    compressed.writeUInt16LE(0, offset + 1)
    compressed.writeUInt16LE(0xffff, offset + 3)
  }
  const final = blocks * 5
  compressed[final] = 1
  compressed.writeUInt16LE(1, final + 1)
  compressed.writeUInt16LE(0xfffe, final + 3)
  compressed[final + 5] = 0x41
  return compressed
}

function tarWithEntry(path: string, type: '0' | '2' | '5'): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  writeTarOctal(header, 100, 8, type === '2' ? 0o777 : 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, 0)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  if (type === '2') header.write('target', 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return Buffer.concat([header, Buffer.alloc(1024)])
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, '0')
  buffer.write(`${encoded}\0 `, offset, length, 'ascii')
}

function tools(overrides: Partial<DesktopArtifactTools> = {}): DesktopArtifactTools {
  return {
    inspectCanonicalRollbackWorkers: async () => canonicalWorkers,
    inspectCanonicalWindowsSupervisor: async () => canonicalWindowsSupervisor,
    inspectWindowsInstaller: async () => ({
      entries: [
        'resources/update-policy.json',
        'resources/windows-native-rollback-worker.ps1',
        'resources/native-rollback-worker.js',
        'resources/chunks/native-rollback-request-fixture.js',
        'resources/windows-native-update-supervisor.exe',
      ],
      updatePolicy,
      windowsNativeUpdateSupervisor: canonicalWindowsSupervisor,
      ...canonicalWorkers,
    }),
    inspectAsar: async () => runtimeAsarEntries,
    inspectAsarSha256: async () => canonicalWorkers.appAsarSha256,
    loadPackagedRuntime: async () => true,
    inspectMacDmg: async () => ({
      entries: macResources,
      lipoInfo: 'Architectures in the fat file: harness-desktop are: x86_64 arm64',
      updatePolicy,
      ...canonicalWorkers,
    }),
    inspectMacZip: async () => ({
      entries: macResources,
      lipoInfo: 'Architectures in the fat file: harness-desktop are: x86_64 arm64',
      updatePolicy,
      ...canonicalWorkers,
    }),
    inspectAppImage: async () => ({ entries: appImageResources, updatePolicy, ...canonicalWorkers }),
    inspectDeb: async () => ({ entries: debResources, updatePolicy, ...canonicalWorkers }),
    ...overrides,
  }
}

describe('verifyDesktopArtifactsWithTools', () => {
  it('accepts only a complete AMD64 PE32+ Windows GUI supervisor header', () => {
    expect(verifyWindowsSupervisor(windowsSupervisorPe())).toEqual({
      machine: 'amd64',
      subsystem: 'windows-gui',
    })
    const invalid = [
      ['DOS signature', mutatedWindowsSupervisorPe(bytes => bytes.writeUInt16LE(0, 0))],
      ['PE signature', mutatedWindowsSupervisorPe((bytes, peOffset) => bytes.writeUInt32LE(0, peOffset))],
      ['AMD64 machine', mutatedWindowsSupervisorPe((bytes, peOffset) => bytes.writeUInt16LE(0x014c, peOffset + 4))],
      ['PE32+ magic', mutatedWindowsSupervisorPe((bytes, _peOffset, optional) => bytes.writeUInt16LE(0x10b, optional))],
      ['optional-header size', mutatedWindowsSupervisorPe((bytes, peOffset) => bytes.writeUInt16LE(68, peOffset + 20))],
      ['truncated optional header', windowsSupervisorPe().subarray(0, 0x80 + 24 + 69)],
      ['GUI subsystem', mutatedWindowsSupervisorPe((bytes, _peOffset, optional) => bytes.writeUInt16LE(3, optional + 68))],
    ] as const
    for (const [label, bytes] of invalid) {
      expect(verifyWindowsSupervisor(bytes), label).toBeUndefined()
    }
  })

  it('stops a same-inode snapshot read after one byte of growth evidence', async () => {
    const source = Buffer.from('grown')
    let largestRequestedRead = 0
    const handle = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        largestRequestedRead = Math.max(largestRequestedRead, length)
        const bytesRead = Math.min(length, source.length - position)
        source.copy(buffer, offset, position, position + bytesRead)
        return { bytesRead }
      },
    }

    await expect(readBoundedArtifactBytes(handle, 4, 4))
      .rejects.toThrow('source artifact changed during snapshot')
    expect(largestRequestedRead).toBe(5)
  })

  it('reads an original artifact once into an exclusive private snapshot', async () => {
    const root = await releaseRoot()
    const original = join(root, 'original.zip')
    await file(original, 'original bytes')
    const reads: string[] = []
    const writes: Array<{ readonly path: string; readonly flag: string; readonly mode: number }> = []
    const operations: ArtifactSnapshotOperations = {
      async readFile(path) {
        reads.push(path)
        return readFile(path)
      },
      mkdtemp: prefix => mkdtemp(prefix),
      async writeFile(path, bytes, options) {
        writes.push({ path, ...options })
        await writeFile(path, bytes, options)
      },
      removeDirectory: path => rm(path, { recursive: true, force: true }),
    }

    const observed = await inspectPrivateArtifactSnapshot(original, 'artifact.zip', async (snapshotPath, snapshot) => {
      await writeFile(original, 'changed bytes')
      return { snapshotPath, memory: snapshot.toString(), disk: (await readFile(snapshotPath)).toString() }
    }, operations)

    expect(reads).toEqual([original])
    expect(writes).toEqual([{ path: observed.snapshotPath, flag: 'wx', mode: 0o600 }])
    expect(observed.snapshotPath).not.toBe(original)
    expect(observed.memory).toBe('original bytes')
    expect(observed.disk).toBe('original bytes')
  })

  it('permits only a macOS framework-local ZIP symbolic link before extraction', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
        'A',
      ))
    }).not.toThrow()
  })

  it('rejects a macOS ZIP symbolic link that redirects a required update resource', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Resources/update-policy.json',
        'other-policy.json',
      ))
    }).toThrow('symbolic link redirects required path')
  })

  it('rejects a macOS ZIP symbolic link that redirects an imported native rollback module', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Resources/chunks/native-rollback-request-fixture.js',
        'other-module.js',
      ))
    }).toThrow('symbolic link redirects required path')
  })

  it('rejects a macOS-host ZIP symbolic link that redirects a required update resource', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Resources/update-policy.json',
        'other-policy.json',
        19,
      ))
    }).toThrow('symbolic link redirects required path')
  })

  it('rejects an oversized macOS ZIP symbolic link target without inflating the archive', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
        'A'.repeat(4_097),
      ))
    }).toThrow('symbolic link target is too large')
  })

  it('rejects an oversized stored symbolic-link input before copying it', () => {
    const archive = replaceFirstZipEntryData(macZipWithUnixSymlink(
      'Harness Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
      'A',
      3,
      0,
    ), Buffer.alloc(8_193, 0x41))
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('symbolic link compressed target is too large')
  })

  it('rejects excessive empty DEFLATE blocks before synchronous inflation', () => {
    const archive = replaceFirstZipEntryData(macZipWithUnixSymlink(
      'Harness Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
      'A',
    ), emptyBlockDeflate(2_000))
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('symbolic link compressed target is too large')
  })

  it('accepts an ordinary ZIP member with matching central and local metadata', () => {
    expect(() => {
      assertSafeMacZipSnapshot(Buffer.from(zipSync({
        'Harness Desktop.app/Contents/Resources/update-policy.json': Buffer.from('policy'),
      })))
    }).not.toThrow()
  })

  it('rejects a safe central path paired with an unsafe local path', () => {
    const path = 'Harness Desktop.app/Contents/Resources/update-policy.json'
    const archive = Buffer.from(zipSync({ [path]: Buffer.from('policy') }, { level: 0 }))
    Buffer.from(`../${'x'.repeat(Buffer.byteLength(path) - 3)}`).copy(archive, 30)
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('member local path differs')
  })

  it('rejects an ordinary ZIP member whose declared expansion exceeds the per-member budget', () => {
    const archive = Buffer.from(zipSync({
      'Harness Desktop.app/Contents/Resources/update-policy.json': Buffer.from('policy'),
    }, { level: 0 }))
    archive.writeUInt32LE(513 * 1_024 * 1_024, firstZipCentralDirectory(archive) + 24)
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('ZIP member is too large')
  })

  it('rejects an ordinary ZIP member whose compressed input exceeds the per-member budget', () => {
    const archive = Buffer.from(zipSync({
      'Harness Desktop.app/Contents/Resources/update-policy.json': Buffer.from('policy'),
    }, { level: 0 }))
    archive.writeUInt32LE(513 * 1_024 * 1_024, firstZipCentralDirectory(archive) + 20)
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('ZIP compressed member is too large')
  })

  it('rejects an aggregate ZIP expansion beyond the extraction budget', () => {
    const archive = Buffer.from(zipSync({
      'Harness Desktop.app/a': Buffer.from('a'),
      'Harness Desktop.app/b': Buffer.from('b'),
      'Harness Desktop.app/c': Buffer.from('c'),
      'Harness Desktop.app/d': Buffer.from('d'),
      'Harness Desktop.app/e': Buffer.from('e'),
    }, { level: 0 }))
    for (const centralDirectory of zipCentralDirectories(archive)) {
      archive.writeUInt32LE(500 * 1_024 * 1_024, centralDirectory + 24)
    }
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('ZIP total uncompressed size is too large')
  })

  it('rejects aggregate compressed ZIP input beyond the parser budget', () => {
    const archive = Buffer.from(zipSync({
      'Harness Desktop.app/a': Buffer.from('a'),
      'Harness Desktop.app/b': Buffer.from('b'),
      'Harness Desktop.app/c': Buffer.from('c'),
    }, { level: 0 }))
    for (const centralDirectory of zipCentralDirectories(archive)) {
      archive.writeUInt32LE(400 * 1_024 * 1_024, centralDirectory + 20)
    }
    expect(() => {
      assertSafeMacZipSnapshot(archive)
    }).toThrow('ZIP total compressed size is too large')
  })

  it('rejects a macOS framework symbolic link that escapes its framework', () => {
    expect(() => {
      assertSafeMacZipSnapshot(macZipWithUnixSymlink(
        'Harness Desktop.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
        '../../../../outside',
      ))
    }).toThrow('symbolic link escapes its framework')
  })

  it('rejects a Debian payload symbolic link before extraction', () => {
    expect(() => {
      assertSafeDebTarSnapshot(tarWithEntry('./opt/Harness Desktop/resources/update-policy.json', '2'))
    }).toThrow('Linux Deb has unsupported payload member type SymbolicLink')
  })

  it('does not extract a Debian payload after hostile preflight metadata', async () => {
    const root = await releaseRoot()
    const artifact = join(root, 'artifact.deb')
    await file(artifact)
    const commands: string[] = []

    await expect(inspectDebArtifactSnapshot(artifact, async (args, stdoutFile) => {
      const operation = args[0]
      if (operation === undefined) throw new Error('fixture command has no operation')
      commands.push(operation)
      if (stdoutFile !== undefined) {
        await writeFile(stdoutFile, tarWithEntry('./opt/Harness Desktop/resources/update-policy.json', '2'))
      }
    })).rejects.toThrow('Linux Deb has unsupported payload member type SymbolicLink')
    expect(commands).toEqual(['--fsys-tarfile'])
  })

  it('accepts an ordinary Debian payload directory member', () => {
    expect(() => {
      assertSafeDebTarSnapshot(tarWithEntry('./opt/Harness Desktop/resources/', '5'))
    }).not.toThrow()
  })

  it('rejects a Debian payload path that escapes the extraction root', () => {
    expect(() => {
      assertSafeDebTarSnapshot(tarWithEntry('../../outside', '0'))
    }).toThrow('Linux Deb has unsafe payload member path')
  })

  it('accepts the exact Windows NSIS, unpacked executable, asar, and generated icon resources', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools()))
      .resolves.toEqual([])
  })

  it('requires the native supervisor in both the final Windows installer and unpacked resources', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    await rm(join(root, 'win-unpacked', 'resources', 'windows-native-update-supervisor.exe'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/chunks/native-rollback-request-fixture.js',
        ],
        updatePolicy,
        windowsNativeUpdateSupervisor: undefined,
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: missing Windows native update supervisor resource',
      'desktop artifact: missing unpacked Windows native update supervisor resource',
    ])
  })

  it('rejects substituted native supervisor bytes in the installer and unpacked resources', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    const substituted = Buffer.from(canonicalWindowsSupervisor)
    substituted[substituted.length - 1] = 1
    await file(join(root, 'win-unpacked', 'resources', 'windows-native-update-supervisor.exe'), substituted)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/chunks/native-rollback-request-fixture.js',
          'resources/windows-native-update-supervisor.exe',
        ],
        updatePolicy,
        windowsNativeUpdateSupervisor: substituted,
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: Windows native update supervisor resource does not match canonical bytes',
      'desktop artifact: unpacked Windows native update supervisor resource does not match canonical bytes',
    ])
  })

  it('rejects native supervisor PE bytes unless they are AMD64 and use the Windows GUI subsystem', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    const invalidPe = windowsSupervisorPe(0x014c, 3)
    await file(join(root, 'win-unpacked', 'resources', 'windows-native-update-supervisor.exe'), invalidPe)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectCanonicalWindowsSupervisor: async () => invalidPe,
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/chunks/native-rollback-request-fixture.js',
          'resources/windows-native-update-supervisor.exe',
        ],
        updatePolicy,
        windowsNativeUpdateSupervisor: invalidPe,
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: Windows native update supervisor resource is not an AMD64 Windows GUI executable',
      'desktop artifact: unpacked Windows native update supervisor resource is not an AMD64 Windows GUI executable',
    ])
  })

  it('selects the expected Windows version without treating a stale installer as a duplicate', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'Harness Desktop Setup 1.0.1.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({
      platform: 'win32', releaseDirectory: root, expectedVersion: '1.0.1',
    }, tools())).resolves.toEqual([])
  })

  it('rejects unpacked Windows application bytes from a different installer build', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.1.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    const mismatchedTools = tools() as DesktopArtifactTools & {
      inspectAsarSha256(path: string): Promise<string>
    }
    mismatchedTools.inspectWindowsInstaller = async () => ({
      entries: [
        'resources/update-policy.json',
        'resources/windows-native-rollback-worker.ps1',
        'resources/native-rollback-worker.js',
        'resources/chunks/native-rollback-request-fixture.js',
        'resources/windows-native-update-supervisor.exe',
      ],
      updatePolicy,
      windowsNativeUpdateSupervisor: canonicalWindowsSupervisor,
      ...canonicalWorkers,
      appAsarSha256: 'new-installer-asar',
    })
    mismatchedTools.inspectAsarSha256 = async () => 'old-unpacked-asar'

    await expect(verifyDesktopArtifactsWithTools({
      platform: 'win32', releaseDirectory: root, expectedVersion: '1.0.1',
    }, mismatchedTools)).resolves.toEqual([
      'desktop artifact: unpacked Windows app.asar does not match the selected installer',
    ])
  })

  it('reports a missing Windows installer and generated icon independently', async () => {
    const root = await releaseRoot()
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectAsar: async () => runtimeAsarEntries.filter(entry => !entry.includes('resources\\icons\\')),
    }))).resolves.toEqual([
      'desktop artifact: missing Windows NSIS installer',
      'desktop artifact: missing generated Windows icon',
    ])
  })

  it('rejects a Windows asar that cannot resolve the packaged Runtime home-path dependency', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectAsar: async () => runtimeAsarEntries.filter(entry => !entry.includes('dsh-home-paths')),
    }))).resolves.toEqual([
      'desktop artifact: packaged Runtime cannot resolve @harness-desktop/dsh-home-paths',
    ])
  })

  it('rejects a Windows asar whose packaged Runtime entry cannot load', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    const failingTools = tools() as DesktopArtifactTools & {
      loadPackagedRuntime(executable: string, asar: string): Promise<boolean>
    }
    failingTools.loadPackagedRuntime = async () => false

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, failingTools))
      .resolves.toEqual(['desktop artifact: packaged Runtime entry cannot load'])
  })

  it('rejects a malformed final Windows installer policy even when win-unpacked has a valid resource', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)
    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/chunks/native-rollback-request-fixture.js',
          'resources/windows-native-update-supervisor.exe',
        ],
        updatePolicy: Buffer.from('{"schemaVersion":1}\n'),
        windowsNativeUpdateSupervisor: canonicalWindowsSupervisor,
        ...canonicalWorkers,
      }),
    })))
      .resolves.toEqual(['desktop artifact: Windows update policy resource is invalid'])
  })

  it('requires both macOS universal installers to carry both architectures and the generated icon', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0-universal.dmg'))
    await file(join(root, 'Harness Desktop-1.0.0-universal-mac.zip'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'darwin', releaseDirectory: root }, tools({
      inspectMacDmg: async () => ({
        entries: macResources,
        lipoInfo: 'Non-fat file: harness-desktop is architecture: arm64',
        updatePolicy,
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: macOS DMG application binary is missing x86_64 architecture',
    ])
  })

  it('rejects mismatched macOS installer semantic versions', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0-universal.dmg'))
    await file(join(root, 'Harness Desktop-1.0.1-universal-mac.zip'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'darwin', releaseDirectory: root }, tools()))
      .resolves.toEqual(['desktop artifact: macOS DMG and ZIP semantic versions differ'])
  })

  it('rejects mismatched macOS installer update policy bytes', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0-universal.dmg'))
    await file(join(root, 'Harness Desktop-1.0.0-universal-mac.zip'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'darwin', releaseDirectory: root }, tools({
      inspectMacZip: async () => ({
        entries: macResources,
        lipoInfo: 'Architectures in the fat file: harness-desktop are: x86_64 arm64',
        updatePolicy: Buffer.concat([updatePolicy, Buffer.from('\n')]),
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: macOS DMG and ZIP update policy bytes differ',
    ])
  })

  it('rejects a packaged rollback worker whose bytes are not canonical', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/chunks/native-rollback-request-fixture.js',
          'resources/windows-native-update-supervisor.exe',
        ],
        updatePolicy,
        windowsNativeUpdateSupervisor: canonicalWindowsSupervisor,
        ...canonicalWorkers,
        windowsRollbackWorker: Buffer.from('substituted worker'),
      }),
    }))).resolves.toEqual([
      'desktop artifact: Windows Windows native rollback worker resource does not match canonical bytes',
    ])
  })

  it('rejects a final installer missing a split native rollback worker module', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop Setup 1.0.0.exe'))
    await file(join(root, 'win-unpacked', 'harness-desktop.exe'))
    await windowsResources(root)

    await expect(verifyDesktopArtifactsWithTools({ platform: 'win32', releaseDirectory: root }, tools({
      inspectWindowsInstaller: async () => ({
        entries: [
          'resources/update-policy.json',
          'resources/windows-native-rollback-worker.ps1',
          'resources/native-rollback-worker.js',
          'resources/windows-native-update-supervisor.exe',
        ],
        updatePolicy,
        windowsNativeUpdateSupervisor: canonicalWindowsSupervisor,
        ...canonicalWorkers,
        nativeRollbackWorkerChunks: {},
      }),
    }))).resolves.toEqual([
      'desktop artifact: missing Windows native rollback program chunk "native-rollback-request-fixture.js"',
    ])
  })

  it('requires both Linux package formats and their generated icon resource', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectAppImage: async () => ({ entries: appImageResources.slice(1), updatePolicy, ...canonicalWorkers }),
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
      inspectAppImage: async () => ({ entries: appImageResources, updatePolicy, ...canonicalWorkers }),
      inspectDeb: async () => ({ entries: debResources.slice(1), updatePolicy, ...canonicalWorkers }),
    }))).resolves.toEqual([
      'desktop artifact: missing generated Linux Deb icon',
    ])
  })

  it('rejects mismatched Linux package semantic versions', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.1_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools()))
      .resolves.toEqual(['desktop artifact: Linux AppImage and Deb semantic versions differ'])
  })

  it('rejects mismatched Linux package update policy bytes', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.0_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectDeb: async () => ({
        entries: debResources,
        updatePolicy: Buffer.concat([updatePolicy, Buffer.from(' ')]),
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: Linux AppImage and Deb update policy bytes differ',
    ])
  })

  it('does not require a Desktop self-update endpoint from a Debian package', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.0_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools()))
      .resolves.toEqual([])
  })

  it('rejects a malformed AppImage policy even when a valid distractor policy is listed elsewhere', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.0_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectAppImage: async () => ({
        entries: [...appImageResources, 'distractor/update-policy.json'],
        updatePolicy: Buffer.from('{"schemaVersion":1}\n'),
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: Linux AppImage update policy resource is invalid',
      'desktop artifact: Linux AppImage and Deb update policy bytes differ',
    ])
  })

  it('reports an unreadable exact Linux Deb policy without treating another policy filename as proof', async () => {
    const root = await releaseRoot()
    await file(join(root, 'Harness Desktop-1.0.0.AppImage'))
    await file(join(root, 'harness-desktop_1.0.0_amd64.deb'))

    await expect(verifyDesktopArtifactsWithTools({ platform: 'linux', releaseDirectory: root }, tools({
      inspectDeb: async () => ({
        entries: [...debResources, 'distractor/update-policy.json'],
        updatePolicy: undefined,
        ...canonicalWorkers,
      }),
    }))).resolves.toEqual([
      'desktop artifact: cannot read Linux Deb update policy resource',
    ])
  })
})
