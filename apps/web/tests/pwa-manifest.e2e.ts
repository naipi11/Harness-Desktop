import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Harness Desktop',
    short_name: 'harness',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/icons/harness-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/harness-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/harness-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  })
})

it('ships generated PWA icons and light and dark favicon artwork', async () => {
  for (const path of [
    'icons/harness-192.png',
    'icons/harness-512.png',
    'icons/harness-maskable-512.png',
  ]) {
    expect((await readFile(join(DIST_ROOT, path))).byteLength, path).toBeGreaterThan(0)
  }

  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  expect(favicon).toContain('Generated from assets/brand/harness-icon.svg')
  expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*light\)/)
  expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/)
  expect(favicon).toContain('href="#theme-light"')
  expect(favicon).toContain('href="#theme-dark"')
})
