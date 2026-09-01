import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const installer = readFileSync(
  fileURLToPath(new URL('../build/installer.nsh', import.meta.url)),
  'utf8',
)

interface MarkerRead {
  readonly open: boolean
  readonly read: boolean
  readonly close: boolean
  readonly value: string
  /** Whether the NSIS policy delete instruction succeeds. */
  readonly deletePolicy?: boolean
  /** Whether the NSIS state-marker delete instruction succeeds. */
  readonly deleteState?: boolean
}

/** Execute the customInstall subset that decides whether a predecessor policy survives. */
function installState(marker: MarkerRead): { readonly policyPresent: boolean; readonly markerPresent: boolean } {
  const body = installer.match(/!macro customInstall\r?\n([\s\S]*?)!macroend/u)?.[1]
  if (body === undefined) throw new Error('installer.nsh has no customInstall macro')

  const instructions = body.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && !line.startsWith(';'))
  const labels = new Map<string, number>()
  for (const [index, line] of instructions.entries()) {
    if (line.endsWith(':')) labels.set(line.slice(0, -1), index)
  }
  const jump = (label: string): number => {
    const destination = labels.get(label)
    if (destination === undefined) throw new Error(`unknown NSIS label: ${label}`)
    return destination
  }
  let errors = false
  let value = ''
  let byte = 0
  let offset = 0
  let policyPresent = true
  let markerPresent = true
  for (let index = 0; index < instructions.length; index += 1) {
    const line = instructions[index] ?? ''
    if (line.endsWith(':')) continue
    if (line === 'ClearErrors') {
      errors = false
    } else if (line === 'StrCpy $1 "0"') {
      value = '0'
    } else if (line === 'StrCpy $1 "1"') {
      value = '1'
    } else if (line.startsWith('FileOpen ')) {
      errors = !marker.open
      offset = 0
    } else if (line.startsWith('FileRead ')) {
      errors = !marker.read
      if (!errors) {
        value = marker.value.slice(offset, offset + 7)
        offset += value.length
      }
    } else if (line.startsWith('FileReadByte ')) {
      errors = offset >= marker.value.length
      if (!errors) {
        byte = marker.value.charCodeAt(offset)
        offset += 1
      }
    } else if (line.startsWith('FileClose ')) {
      errors = !marker.close
    } else if (line.startsWith('IfErrors ')) {
      const [onError, onSuccess] = line.slice('IfErrors '.length).split(' ')
      if (errors) index = jump(onError ?? '')
      else if (onSuccess !== undefined) index = jump(onSuccess)
    } else if (line.startsWith('StrCmpS $1 "present" 0 ')) {
      if (value !== 'present') index = jump(line.slice('StrCmpS $1 "present" 0 '.length))
    } else if (line.startsWith('IntCmp $2 10 ')) {
      const [equal, less, greater] = line.slice('IntCmp $2 10 '.length).split(' ')
      if (equal === undefined || less === undefined || greater === undefined) throw new Error(`invalid IntCmp: ${line}`)
      index = jump(byte === 10 ? equal : byte < 10 ? less : greater)
    } else if (line.startsWith('StrCmp $1 "1" ')) {
      const [equal, unequal] = line.slice('StrCmp $1 "1" '.length).split(' ')
      if (equal === undefined || unequal === undefined) throw new Error(`invalid StrCmp: ${line}`)
      index = jump(value === '1' ? equal : unequal)
    } else if (line.startsWith('Goto ')) {
      index = jump(line.slice('Goto '.length))
    } else if (line === 'Delete "$INSTDIR\\resources\\update-policy.json"') {
      errors = marker.deletePolicy === false
      if (!errors) policyPresent = false
    } else if (line === 'Delete "$INSTDIR\\resources\\update-policy-state"') {
      errors = marker.deleteState === false
      if (!errors) markerPresent = false
    } else if (line.startsWith('Abort ')) {
      throw new Error(line)
    } else {
      throw new Error(`unsupported NSIS instruction: ${line}`)
    }
  }
  return { policyPresent, markerPresent }
}

describe('NSIS update-policy state marker', () => {
  it.each([
    ['present marker', { open: true, read: true, close: true, value: 'present\n' }, true],
    ['absent marker', { open: true, read: true, close: true, value: 'absent\n' }, false],
    ['unknown marker', { open: true, read: true, close: true, value: 'unknown\n' }, false],
    ['prefix-confused absent marker', { open: true, read: true, close: true, value: 'absent-corrupt\n' }, false],
    ['empty marker', { open: true, read: true, close: true, value: '' }, false],
    ['open failure', { open: false, read: false, close: false, value: '' }, false],
    ['read failure', { open: true, read: false, close: true, value: '' }, false],
    ['close failure', { open: true, read: true, close: false, value: 'present\n' }, false],
  ] as const)('keeps a predecessor policy only for a successful exact %s', (_name, marker, expected) => {
    expect(installState(marker)).toEqual({ policyPresent: expected, markerPresent: false })
  })

  it.each([
    ['policy delete failure', { open: true, read: true, close: true, value: 'absent\n', deletePolicy: false }],
    ['state-marker delete failure', { open: true, read: true, close: true, value: 'present\n', deleteState: false }],
  ] as const)('aborts installation after a %s', (_name, marker) => {
    expect(() => installState(marker)).toThrow('Abort "Harness Desktop update policy state could not be retired"')
  })
})
