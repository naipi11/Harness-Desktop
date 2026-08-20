import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectProductIconViolations,
  createProductIconRenderInput,
  generateProductIconsAtRoot,
} from './generate-product-icons.ts'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_PATH = join(REPOSITORY_ROOT, 'assets', 'brand', 'harness-icon.svg')
const temporaryRoots: string[] = []

const pngAssets = new Map<string, number>([
  ['apps/desktop/resources/icons/linux/harness-desktop-16.png', 16],
  ['apps/desktop/resources/icons/linux/harness-desktop-32.png', 32],
  ['apps/desktop/resources/icons/linux/harness-desktop-64.png', 64],
  ['apps/desktop/resources/icons/linux/harness-desktop-128.png', 128],
  ['apps/desktop/resources/icons/linux/harness-desktop-256.png', 256],
  ['apps/desktop/resources/icons/linux/harness-desktop-512.png', 512],
  ['apps/web/public/icons/harness-192.png', 192],
  ['apps/web/public/icons/harness-512.png', 512],
  ['apps/web/public/icons/harness-maskable-512.png', 512],
])

const otherAssets = [
  'apps/desktop/resources/icons/win/harness-desktop.ico',
  'apps/desktop/resources/icons/mac/harness-desktop.icns',
  'apps/desktop/resources/icons/linux/harness-desktop.svg',
  'apps/web/public/favicon.svg',
] as const

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-icons-'))
  temporaryRoots.push(root)
  return root
}

function pngDimensions(contents: Buffer): { readonly width: number; readonly height: number } {
  expect(contents.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  }
}

function icoDimensions(contents: Buffer): readonly number[] {
  expect(contents.readUInt16LE(0)).toBe(0)
  expect(contents.readUInt16LE(2)).toBe(1)
  const count = contents.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const encodedWidth = contents.readUInt8(6 + index * 16)
    return encodedWidth === 0 ? 256 : encodedWidth
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Harness icon authority', () => {
  it('declares the original artwork marks and exact color tokens', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8')
    const tokens = [...new Set([...source.matchAll(/(--[a-z-]+)\s*:/g)].map(match => match[1]))].sort()

    expect(tokens).toEqual([
      '--background',
      '--star',
      '--whale-highlight',
      '--whale-primary',
      '--whale-shadow',
    ])
    expect(source).toContain('id="mark-full"')
    expect(source).toContain('id="mark-compact"')
    expect(source).toContain('id="theme-light"')
    expect(source).toContain('id="theme-dark"')
    expect(source).toContain('Original Harness artwork; no DeepSeek-derived assets.')
  })

  it.each([
    [16, 'mark-compact'],
    [32, 'mark-compact'],
    [64, 'mark-full'],
    [512, 'mark-full'],
  ] as const)('selects the legible mark for a %i px render', async (size, mark) => {
    const source = await readFile(SOURCE_PATH, 'utf8')
    const renderInput = createProductIconRenderInput(source, { size })

    expect(renderInput).toContain(
      `<use href="#${mark}" x="0" y="0" width="1024" height="1024" />`,
    )
  })
})

describe('Harness icon generation', () => {
  it('writes every native and Web asset with the required representations', async () => {
    const root = await makeTemporaryRoot()
    const source = await readFile(SOURCE_PATH)
    await mkdir(join(root, 'assets', 'brand'), { recursive: true })
    await writeFile(join(root, 'assets', 'brand', 'harness-icon.svg'), source)

    await generateProductIconsAtRoot(root, source)

    for (const [path, size] of pngAssets) {
      const contents = await readFile(join(root, path))
      expect(contents.byteLength, path).toBeGreaterThan(0)
      expect(pngDimensions(contents), path).toEqual({ width: size, height: size })
      const stats = await sharp(contents).stats()
      expect(stats.channels.slice(0, 3).every(channel => channel.max > 0), `${path} has visible color`).toBe(true)
      if (path.endsWith('harness-maskable-512.png')) expect(stats.isOpaque).toBe(true)
    }
    for (const path of otherAssets) {
      expect((await readFile(join(root, path))).byteLength, path).toBeGreaterThan(0)
    }

    const ico = await readFile(join(root, 'apps/desktop/resources/icons/win/harness-desktop.ico'))
    expect(icoDimensions(ico)).toEqual(expect.arrayContaining([16, 256]))

    const icns = await readFile(join(root, 'apps/desktop/resources/icons/mac/harness-desktop.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.includes(Buffer.from('icp4'))).toBe(true)
    expect(icns.includes(Buffer.from('ic10'))).toBe(true)

    const linuxSvg = await readFile(join(root, 'apps/desktop/resources/icons/linux/harness-desktop.svg'), 'utf8')
    expect(linuxSvg).toContain('Generated from assets/brand/harness-icon.svg')
    expect(linuxSvg).toContain('href="#mark-full"')
    expect(linuxSvg).not.toMatch(/[ \t]+$/m)

    const favicon = await readFile(join(root, 'apps/web/public/favicon.svg'), 'utf8')
    expect(favicon).toContain('Generated from assets/brand/harness-icon.svg')
    expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*light\)/)
    expect(favicon).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/)
    expect(favicon).toContain('href="#theme-light"')
    expect(favicon).toContain('href="#theme-dark"')
    expect(favicon).not.toMatch(/[ \t]+$/m)
  })

  it('reports missing and stale assets without changing them', async () => {
    const root = await makeTemporaryRoot()
    const source = await readFile(SOURCE_PATH)
    await mkdir(join(root, 'assets', 'brand'), { recursive: true })
    await writeFile(join(root, 'assets', 'brand', 'harness-icon.svg'), source)
    await generateProductIconsAtRoot(root, source)

    const stalePath = 'apps/web/public/icons/harness-512.png'
    const staleFile = join(root, stalePath)
    await writeFile(staleFile, 'stale')
    await rm(join(root, 'apps/web/public/icons/harness-192.png'))

    await expect(collectProductIconViolations(root)).resolves.toEqual([
      'icon asset: missing apps/web/public/icons/harness-192.png; run pnpm run generate:icons',
      `icon asset: stale ${stalePath}; run pnpm run generate:icons`,
    ])
    await expect(readFile(staleFile, 'utf8')).resolves.toBe('stale')
  })
})
