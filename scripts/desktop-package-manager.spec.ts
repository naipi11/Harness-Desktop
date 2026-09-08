import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('pins pnpm with bounded manifest reads for the Windows Desktop dependency collector', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    packageManager: string
  }
  expect(manifest.packageManager.startsWith('pnpm@')).toBe(true)
  // pnpm 11.7 launches unbounded unsaved-dependency reads across the workspace;
  // electron-builder's production list command exhausts Windows file handles.
  expect(manifest.packageManager).toBe('pnpm@11.25.0')
})
