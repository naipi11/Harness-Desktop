import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createWindowOptions, desktopIconPath } from '../src/main/window-options.ts'

interface BuilderIconConfig {
  readonly win: { readonly icon: string }
  readonly mac: { readonly icon: string }
  readonly linux: { readonly icon: string }
  readonly nsis: { readonly include: string }
}

const windowsIcon = fileURLToPath(
  new URL('../resources/icons/win/harness-desktop.ico', import.meta.url),
)
const macIcon = fileURLToPath(
  new URL('../resources/icons/mac/harness-desktop.icns', import.meta.url),
)
const linuxIcon = fileURLToPath(
  new URL('../resources/icons/linux/harness-desktop-512.png', import.meta.url),
)
const nsisInclude = fileURLToPath(new URL('../build/installer.nsh', import.meta.url))
const desktopManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> }
const builderModule: unknown = await import(
  pathToFileURL(fileURLToPath(new URL('../electron-builder.config.mjs', import.meta.url))).href,
)
const builderConfig = (builderModule as { readonly default: BuilderIconConfig }).default

it('selects the generated native icon for each desktop platform', () => {
  expect(desktopIconPath('win32')).toBe(windowsIcon)
  expect(desktopIconPath('darwin')).toBe(macIcon)
  expect(desktopIconPath('linux')).toBe(linuxIcon)
  expect(createWindowOptions('preload', desktopIconPath('win32')).icon).toBe(windowsIcon)
})

it('configures Electron Builder to package the generated native icons', () => {
  expect(builderConfig.win.icon).toBe('resources/icons/win/harness-desktop.ico')
  expect(builderConfig.mac.icon).toBe('resources/icons/mac/harness-desktop.icns')
  expect(builderConfig.linux.icon).toBe('resources/icons/linux/harness-desktop-512.png')
})

it('removes a predecessor update policy when the new NSIS package explicitly omits one', () => {
  expect(builderConfig.nsis.include).toBe('build/installer.nsh')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('!macro customInstall')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('FileOpen $0 "$INSTDIR\\resources\\update-policy-state" r')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('FileRead $0 $1 7')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('StrCmpS $1 "present" 0 policy_state_close')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('FileReadByte $0 $2')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('IntCmp $2 10 policy_state_eof policy_state_close policy_state_close')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('Delete "$INSTDIR\\resources\\update-policy.json"')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('Delete "$INSTDIR\\resources\\update-policy-state"')
  expect(readFileSync(nsisInclude, 'utf8')).toContain('Abort "Harness Desktop update policy state could not be retired"')
})

it('verifies generated icons before each Desktop packaging command', () => {
  const checks = 'pnpm --dir ../.. run verify:icons && pnpm --dir ../.. run verify:desktop-runtime-closure && pnpm --dir ../.. run prepare:desktop-native'
  expect(desktopManifest.scripts.prepackage).toBe(checks)
  expect(desktopManifest.scripts['prepackage:dir']).toBe(checks)
})
