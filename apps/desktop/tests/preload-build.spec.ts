import { execFileSync } from 'node:child_process'
import { rm, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { resolveUnpackedDesktopExecutable } from './support/runtime-fixture.ts'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const outDir = fileURLToPath(new URL('../out', import.meta.url))

beforeAll(async () => {
  await rm(outDir, { recursive: true, force: true })
  const electronViteCli = fileURLToPath(
    new URL('./bin/electron-vite.js', import.meta.resolve('electron-vite/package.json')),
  )
  execFileSync(process.execPath, [electronViteCli, 'build'], {
    cwd: desktopRoot,
    stdio: 'pipe',
  })
}, 30_000)

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
})

it('builds one CommonJS preload and makes the main process load it', async () => {
  expect(await readdir(fileURLToPath(new URL('../out/preload', import.meta.url))))
    .toEqual(['index.cjs'])

  const preload = await readFile(fileURLToPath(new URL('../out/preload/index.cjs', import.meta.url)), 'utf8')
  expect(preload).toContain('require("electron")')
  expect(preload).not.toMatch(/^\s*import\s/m)

  const main = await readFile(fileURLToPath(new URL('../out/main/index.js', import.meta.url)), 'utf8')
  expect(main).toContain('../preload/index.cjs')
  expect(main).toContain('from "@harness-desktop/dsh-host-local-runtime"')
  expect(main).not.toContain('@harness-desktop/dsh-app-boot/product-metadata')
  expect(main).not.toContain('HARNESS_HOME')
  expect(main).not.toContain('DesktopShell')
  expect(main).not.toMatch(/credentials-(?:local|file)|credential-provider/u)
})

it('resolves the platform unpacked executable under the clean release root', () => {
  const releaseRoot = fileURLToPath(new URL('../release', import.meta.url))
  expect(resolveUnpackedDesktopExecutable(releaseRoot, 'win32')).toBe(
    fileURLToPath(new URL('../release/win-unpacked/harness-desktop.exe', import.meta.url)),
  )
  expect(resolveUnpackedDesktopExecutable(releaseRoot, 'darwin')).toBe(
    fileURLToPath(new URL('../release/mac-universal/Harness Desktop.app/Contents/MacOS/harness-desktop', import.meta.url)),
  )
  expect(resolveUnpackedDesktopExecutable(releaseRoot, 'linux')).toBe(
    fileURLToPath(new URL('../release/linux-unpacked/harness-desktop', import.meta.url)),
  )
})

it('builds a network-isolated recovery bootstrap without a copied product name', async () => {
  const html = await readFile(fileURLToPath(new URL('../out/renderer/index.html', import.meta.url)), 'utf8')
  expect(html).toContain('<title>Dashboard recovery</title>')
  expect(html).toContain("connect-src 'none'")
  expect(html).not.toMatch(/\b(?:https?:|wss?:)/)
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  expect(html).not.toContain('Harness Desktop')
  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" />')
  expect(await readFile(fileURLToPath(new URL('../out/renderer/favicon.svg', import.meta.url)), 'utf8'))
    .toContain('Generated from assets/brand/harness-icon.svg; do not edit.')
})
