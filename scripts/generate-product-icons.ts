import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Icns, IcnsImage } from '@fiahfy/icns'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_RELATIVE_PATH = 'assets/brand/harness-icon.svg'
const GENERATED_MARKER = 'Generated from assets/brand/harness-icon.svg; do not edit.'
const COMPACT_MAX_SIZE = 32
const WINDOWS_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const
const MAC_REPRESENTATIONS = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
] as const
const LINUX_SIZES = [16, 32, 64, 128, 256, 512] as const

interface ProductIconRenderOptions {
  readonly size: number
  readonly maskable?: boolean
}

interface GenerateProductIconOptions {
  readonly check?: boolean
}

function sourceDefinitions(source: string): string {
  const withoutOpeningTag = source.replace(/^\s*<svg[^>]*>/, '')
  return withoutOpeningTag
    .replace(/\s*<use id="source-preview" href="#mark-full" \/>\s*<\/svg>\s*$/, '')
}

function svgDocument(contents: string): Buffer {
  return Buffer.from(`${contents.trimEnd()}\n`)
}

function resolveDefaultColorTokens(source: string, renderInput: string): string {
  const rootDeclarations = source.match(/:root\s*{([^}]*)}/s)?.[1]
  if (rootDeclarations === undefined) {
    throw new Error('icon source: missing :root color-token declarations')
  }

  let resolved = renderInput
  for (const match of rootDeclarations.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    const token = match[1]
    const color = match[2]
    if (token === undefined || color === undefined) {
      throw new Error('icon source: invalid color-token declaration')
    }
    resolved = resolved.replaceAll(`var(${token})`, color)
  }
  if (resolved.includes('var(--')) {
    throw new Error('icon source: an SVG color token has no literal :root value')
  }
  return resolved
}

/**
 * Build the SVG input rendered for one native or Web icon.
 * @param source - Editable Harness SVG authority.
 * @param options - Pixel size and optional maskable safe-zone treatment.
 * @returns A self-contained SVG document referencing the size-appropriate mark.
 */
export function createProductIconRenderInput(
  source: string,
  options: ProductIconRenderOptions,
): string {
  const mark = options.size <= COMPACT_MAX_SIZE ? 'mark-compact' : 'mark-full'
  const inset = options.maskable ? 102 : 0
  const extent = 1024 - inset * 2
  const maskableBackground = options.maskable
    ? '  <path d="M0 0H1024V1024H0Z" fill="var(--background)" />'
    : ''
  const renderInput = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    `  <!-- ${GENERATED_MARKER} -->`,
    sourceDefinitions(source),
    maskableBackground,
    `  <use href="#${mark}" x="${inset}" y="${inset}" width="${extent}" height="${extent}" />`,
    '</svg>',
    '',
  ].join('\n')
  return resolveDefaultColorTokens(source, renderInput)
}

function createFavicon(source: string): Buffer {
  return svgDocument([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    `  <!-- ${GENERATED_MARKER} -->`,
    '  <style>',
    '    #favicon-light { display: block; }',
    '    #favicon-dark { display: none; }',
    '    @media (prefers-color-scheme: light) {',
    '      #favicon-light { display: block; }',
    '      #favicon-dark { display: none; }',
    '    }',
    '    @media (prefers-color-scheme: dark) {',
    '      #favicon-light { display: none; }',
    '      #favicon-dark { display: block; }',
    '    }',
    '  </style>',
    sourceDefinitions(source),
    '  <use id="favicon-light" href="#theme-light" />',
    '  <use id="favicon-dark" href="#theme-dark" />',
    '</svg>',
  ].join('\n'))
}

async function renderPng(source: string, options: ProductIconRenderOptions): Promise<Buffer> {
  const input = createProductIconRenderInput(source, options)
  return sharp(Buffer.from(input), { density: 144 })
    .resize(options.size, options.size, { fit: 'fill' })
    .toColourspace('srgb')
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toBuffer()
}

