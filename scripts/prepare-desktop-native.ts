/** Prepare the target-specific native resources consumed by Desktop packaging. */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildWindowsNativeUpdateSupervisor } from './build-windows-native-update-supervisor.ts'

const root = resolve(import.meta.dirname, '..')
const windowsSupervisor = join(
  root,
  'apps',
  'desktop',
  'out',
  'native',
  'win32-x64',
  'windows-native-update-supervisor.exe',
)

/** Operations used to compile and inspect the Windows Desktop native resource. */
export interface DesktopNativePreparationInput {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly build: () => void | Promise<void>
  readonly readArtifact: () => Promise<Buffer>
}

/**
 * Prepare the current platform's Desktop native resources.
 * @param input - Platform selection plus the Windows producer and artifact reader.
 * @returns Whether the current platform required native preparation.
 */
export async function prepareDesktopNative(
  input: DesktopNativePreparationInput,
): Promise<'prepared' | 'skipped'> {
  if (input.platform !== 'win32') return 'skipped'
  if (input.arch !== 'x64') {
    throw new Error(`Desktop native preparation requires Windows x64, received ${input.platform}/${input.arch}`)
  }
  await input.build()
  if (!isAmd64GuiPe(await input.readArtifact())) {
    throw new Error('Desktop native preparation did not produce a valid AMD64 PE32+ Windows GUI executable')
  }
  return 'prepared'
}

function isAmd64GuiPe(bytes: Buffer): boolean {
  if (bytes.length < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return false
  const peOffset = bytes.readUInt32LE(0x3c)
  const optionalHeader = peOffset + 24
  if (peOffset > bytes.length - 94) return false
  return bytes.subarray(peOffset, peOffset + 4).toString('binary') === 'PE\0\0'
    && bytes.readUInt16LE(peOffset + 4) === 0x8664
    && bytes.readUInt16LE(optionalHeader) === 0x20b
    && bytes.readUInt16LE(optionalHeader + 68) === 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await prepareDesktopNative({
    platform: process.platform,
    arch: process.arch,
    build: buildWindowsNativeUpdateSupervisor,
    readArtifact: async () => await readFile(windowsSupervisor),
  })
  process.stdout.write(`prepare:desktop-native: ${result}.\n`)
}
