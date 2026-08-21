import { execFileSync } from 'node:child_process'
import { rm, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

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
  expect(main).not.toContain('@harness-desktop/dsh-app-boot/product-metadata')
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