async function buildProductIconAssets(sourceBuffer: Buffer): Promise<ReadonlyMap<string, Buffer>> {
  const source = sourceBuffer.toString('utf8')
  const assets = new Map<string, Buffer>()
  const rendered = new Map<number, Buffer>()
  const render = async (size: number): Promise<Buffer> => {
    const existing = rendered.get(size)
    if (existing !== undefined) return existing
    const png = await renderPng(source, { size })
    rendered.set(size, png)
    return png
  }

  for (const size of LINUX_SIZES) {
    assets.set(`apps/desktop/resources/icons/linux/harness-desktop-${size}.png`, await render(size))
  }
  assets.set(
    'apps/desktop/resources/icons/linux/harness-desktop.svg',
    svgDocument(createProductIconRenderInput(source, { size: 512 })),
  )

  assets.set('apps/web/public/icons/harness-192.png', await render(192))
  assets.set('apps/web/public/icons/harness-512.png', await render(512))
  assets.set(
    'apps/web/public/icons/harness-maskable-512.png',
    await renderPng(source, { size: 512, maskable: true }),
  )
  assets.set('apps/web/public/favicon.svg', createFavicon(source))

  assets.set(
    'apps/desktop/resources/icons/win/harness-desktop.ico',
    await pngToIco(await Promise.all(WINDOWS_SIZES.map(render))),
  )

  const icns = new Icns()
  for (const [size, type] of MAC_REPRESENTATIONS) {
    icns.append(IcnsImage.fromPNG(await render(size), type))
  }
  assets.set('apps/desktop/resources/icons/mac/harness-desktop.icns', icns.data)

  return assets
}

/**
 * Generate every product icon below an explicit repository root.
 * @param root - Repository-like destination used by focused generation tests.
 * @param source - Editable SVG authority bytes.
 * @returns A promise that resolves after every derivative is written.
 */
export async function generateProductIconsAtRoot(root: string, source: Buffer): Promise<void> {
  const assets = await buildProductIconAssets(source)
  for (const [path, contents] of assets) {
    const destination = join(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
}

/**
 * Report missing or stale generated product icons below a repository root.
 * @param root - Repository root containing the SVG authority and generated files.
 * @returns Stable diagnostics in generated-path order.
 */
export async function collectProductIconViolations(root: string): Promise<readonly string[]> {
  const source = await readFile(join(root, SOURCE_RELATIVE_PATH))
  const expected = await buildProductIconAssets(source)
  const violations: string[] = []

  for (const [path, expectedContents] of expected) {
    const absolutePath = join(root, path)
    try {
      await access(absolutePath, constants.F_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      violations.push(`icon asset: missing ${path}; run pnpm run generate:icons`)
      continue
    }
    const actualContents = await readFile(absolutePath)
    if (!actualContents.equals(expectedContents)) {
      violations.push(`icon asset: stale ${path}; run pnpm run generate:icons`)
    }
  }

  return violations
}

/**
 * Generate or verify the repository's native and Web product icon derivatives.
 * @param options - Set `check` to report drift without writing files.
 * @returns A promise that resolves when generation or verification finishes.
 */
export async function generateProductIcons(options: GenerateProductIconOptions = {}): Promise<void> {
  if (options.check) {
    const violations = await collectProductIconViolations(REPOSITORY_ROOT)
    if (violations.length > 0) throw new Error(violations.join('\n'))
    return
  }

  const source = await readFile(join(REPOSITORY_ROOT, SOURCE_RELATIVE_PATH))
  await generateProductIconsAtRoot(REPOSITORY_ROOT, source)
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const unknown = arguments_.filter(argument => argument !== '--check')
  if (unknown.length > 0) throw new Error(`generate-product-icons: unknown argument ${unknown[0]}`)
  await generateProductIcons({ check: arguments_.includes('--check') })
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
