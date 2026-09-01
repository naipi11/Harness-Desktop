import { describe, expect, it } from 'vitest'
import { prepareDesktopNative } from './prepare-desktop-native.ts'

function amd64GuiPe(): Buffer {
  const bytes = Buffer.alloc(0x100)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'binary')
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(0x20b, 0x98)
  bytes.writeUInt16LE(2, 0x98 + 68)
  return bytes
}

describe('Desktop native preparation', () => {
  it('does nothing outside Windows without inspecting an artifact', async () => {
    let builds = 0
    let reads = 0

    await expect(prepareDesktopNative({
      platform: 'linux',
      arch: 'x64',
      build: () => { builds += 1 },
      readArtifact: async () => { reads += 1; return amd64GuiPe() },
    }))
      .resolves.toBe('skipped')
    expect(builds).toBe(0)
    expect(reads).toBe(0)
  })

  it('rebuilds and validates an AMD64 GUI PE on every Windows x64 call', async () => {
    let builds = 0
    let reads = 0
    const input = {
      platform: 'win32' as const,
      arch: 'x64',
      build: () => { builds += 1 },
      readArtifact: async () => { reads += 1; return amd64GuiPe() },
    }

    await expect(prepareDesktopNative(input)).resolves.toBe('prepared')
    await expect(prepareDesktopNative(input)).resolves.toBe('prepared')
    expect(builds).toBe(2)
    expect(reads).toBe(2)
  })

  it('rejects a malformed artifact after rebuilding', async () => {
    let builds = 0

    await expect(prepareDesktopNative({
      platform: 'win32',
      arch: 'x64',
      build: () => { builds += 1 },
      readArtifact: async () => Buffer.from('stale'),
    })).rejects.toThrow('valid AMD64 PE32+ Windows GUI executable')
    expect(builds).toBe(1)
  })
})
